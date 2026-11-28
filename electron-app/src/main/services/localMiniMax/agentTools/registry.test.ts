import { describe, expect, it, vi } from 'vitest';

// Мост к реплике и гейт разделов живут в main, а тест — обычный node-процесс:
// окна и IPC тут не нужны, но модули их импортируют.
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { PermissionCode } from '@matricarmz/shared';

import type { IpcContext } from '../../../ipc/ipcContext.js';
import { isWriteGatedChannel, matchPrefixRule } from '../../../ipc/sectionGate.js';
import { AGENT_TOOLS, agentToolMcpTools, findAgentTool, runAgentTool } from './registry.js';

/**
 * Контекст программы для проверки гейта.
 *
 * ВАЖНО: `currentViewer` отдаёт ПУСТОГО оператора — тогда гейт разделов пропускает
 * (не залогинен — вход контролируют сами двери), и проверка достаётся именно до
 * отказа по ПРАВУ и по РЕЖИМУ ПРОСМОТРА. Отказ по разделу без настоящей базы
 * недоступен, поэтому он проверяется правилом «канал инструмента = канал двери».
 */
function ctxWith(perms: Record<string, boolean>, backup = false): IpcContext {
  return {
    currentPermissions: async () => perms,
    currentViewer: async () => ({ login: '', role: '' }),
    currentActor: async () => 'operator',
    mode: () =>
      backup
        ? { mode: 'backup' as const, backupDate: '2026-11-28', backupPath: '/tmp/backup' }
        : { mode: 'live' as const },
    dataDb: () => {
      throw new Error('в тесте базы нет');
    },
  } as unknown as IpcContext;
}

describe('реестр клиентских инструментов агента', () => {
  it('у каждого инструмента есть право и раздел', () => {
    expect(AGENT_TOOLS.length).toBeGreaterThan(0);
    for (const tool of AGENT_TOOLS) {
      expect(tool.requires.length, `${tool.id}: нужен список прав`).toBeGreaterThan(0);
      expect(tool.section, `${tool.id}: нужен раздел`).toBeTruthy();
      expect(tool.level === 'viewer' || tool.level === 'editor', `${tool.id}: уровень`).toBe(true);
      expect(tool.channel, `${tool.id}: нужен канал`).toBeTruthy();
    }
  });

  it('инструмент гейтится тем же гейтом, что и дверь его канала', () => {
    // Раздел и уровень инструмента обязаны совпадать с гейтом канала: иначе
    // действие из канала прошло бы мимо гейта разделов (совет специалистов).
    for (const tool of AGENT_TOOLS) {
      const section = matchPrefixRule(tool.channel);
      expect(section, `${tool.id}: канал ${tool.channel} не гейтится разделом`).toBeTruthy();
      expect(tool.section, `${tool.id}: раздел`).toBe(section);
      const level = isWriteGatedChannel(tool.channel) ? 'editor' : 'viewer';
      expect(tool.level, `${tool.id}: уровень`).toBe(level);
    }
  });

  it('инструмент находится по имени, а список для агента — тот же реестр', () => {
    const tool = findAgentTool('productionProgram.prepareAddByNumbers');
    expect(tool).toBeTruthy();
    expect(tool?.requires).toContain(PermissionCode.ProductionProgramEdit);
    expect(findAgentTool('нет-такого')).toBeNull();

    const mcp = agentToolMcpTools();
    expect(mcp).toHaveLength(AGENT_TOOLS.length);
    expect(mcp.map((t) => t.name)).toContain('productionProgram.prepareAddByNumbers');
  });

  it('без права инструмент не выполняется — отказ текстом гейта', async () => {
    const result = await runAgentTool(ctxWith({}), 'productionProgram.prepareAddByNumbers', {
      numbers: '001',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Текст отказа — гейтовый, а не свой: префикс `permission denied` искать отказ программно.
    expect(result.error).toContain('permission denied');
    expect(result.error).toContain(PermissionCode.ProductionProgramEdit);
  });

  it('в режиме просмотра действие не выполняется — отказ текстом гейта', async () => {
    const result = await runAgentTool(
      ctxWith({ [PermissionCode.ProductionProgramEdit]: true }, true),
      'productionProgram.prepareAddByNumbers',
      { numbers: '001' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('view mode');
  });

  it('неизвестный инструмент — отказ, а не молчание', async () => {
    const result = await runAgentTool(ctxWith({}), 'productionProgram.неСуществует', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('неизвестный инструмент');
  });
});
