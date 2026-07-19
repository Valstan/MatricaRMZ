import { describe, expect, it } from 'vitest';

import { routineRunSelect } from './aiChatRoutineService.js';

// Синтаксический гейт run-select (второй уровень — PG-роль ai_readonly).
// Все кейсы ниже должны падать ДО обращения к пулу — AI_READONLY_URL не нужен.
describe('routineRunSelect syntactic gate', () => {
  it('rejects empty sql', async () => {
    await expect(routineRunSelect({ sql: '' })).rejects.toThrow('sql required');
  });

  it('rejects multi-statement', async () => {
    await expect(routineRunSelect({ sql: 'SELECT 1; DROP TABLE x' })).rejects.toThrow('single statement only');
  });

  it('rejects non-select statements', async () => {
    await expect(routineRunSelect({ sql: 'UPDATE employees SET x = 1' })).rejects.toThrow('only SELECT/WITH');
    await expect(routineRunSelect({ sql: 'DELETE FROM operations' })).rejects.toThrow('only SELECT/WITH');
    await expect(routineRunSelect({ sql: 'CREATE TABLE t(x int)' })).rejects.toThrow('only SELECT/WITH');
  });

  it('accepts SELECT syntactically but fails on missing AI_READONLY_URL', async () => {
    delete process.env.AI_READONLY_URL;
    await expect(routineRunSelect({ sql: 'SELECT 1' })).rejects.toThrow('AI_READONLY_URL');
  });
});
