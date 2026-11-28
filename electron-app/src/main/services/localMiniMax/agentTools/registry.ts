// РЕЕСТР КЛИЕНТСКИХ ИНСТРУМЕНТОВ АГЕНТА — один на всю программу.
//
// ЗАЧЕМ ОБЩИЙ РЕЕСТР. Инструмент — это «право + действие». Если у каждого раздела
// будет свой список, то правила разойдутся: в одном разделе право проверяется, в
// другом нет; и формулировка отказа у каждого своя. Значит — ОДИН реестр на
// программу, и новая кнопка в новом разделе стоит копейки: новая запись в этом
// файле (промт КАРМАНА #176, п. 11).
//
// ГДЕ ЖИВЁТ РЕЕСТР. В main: гейт разделов есть только в main, и в renderer пришлось бы
// завести вторую копию прав.
//
// ЧТО ТАКОЕ ИНСТРУМЕНТ. `{id, titleRu, requires, section, level, handler}` плюс канал,
// которому действие соответствует: обработчик оборачивается ТЕМ ЖЕ гейтом раздела
// (`createSectionIpcGate(ctx).wrap(channel, …)`), каким накрыты IPC-каналы. Иначе
// действие из именованного канала прошло бы мимо гейта разделов.
//
// ПРАВА АГЕНТА. У агента СВОИХ прав нет и быть не должно: право действия = право
// сессии оператора, авторитет — сервер. Раздел — тот же, что у канала действия.
//
// ТЕКСТЫ ОТКАЗА. В этом файле их нет: право отказывает `ipcContext`, раздел —
// `sectionGate`, режим просмотра — `ipcContext.viewModeWriteError`. Своя формулировка
// отказа здесь = вторая копия правила (ADR-0011).

import { agentToolUnknownText } from '@matricarmz/shared';

import type { IpcContext } from '../../../ipc/ipcContext.js';
import { createSectionIpcGate } from '../../../ipc/sectionGate.js';
import { gateAgentTool } from './gate.js';
import { prepareAddByNumbers } from './prepareAddByNumbers.js';
import type { AgentToolArgs, AgentToolDefinition, AgentToolResult } from './types.js';

export type {
  AgentToolArgs,
  AgentToolDefinition,
  AgentToolLevel,
  AgentToolResult,
} from './types.js';

/**
 * РЕЕСТР. Один на программу.
 *
 * Порядок не значит: набор инструментов один на всю программу, а не по разделам.
 */
export const AGENT_TOOLS: readonly AgentToolDefinition[] = [prepareAddByNumbers];

/** Инструмент по имени. null — такого инструмента нет. */
export function findAgentTool(toolId: string): AgentToolDefinition | null {
  const id = String(toolId ?? '').trim();
  if (!id) return null;
  return AGENT_TOOLS.find((tool) => tool.id === id) ?? null;
}

/** Описание инструментов для MCP-сервера (тот же реестр — второй копии нет). */
export function agentToolMcpTools(): Array<{
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return AGENT_TOOLS.map((tool) => ({
    name: tool.id,
    description: tool.descriptionRu,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * Выполнить действие агента.
 *
 * ПОРЯДОК: гейт (право → раздел → режим просмотра) → обработчик под гейтом раздела.
 * Отказ гейта возвращается КАК ЕСТЬ: агент не должен отвечать «сделано», когда
 * действие запрещено (совет специалистов, разрез 2).
 */
export async function runAgentTool(
  ctx: IpcContext,
  toolId: string,
  args: AgentToolArgs,
): Promise<AgentToolResult> {
  const tool = findAgentTool(toolId);
  if (!tool) return { ok: false, error: agentToolUnknownText(toolId) };
  const gate = await gateAgentTool(ctx, tool);
  if (!gate.ok) return gate;
  try {
    // Тот же гейт раздела, что и у IPC-канала, — под именем канала действия.
    const wrapped = createSectionIpcGate(ctx).wrap(
      tool.channel,
      (_event: unknown, payload: AgentToolArgs) => tool.handler(ctx, payload ?? {}),
    );
    return await wrapped({}, args ?? {});
  } catch (e) {
    // Отказ гейта приходит исключением (как в IPC) — текст тот же, гейтовый.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
