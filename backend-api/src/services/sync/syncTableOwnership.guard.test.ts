import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SYNC_TABLE_OWNERSHIP, SyncTableName } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Сторож бэкенд-половины механизма «кто владеет строкой» (brain #015, 2026-09-21).
// Карта владения в shared обещает, ЧТО проверяется; этот тест сверяет с ИСХОДНИКОМ
// applyPushBatch, что обещанная проверка там есть. Проверка по тексту, а не по импорту:
// applyPushBatch тянет половину приложения, а цена вопроса — один regexp по файлу
// (образец — usersContractDrift.guard.test.ts).

const SOURCE = readFileSync(fileURLToPath(new URL('./applyPushBatch.ts', import.meta.url)), 'utf8');

const KEY_BY_TABLE = new Map<string, string>(Object.entries(SyncTableName).map(([k, v]) => [v, k]));

/** Текст обработчика таблицы: от комментария-заголовка `// <Key>` до следующего `// <OtherKey>`. */
function handlerBlock(table: SyncTableName): string | null {
  const key = KEY_BY_TABLE.get(table)!;
  const re = new RegExp(`^\\s*// ${key}\\b.*$`, 'm');
  const m = re.exec(SOURCE);
  if (!m) return null;
  const start = m.index;
  const rest = SOURCE.slice(start + m[0].length);
  // Граница — заголовок СЛЕДУЮЩЕЙ таблицы контракта, а не любой комментарий с заглавной.
  const others = [...KEY_BY_TABLE.values()].filter((k) => k !== key).join('|');
  const next = new RegExp(`^\\s*// (${others})\\b`, 'm').exec(rest);
  return next ? SOURCE.slice(start, start + m[0].length + next.index) : SOURCE.slice(start);
}

describe('SYNC_TABLE_OWNERSHIP ↔ applyPushBatch', () => {
  it('у каждой row-таблицы объявленная проверка владельца существует в обработчике', () => {
    for (const t of Object.values(SyncTableName)) {
      const own = SYNC_TABLE_OWNERSHIP[t];
      if (own.owner !== 'row') continue;
      expect(SOURCE.includes(own.guard), `${t}: в applyPushBatch нет «${own.guard}» — карта обещает проверку, которой нет`).toBe(true);
    }
  });

  it('user_presence (owner: session) — клиентский payload не читается, heartbeat штампует сервер', () => {
    expect(SOURCE).not.toMatch(/grouped\.get\(SyncTableName\.UserPresence\)/);
    expect(SOURCE).toMatch(/user_id: actorId/);
  });

  it('audit_log (owner: append_only) — существующая строка не перезаписывается, deleted_at с клиента не принимается', () => {
    const block = handlerBlock(SyncTableName.AuditLog);
    expect(block, 'обработчик AuditLog не найден').not.toBeNull();
    expect(block!).toMatch(/onConflictDoNothing/);
    expect(block!).not.toMatch(/onConflictDoUpdate/);
    expect(block!).not.toMatch(/deletedAt: r\.deleted_at/);
    expect(block!).toMatch(/deletedAt: null/);
  });

  it('server-таблицы, которые клиент не пишет никогда, не имеют клиентского обработчика (регистры склада)', () => {
    // Users / UserSectionAccess / WarehouseLocations обработчики ИМЕЮТ — их пишет сервер
    // тем же путём (публикаторы зеркала); регистры склада сервер ведёт напрямую, поэтому
    // обработчика быть не должно: появление его без снятия 'server' — та самая дыра.
    for (const t of [SyncTableName.ErpRegStockBalance, SyncTableName.ErpRegStockMovements]) {
      expect(SYNC_TABLE_OWNERSHIP[t].owner, t).toBe('server');
      expect(SOURCE, t).not.toMatch(new RegExp(`grouped\\.get\\(SyncTableName\\.${KEY_BY_TABLE.get(t)}\\)`));
    }
  });
});
