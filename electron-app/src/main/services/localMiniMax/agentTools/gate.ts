// Гейт действия агента: право → раздел → режим просмотра.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Действие агента приходит по именованному каналу (не через
// `ipcMain.handle`), поэтому гейт разделов накрывает его не сам. Значит, действие
// обязано пройти гейт ДО того, как что-то сделает.
//
// СВОИХ ТЕКСТОВ ОТКАЗА ЗДЕСЬ НЕТ И БЫТЬ НЕ ДОЛЖНО. Тексты отказа принадлежат гейтам
// программы: право — `ipcContext.requirePermOrResult`, раздел — `sectionGate`,
// режим просмотра — `ipcContext.viewModeWriteError`. Своя формулировка отказа в
// действии агента = вторая копия правила: оператор увидел бы «нет доступа» от
// программы и «не хватает прав» от агента об одном и том же, и разошлись бы они
// тихо (ADR-0011).
//
// Порядок проверок — как в дверях программы: сначала право, потом раздел, потом
// «режим просмотра» (в нём запись запрещена).

import { checkSectionAccess } from '../../../ipc/sectionGate.js';
import { isViewMode, requirePermOrResult, viewModeWriteError, type IpcContext } from '../../../ipc/ipcContext.js';

import type { AgentToolDefinition } from './registry.js';

/** Ответ гейта: пропустили или отказали (текст отказа — гейта программы). */
export type AgentToolGateResult = { ok: true } | { ok: false; error: string };

/**
 * Пропустить действие агента через гейт программы.
 *
 * Права и раздел берутся У СЕССИИ ОПЕРАТОРА: у агента своих прав нет и быть не
 * должно (совет специалистов, разрез 2) — иначе появился бы второй авторитет.
 */
export async function gateAgentTool(
  ctx: IpcContext,
  tool: AgentToolDefinition,
): Promise<AgentToolGateResult> {
  // 1. Право — тем же хелпером, что и двери IPC.
  for (const perm of tool.requires) {
    const gate = await requirePermOrResult(ctx, perm);
    if (!gate.ok) return gate;
  }
  // 2. Раздел — тем же гейтом разделов (он же строит текст отказа).
  const access = await checkSectionAccess(ctx, tool.section, tool.level);
  if (!access.ok) return access;
  // 3. Режим просмотра — тем же ответом, что и двери записи.
  if (isViewMode(ctx)) return viewModeWriteError();
  return { ok: true };
}
