import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// E1 программы осень-2026 (17.09): раздел «Детали» номенклатуры тормозил и показывал
// «Справочники склада: unknown». Три вещи, которые эта правка закрепила и которые
// рвутся молча при следующем рефакторинге: список рисуется виртуально в одном окне
// прокрутки; строки и счётчики групп берутся из реплики, REST — только при пустой;
// запись номенклатуры дожидается догоняющего синка, иначе список перечитает реплику
// без только что сохранённой строки.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./NomenclaturePage.tsx');
const SERVICE = src('../../../../main/services/erpService.ts');
const IPC = src('../../../../main/ipc/register/erp.ts');
const SYNC = src('../../../../main/services/syncService.ts');
const ELECTRON_PARITY = src('../../../../main/database/migrate.ts');
const ANDROID_PARITY = src('../../../../../../android-app/src/db/migrate.ts');

describe('номенклатура — список без тормозов (E1)', () => {
  it('страница рисует один VirtualTable с памятью прокрутки, а не таблицу на каждую группу', () => {
    expect(PAGE).toContain('<VirtualTable');
    expect(PAGE).toContain("usePersistedScrollTop('list:nomenclature')");
    expect(PAGE).toContain('rowNumberOf=');
    // Прежняя разметка: `<table className="list-table">` внутри `groupCounts.map(...)`.
    expect(PAGE).not.toContain('pageRowsForGroup');
    expect(PAGE).not.toMatch(/groupCounts\.map\(\(group\) => \{[\s\S]*<table className="list-table">/);
  });

  it('список и счётчики групп идут из реплики, REST — только при пустой', () => {
    const list = SERVICE.slice(SERVICE.indexOf('export async function warehouseNomenclatureList('), SERVICE.indexOf('export async function globalSearchQuery('));
    expect(list).toContain('if (!args?.id && (await localWarehouseNomenclatureHasRows(db)))');
    expect(list.indexOf('localWarehouseNomenclatureHasRows')).toBeLessThan(list.indexOf('warehouseAuthed('));
    const counts = SERVICE.slice(SERVICE.indexOf('export async function warehouseNomenclatureGroupCounts('), SERVICE.indexOf('export async function warehouseLookupsGet('));
    expect(counts.indexOf('localWarehouseNomenclatureHasRows')).toBeLessThan(counts.indexOf('warehouseAuthed('));
  });

  it('строка реплики оформляется как серверная, счётчик группы знает её имя', () => {
    expect(SERVICE).toContain('decorateNomenclatureReplicaRow(row as Record<string, unknown>, refs)');
    expect(SERVICE).not.toContain("groupName: 'Без группы',");
  });

  it('pull переносит в реплику полную строку номенклатуры: источник, родитель, артикул, штамп', () => {
    const push = SYNC.slice(SYNC.indexOf('warehouseNomenclatureRows.push({'), SYNC.indexOf('case SyncTableName.ErpEngineAssemblyBom:'));
    const set = SYNC.slice(SYNC.indexOf('const nomSet: Record<string, unknown> = {'), SYNC.indexOf('await upsertPulledRowsInChunks(db, erpNomenclature'));
    for (const col of ['directory_kind', 'directory_ref_id', 'parent_nomenclature_id', 'sku', 'category', 'default_brand_id', 'is_serial_tracked', 'last_server_seq']) {
      expect(push, `push ${col}`).toContain(col);
      expect(set, `set ${col}`).toContain(`excluded.${col}`);
    }
  });

  it('HTTP 2xx без разобранного тела больше не показывается как «unknown»', () => {
    expect(SERVICE).not.toContain("?? 'unknown'");
    expect(SERVICE).toContain('Сервер не ответил (HTTP ${r.status}');
  });

  it('запись номенклатуры дожидается догоняющего синка перед ответом', () => {
    for (const channel of ['warehouse:nomenclature:upsert', 'warehouse:nomenclature:delete', 'warehouse:directoryPart:create', 'warehouse:partsDedupe:merge']) {
      const handler = IPC.slice(IPC.indexOf(`'${channel}'`));
      const body = handler.slice(0, handler.indexOf('ipcMain.handle(', 1));
      expect(body, channel).toContain('afterNomenclatureWrite(');
    }
    expect(IPC).toContain('if (result.ok) await ctx.mgr.runOnce()');
  });

  it('индекс родителя ставится и парити-путём у обоих клиентов (PENDING :769)', () => {
    const idx = 'CREATE INDEX IF NOT EXISTS erp_nomenclature_parent_idx ON erp_nomenclature(parent_nomenclature_id);';
    expect(ELECTRON_PARITY).toContain(idx);
    expect(ANDROID_PARITY).toContain(idx);
  });
});
