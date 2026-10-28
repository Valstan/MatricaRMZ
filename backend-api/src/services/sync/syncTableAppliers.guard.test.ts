import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SyncTableName } from '@matricarmz/shared';
import { describe, expect, it } from 'vitest';

// Сторож «у таблицы контракта есть обработчик применения» (вскрыт смоуком 2026-10-27).
//
// `writeSyncChanges` — канонический путь записи: строка подписывается в журнал и применяется
// к PG в `applyPushBatch`. Если таблицу завели в контракте, в картах pull и в реестре, но не
// завели обработчик, запись **не падает**: она ложится в журнал и до таблицы не доезжает.
// Именно так реестр номеров РМЗ (#1494) «выдавал» номер каждые 60 секунд, сжигая значения
// `engine_rmz_seq`, при пустой таблице — а тесты сервиса были зелёными, потому что мокали
// `writeSyncChanges` (brain #166: шов живёт между задачами и по-задачному ревью не виден).
//
// Проверка по тексту, а не импортом `applyPushBatch`: он тянет половину приложения (тот же
// приём, что в mirrorTables.guard.test.ts).

function readSource(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

/**
 * Таблицы, у которых обработчика в `applyPushBatch` нет НАМЕРЕННО: их строки кладут свои
 * REST-двери прямо в PG (`recordSyncChanges` пишет журнал уже по записанной строке), а
 * клиентского пуша по ним не существует — поэтому и применять нечего. Список заморожен:
 * новая таблица обязана прийти либо с обработчиком, либо с записью здесь и причиной.
 */
const NO_PUSH_APPLIER: Record<string, string> = {
  ErpNomenclature: 'номенклатуру ведёт REST-дверь склада, клиент её только читает',
  ErpEngineAssemblyBom: 'BOM ведёт REST-дверь, клиент его только читает',
  ErpEngineAssemblyBomLines: 'строки BOM ведёт REST-дверь, клиент их только читает',
  ErpEngineAssemblyBomBrandLinks: 'связи BOM↔марки ведёт REST-дверь, клиент их только читает',
  ErpEngineInstances: 'экземпляры двигателей ведёт REST-дверь склада, клиент их только читает',
  ErpRegStockBalance: 'регистр остатков считает сервер по проведённым документам',
  ErpRegStockMovements: 'регистр движений считает сервер по проведённым документам',
};

describe('applyPushBatch: таблица контракта без обработчика — видимая дыра, а не тишина', () => {
  const applySource = readSource('./applyPushBatch.ts');
  const keys = Object.keys(SyncTableName).filter((k) => Number.isNaN(Number(k)));
  const applied = keys.filter((k) => applySource.includes(`SyncTableName.${k}`));
  const missing = keys.filter((k) => !applySource.includes(`SyncTableName.${k}`));

  it('каждая таблица контракта либо применяется, либо названа в списке «без пуша»', () => {
    const unexplained = missing.filter((k) => !(k in NO_PUSH_APPLIER));
    expect(
      unexplained,
      'таблица заведена в контракте, но её строки некуда применить: добавь обработчик в applyPushBatch.ts ' +
        'или (если клиент её не пушит) строку с причиной в NO_PUSH_APPLIER',
    ).toEqual([]);
  });

  it('список «без пуша» не протух: каждая запись — живая таблица и без обработчика', () => {
    // Запись, у которой появился обработчик, обязана исчезнуть из списка: иначе через
    // полгода он будет врать, а следующий агент поверит ему вместо кода.
    for (const key of Object.keys(NO_PUSH_APPLIER)) {
      expect(keys, `SyncTableName.${key} больше не существует`).toContain(key);
      expect(applied, `у ${key} появился обработчик — убери строку из NO_PUSH_APPLIER`).not.toContain(key);
    }
  });

  it('реестр номеров РМЗ применяется через общую дверь, а не пишущей мимо', () => {
    // Шов, на котором обожглись 27.10.2026: номер выдаётся, а строка не доезжает.
    expect(applied).toContain('ErpEngineNumbers');
  });
});
