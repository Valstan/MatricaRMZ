import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Промты КАРМАНА #44 + #45: из списка двигателей пачка выделенных строк
// добавляется в производственную программу.
//
// Скрепы ниже держат три вещи, которые легко сломать молча:
//  1. пункт меню есть ТОЛЬКО для пачки и ТОЛЬКО при праве `production_program.edit`;
//  2. строки плана перед добавлением читаются С СЕРВЕРА — реплика отстаёт на
//     минуту, а замена набора на сервере полная: набор по реплике снёс бы
//     строку, добавленную другим оператором;
//  3. запись идёт единственной дверью `saveRows`, а отказ по движку виден
//     оператору, а не теряется молча.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./EnginesPage.tsx');
const DIALOG = src('../components/ProductionProgramAddEnginesDialog.tsx');
const PRELOAD = src('../../../../preload/index.ts');
const IPC = src('../../../../main/ipc/register/productionProgram.ts');
const TYPES = src('../../../../../../shared/src/ipc/types.ts');

describe('добавление двигателей в производственную программу из списка', () => {
  it('пункт меню есть в bulk-ветке и только при праве вести программу', () => {
    const bulk = PAGE.slice(PAGE.indexOf('if (menu.bulk) {'), PAGE.indexOf('if (menuRows.length !== 1)'));
    expect(bulk, 'пункт добавления в план живёт в ветке пачки').toContain(
      'Добавить в производственную программу',
    );
    expect(bulk, 'пункт показывается только при праве production_program.edit').toContain(
      'if (props.canEditProductionProgram)',
    );
    expect(bulk, 'для одной строки пункт не предлагается').toContain('return items;');
  });

  it('выделение для модалки снимается в момент клика — после закрытия меню его нет', () => {
    expect(PAGE).toContain('setProgramAddEngines(menuRows);');
    expect(PAGE).toContain('engines={programAddEngines}');
  });

  it('строки плана читаются с сервера, а не из реплики', () => {
    expect(DIALOG, 'реплика отстаёт на минуту, а набор заменяется целиком').toContain(
      'window.matrica.productionProgram.get(programId)',
    );
    expect(DIALOG, 'перед записью строки берутся у сервера').toContain('const existing = fresh.lines');
    // Реплика в этом месте читаться не должна.
    expect(DIALOG.slice(DIALOG.indexOf('const fresh ='), DIALOG.indexOf('const saved ='))).not.toContain(
      'productionProgram.list()',
    );
  });

  it('запись идёт единственной дверью saveRows', () => {
    expect(DIALOG).toContain('window.matrica.productionProgram.saveRows({ id: programId, rows: nextRows })');
    expect(DIALOG).not.toContain('productionProgram.update({ id: programId, rows');
  });

  it('ipc и preload умеют читать план со строками', () => {
    expect(IPC).toContain("'productionProgram:get'");
    expect(IPC).toContain('/production-program/${encodeURIComponent(String(id ?? \'\'))}');
    expect(PRELOAD).toContain("get: async (id: string) => ipcRenderer.invoke('productionProgram:get', id)");
    expect(TYPES).toContain('get: (id: string) => Promise<');
  });

  it('отказ по движку виден оператору: причина у каждой строки списка', () => {
    expect(DIALOG, 'подсказка домена определяет, можно ли взять движок').toContain(
      'productionProgramEngineHint(engine)',
    );
    expect(DIALOG, 'причина отказа показывается рядом с двигателем').toContain('{r.reason}');
    expect(DIALOG, 'двигатель без договора в план не берётся').toContain(
      'Нет договора — строка плана без него не имеет группы',
    );
  });

  it('двигатель, уже лежащий в плане, повторно не добавляется', () => {
    expect(DIALOG).toContain("skipped.push({ label: row.label, reason: 'Уже есть в плане' })");
  });

  it('новые строки получают постоянный id, а номера пересчитываются по позиции', () => {
    expect(DIALOG).toContain('id: crypto.randomUUID()');
    expect(DIALOG).toContain('.map((r, i) => ({ ...r, orderNo: i + 1 }))');
  });

  it('страница программы собирает строку тем же доменным правилом', () => {
    const page = src('../pages/ProductionProgramPage.tsx');
    expect(page, 'два места добавления — одно правило').toContain('productionProgramRowFromEngine({');
  });
});
