// Слой преобразования ответа агента в структуру `tool_use`.
//
// Это главный кусок контура: контракт ИИваныча построен на строгом
// `tool_use`-JSON (см. `llmProvider.ts`), а MiniMax Code отдаёт свободный текст.
// Без явного преобразования агентный цикл и 4 мета-инструмента
// (`escalate_to_admin`, `attach_table`, `save_learning_note`, `enable_full_tools`)
// не работают.
//
// ⚠️ Формат ответа хрупкий (ADR-0017): у MiniMax нет рабочей нативной схемы, и
// рассогласование «задание ↔ системный промпт» молча даёт ответ не той формы.
// Поэтому разбор снисходительный к обёрткам (код-блок, текст вокруг JSON), но
// строгий к смыслу: неизвестный инструмент — это не «инструмент», а текст.

import { randomBytes } from 'node:crypto';

export type ShapedTextBlock = { type: 'text'; text: string };
export type ShapedToolUseBlock = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type ShapedBlock = ShapedTextBlock | ShapedToolUseBlock;

export type ShapedAnswer = {
  blocks: ShapedBlock[];
  stopReason: 'tool_use' | 'end_turn';
  /** Что не удалось разобрать — уходит в журнал, чтобы поломка формы была видна. */
  warnings: string[];
};

export type AllowedTool = { name: string };

/** Достать JSON-объект из ответа агента: голый JSON, код-блок или JSON в тексте. */
export function extractJsonObject(raw: string): unknown {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // не JSON в блоке — идём дальше
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    // не голый JSON — ищем границы объекта
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function newToolUseId(): string {
  return `toolu_${randomBytes(12).toString('hex')}`;
}

/** Вход инструмента — объект. Не-объект приводим к виду, который рантайм примет. */
function coerceInput(raw: unknown): { input: Record<string, unknown>; coerced: boolean } {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { input: raw as Record<string, unknown>, coerced: false };
  }
  if (typeof raw === 'string') return { input: { query: raw }, coerced: true };
  if (typeof raw === 'number' || typeof raw === 'boolean') return { input: { value: raw }, coerced: true };
  return { input: {}, coerced: raw != null };
}

function pickToolCalls(payload: Record<string, unknown>): { name: unknown; input: unknown }[] {
  const single = payload.tool_use ?? payload.toolUse;
  if (Array.isArray(single)) return single as { name: unknown; input: unknown }[];
  if (single && typeof single === 'object') return [single as { name: unknown; input: unknown }];
  const many = payload.tool_calls ?? payload.toolCalls;
  if (Array.isArray(many)) return many as { name: unknown; input: unknown }[];
  return [];
}

/**
 * Превратить ответ агента в блоки Anthropic-совместимого сообщения.
 *
 * Инструменты вне запрошенного списка отбрасываются: вызов незнакомого инструмента
 * бэкенд выполнить не сможет, и такой ответ ушёл бы в ошибку вместо нормального.
 */
export function shapeAgentAnswer(raw: string, tools: AllowedTool[]): ShapedAnswer {
  const warnings: string[] = [];
  const allowed = new Set(tools.map((t) => t.name));
  const parsed = extractJsonObject(raw);

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const text = String(raw ?? '').trim();
    if (!text) {
      return { blocks: [], stopReason: 'end_turn', warnings: ['пустой ответ агента'] };
    }
    // Форма не разобралась — это видно в журнале: иначе молчаливый «текст вместо
    // tool_use» выглядел бы как обычный ответ, а на деле сломал бы агентный цикл.
    warnings.push('ответ агента не разобран — отдан как текст');
    return { blocks: [{ type: 'text', text }], stopReason: 'end_turn', warnings };
  }

  const payload = parsed as Record<string, unknown>;
  const blocks: ShapedBlock[] = [];
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text) blocks.push({ type: 'text', text });

  for (const call of pickToolCalls(payload)) {
    const name = typeof call?.name === 'string' ? call.name.trim() : '';
    if (!name) {
      warnings.push('вызов инструмента без имени');
      continue;
    }
    if (!allowed.has(name)) {
      warnings.push(`инструмент «${name}» не запрошен — вызов отброшен`);
      continue;
    }
    const { input, coerced } = coerceInput(call?.input);
    if (coerced) warnings.push(`вход инструмента «${name}» приведён к объекту`);
    blocks.push({ type: 'tool_use', id: newToolUseId(), name, input });
  }

  if (blocks.length === 0) {
    const fallback = String(raw ?? '').trim();
    if (!fallback) {
      return { blocks: [], stopReason: 'end_turn', warnings: [...warnings, 'пустой ответ агента'] };
    }
    warnings.push('ответ агента не разобран — отдан как текст');
    return { blocks: [{ type: 'text', text: fallback }], stopReason: 'end_turn', warnings };
  }

  return {
    blocks,
    stopReason: blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    warnings,
  };
}
