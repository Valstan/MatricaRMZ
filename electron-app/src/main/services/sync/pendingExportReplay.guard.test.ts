import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Сторож: реплей неотправленных строк из файла экспорта НЕ ДОЛЖЕН зависеть от
// успеха pull.
//
// Инцидент 24.11.2026 (оператор: «внесла много данных, они не уходят на сервер»):
// после пересборки локальной БД неотправленные строки остаются только в файле
// экспорта. Реплей стоял в конце успешного пути — ПОСЛЕ pull. Любой сбой pull
// (у парка это серия падений на реплике карточек СИЗ) выпрыгивал из прогона раньше
// реплея: файл лежал, база пустая, данные оператора не возвращались никогда —
// повторялось на каждом цикле.
//
// Проверка по исходнику, а не по поведению: прогон синка целиком тянет за собой сеть,
// сессию и схему — такой тест был бы хрупким и медленным. Сторож ловит именно
// РЕГРЕССИЮ: если реплей снова уберут с пути ошибки — тест станет красным.
const here = dirname(fileURLToPath(import.meta.url));
const SYNC_SERVICE = join(here, '../syncService.ts');

describe('реплей выгрузки не зависит от успеха pull', () => {
  const src = readFileSync(SYNC_SERVICE, 'utf8');

  it('путь ошибки прогона вызывает реплей выгрузки', () => {
    const errorPathIdx = src.indexOf('sync.run.error id=');
    expect(errorPathIdx).toBeGreaterThan(-1);
    const finallyIdx = src.indexOf('finally {', errorPathIdx);
    expect(finallyIdx).toBeGreaterThan(-1);
    const finallyBlock = src.slice(finallyIdx, finallyIdx + 2000);
    expect(finallyBlock).toContain('replayPendingExports');
  });

  it('после пересборки БД администратору уходит предупреждение о файле экспорта', () => {
    const rebuildIdx = src.indexOf("compatibility.action === 'rebuild'");
    expect(rebuildIdx).toBeGreaterThan(-1);
    const rebuildBranch = src.slice(rebuildIdx, rebuildIdx + 2000);
    expect(rebuildBranch).toContain('reportUnsentRowsMovedToExport');
    // Предупреждение не должно уносить значения строк (ПДн) — только счётчики и имя файла.
    expect(src).toContain('unsent row(s) now live only in the export file');
  });
});
