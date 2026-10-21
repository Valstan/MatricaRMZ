import type { AnswerTable } from './answerWorkbook.js';
import { appendLearningNote } from './aiChatLearningNotes.js';
import type { LlmToolDef, LlmToolUse } from './llmProvider.js';
import type { ToolResult } from './llmTools.js';

/**
 * Инструменты Ииваныча, которые ходят не в базу, а в саму программу: эскалация
 * администратору, вложение таблицы, заметка самообучения.
 *
 * Живут отдельно от aiChatAnswerService, потому что их отдают ОБА пути ответа:
 * DeepSeek (обычный tools-контур) и серверный движок (через MCP-мост). Если бы
 * движок их не видел, «передать администратору» превратилось бы у него в
 * выдуманный ответ — модель просто не знала бы, что такой инструмент есть.
 */

export const ESCALATE_TOOL: LlmToolDef = {
  name: 'escalate_to_admin',
  description:
    'Передать вопрос администратору, когда ответить нельзя: не хватает прав или данных в базе, ' +
    'вопрос вне программы, требуется управленческое решение. Вызывай вместо выдуманного ответа.',
  input_schema: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Чего не хватает для ответа — одной-двумя фразами.' },
    },
    required: ['reason'],
  },
};

export const ATTACH_TABLE_TOOL: LlmToolDef = {
  name: 'attach_table',
  description:
    'Приложить к ответу файл Excel (.xlsx) с таблицей. Вызывай, когда пользователь просит ответ файлом ' +
    'или таблица длиннее ~15 строк. Один вызов — один лист. После вызова всё равно дай короткий текстовый вывод.',
  input_schema: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: 'Имя файла без расширения, по-русски, коротко.' },
      columns: { type: 'array', items: { type: 'string' }, description: 'Заголовки колонок.' },
      rows: {
        type: 'array',
        description: 'Строки таблицы: массив массивов значений в порядке колонок.',
        items: { type: 'array', items: { type: 'string' } },
      },
    },
    required: ['filename', 'columns', 'rows'],
  },
};

export const SAVE_LEARNING_NOTE_TOOL: LlmToolDef = {
  name: 'save_learning_note',
  description:
    'Сохранить короткую заметку самообучения: как понимать пользователей в будущем. ' +
    'Примеры: «ОВК = заказчик ООО "ОВК" (тип customer)», «рекламации ищи через get_reclamations». ' +
    'Вызывай после успешного уточнения или когда обнаружил неочевидное соответствие. Одна фраза, без воды.',
  input_schema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'Одна короткая фраза-правило.' },
    },
    required: ['note'],
  },
};

export const IIVANYCH_TOOLS: ReadonlyArray<LlmToolDef> = [
  ESCALATE_TOOL,
  ATTACH_TABLE_TOOL,
  SAVE_LEARNING_NOTE_TOOL,
];

/**
 * Побочные результаты ответа, которые собираются по ходу вызова инструментов:
 * причина эскалации и таблицы, приложенные к ответу. Один объект на вопрос —
 * его видят и tools-контур DeepSeek, и MCP-мост движка.
 */
export type IivanychAnswerSide = {
  escalationReason: string | null;
  tables: AnswerTable[];
};

export function parseAttachTable(input: Record<string, unknown>): AnswerTable | null {
  const columns = Array.isArray(input.columns) ? input.columns.map((c) => String(c ?? '')) : [];
  const rawRows = Array.isArray(input.rows) ? input.rows : [];
  if (columns.length === 0 || rawRows.length === 0) return null;
  const rows = rawRows
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) => r.map((v) => (v == null ? '' : String(v))));
  if (rows.length === 0) return null;
  const filename = String(input.filename ?? 'Таблица').trim() || 'Таблица';
  return { filename, columns, rows };
}

/** null — инструмент не наш, вызывающий отдаёт его llmTools.executeTool. */
export async function runIivanychTool(
  toolUse: LlmToolUse,
  side: IivanychAnswerSide,
): Promise<ToolResult | null> {
  if (toolUse.name === ESCALATE_TOOL.name) {
    side.escalationReason = String(toolUse.input?.reason ?? '').trim() || 'причина не указана';
    return { content: 'Вопрос передан администратору. Заверши ответ короткой фразой об этом.' };
  }
  if (toolUse.name === SAVE_LEARNING_NOTE_TOOL.name) {
    const res = await appendLearningNote(String(toolUse.input?.note ?? ''));
    return res.ok
      ? { content: 'Заметка сохранена.' }
      : { content: `Заметка не сохранена: ${res.error}`, isError: true };
  }
  if (toolUse.name === ATTACH_TABLE_TOOL.name) {
    const table = parseAttachTable(toolUse.input ?? {});
    if (!table) return { content: 'Таблица пустая — заполни columns и rows.', isError: true };
    side.tables.push(table);
    return {
      content: `Файл «${table.filename}.xlsx» приложен к ответу (${table.rows.length} строк).`,
    };
  }
  return null;
}
