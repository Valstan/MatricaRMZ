import { describe, expect, it, vi } from 'vitest';

import { SyncTableName, type EngineInventoryLineRow } from '@matricarmz/shared';

vi.mock('../database/db.js', () => ({ db: {}, pool: {} }));
vi.mock('./sync/syncWriteService.js', () => ({ writeSyncChanges: vi.fn() }));

import { engineInventoryLineId, pickSheetDedupeSurvivors, planEngineInventoryLines } from './engineInventoryLinesService.js';

const OP = '11111111-1111-4111-8111-111111111111';
const ENG = '22222222-2222-4222-8222-222222222222';

function sheet(rows: Array<Record<string, unknown>>, over: Partial<{ deleted_at: number | null; operation_type: string; meta_json: string | null }> = {}) {
  return {
    id: OP,
    engine_entity_id: ENG,
    operation_type: 'engine_inventory',
    meta_json: JSON.stringify({ kind: 'repair_checklist', answers: { engine_inventory_items: { kind: 'table', rows } } }),
    deleted_at: null,
    ...over,
  };
}

describe('engineInventoryLineId — детерминированный v5', () => {
  it('одинаковые (лист, ключ) → один id; разные → разные; формат uuid v5', () => {
    const a = engineInventoryLineId(OP, 'id:p1');
    expect(a).toBe(engineInventoryLineId(OP, 'id:p1'));
    expect(a).not.toBe(engineInventoryLineId(OP, 'id:p2'));
    expect(a).not.toBe(engineInventoryLineId(ENG, 'id:p1'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('planEngineInventoryLines', () => {
  it('пустая таблица — все строки листа вставляются как upsert с детерминированными id', () => {
    const plan = planEngineInventoryLines(sheet([{ part_name: 'A', __part_id: 'p1' }, { part_name: 'B' }]), [], 500);
    expect(plan).toMatchObject({ insert: 2, update: 0, tombstone: 0, unchanged: 0, skipped: false });
    expect(plan.inputs.map((i) => i.type)).toEqual(['upsert', 'upsert']);
    expect(plan.inputs[0]!.table).toBe(SyncTableName.ErpEngineInventoryLines);
    expect(plan.inputs[0]!.row_id).toBe(engineInventoryLineId(OP, 'id:p1'));
    expect(plan.inputs[0]!.row).toMatchObject({ operation_id: OP, engine_entity_id: ENG, sort_order: 0, part_id: 'p1', sync_status: 'synced' });
  });

  it('повторный вывод того же листа — ничего не пишет', () => {
    const first = planEngineInventoryLines(sheet([{ part_name: 'A' }]), [], 500);
    const existing = first.inputs.map((i) => i.row as unknown as EngineInventoryLineRow);
    const second = planEngineInventoryLines(sheet([{ part_name: 'A' }]), existing, 600);
    expect(second.inputs).toEqual([]);
    expect(second.unchanged).toBe(1);
  });

  it('удалённый лист гасит все свои живые строки', () => {
    const first = planEngineInventoryLines(sheet([{ part_name: 'A' }, { part_name: 'B' }]), [], 500);
    const existing = first.inputs.map((i) => i.row as unknown as EngineInventoryLineRow);
    const plan = planEngineInventoryLines(sheet([], { deleted_at: 700 }), existing, 700);
    expect(plan.tombstone).toBe(2);
    expect(plan.inputs.every((i) => i.type === 'delete' && (i.row as any).deleted_at === 700)).toBe(true);
  });

  it('лист без секции строк или чужой тип — skipped, строки не трогаются', () => {
    const first = planEngineInventoryLines(sheet([{ part_name: 'A' }]), [], 500);
    const existing = first.inputs.map((i) => i.row as unknown as EngineInventoryLineRow);
    expect(planEngineInventoryLines(sheet([], { meta_json: '{oops' }), existing, 600)).toMatchObject({ skipped: true, inputs: [] });
    expect(planEngineInventoryLines(sheet([], { meta_json: JSON.stringify({ kind: 'repair_checklist', answers: {} }) }), existing, 600)).toMatchObject({ skipped: true });
    expect(planEngineInventoryLines(sheet([], { operation_type: 'work_order' }), existing, 600)).toMatchObject({ skipped: true });
  });

  it('пустой JSON без маркера при живых строках НЕ гасит — слепой клиент, ждём прямого push (E3-сторож)', () => {
    const first = planEngineInventoryLines(sheet([{ part_name: 'A' }]), [], 500);
    const existing = first.inputs.map((i) => i.row as unknown as EngineInventoryLineRow);
    expect(planEngineInventoryLines(sheet([]), existing, 600)).toMatchObject({ tombstone: 0, inputs: [], skippedEmptyGuard: true });
  });

  it('пустой JSON без живых строк — выводить нечего, тоже пропуск сторожа', () => {
    expect(planEngineInventoryLines(sheet([]), [], 600)).toMatchObject({ tombstone: 0, inputs: [] });
  });

  it('помеченный лист с пустым rows пропускается — строки едут только таблицей', () => {
    const first = planEngineInventoryLines(sheet([{ part_name: 'A' }]), [], 500);
    const existing = first.inputs.map((i) => i.row as unknown as EngineInventoryLineRow);
    const marked = sheet([], { meta_json: JSON.stringify({ kind: 'repair_checklist', answers: { engine_inventory_items: { kind: 'table', rows: [], rowsIn: 'erp_engine_inventory_lines' } } }) });
    expect(planEngineInventoryLines(marked, existing, 600)).toMatchObject({ inputs: [], skippedMarked: true, skippedEmptyGuard: false });
  });

  it('помеченный лист с НЕпустым rows выводится — писал слепой писатель (старый клиент, web-admin)', () => {
    const plan = planEngineInventoryLines(
      sheet([{ part_name: 'B' }], { meta_json: JSON.stringify({ kind: 'repair_checklist', answers: { engine_inventory_items: { kind: 'table', rows: [{ part_name: 'B' }], rowsIn: 'erp_engine_inventory_lines' } } }) }),
      [],
      600,
    );
    expect(plan).toMatchObject({ insert: 1, skippedMarked: false });
  });

  it('удалённый помеченный лист по-прежнему гасит свои строки', () => {
    const first = planEngineInventoryLines(sheet([{ part_name: 'A' }]), [], 500);
    const existing = first.inputs.map((i) => i.row as unknown as EngineInventoryLineRow);
    const marked = sheet([], {
      deleted_at: 700,
      meta_json: JSON.stringify({ kind: 'repair_checklist', answers: { engine_inventory_items: { kind: 'table', rows: [], rowsIn: 'erp_engine_inventory_lines' } } }),
    });
    expect(planEngineInventoryLines(marked, existing, 700)).toMatchObject({ tombstone: 1, skippedMarked: false });
  });
});

describe('pickSheetDedupeSurvivors — G4: из дублей живёт свежайший', () => {
  const head = (over: Partial<{ id: string; engine: string; created: number; updated: number }>) => ({
    id: over.id ?? 's1',
    engine_entity_id: over.engine ?? 'e1',
    created_at: over.created ?? 100,
    updated_at: over.updated ?? 100,
    json_rows: 3,
    live_lines: 0,
  });

  it('одиночки не трогаем, из пары удаляется старший по updated_at', () => {
    const plans = pickSheetDedupeSurvivors([
      head({ id: 'solo', engine: 'e0' }),
      head({ id: 'old', engine: 'e1', updated: 100 }),
      head({ id: 'new', engine: 'e1', updated: 200 }),
    ]);
    expect(plans).toEqual([{ engine_entity_id: 'e1', keep_id: 'new', delete_ids: ['old'] }]);
  });

  it('из трёх и больше живёт один, удаляемые — от свежих к старым', () => {
    const plans = pickSheetDedupeSurvivors([
      head({ id: 'a', engine: 'e1', updated: 100 }),
      head({ id: 'b', engine: 'e1', updated: 300 }),
      head({ id: 'c', engine: 'e1', updated: 200 }),
    ]);
    expect(plans).toEqual([{ engine_entity_id: 'e1', keep_id: 'b', delete_ids: ['c', 'a'] }]);
  });

  it('ничья по updated_at решается детерминированно по id', () => {
    const h = [head({ id: 's1', engine: 'e1', updated: 100 }), head({ id: 's2', engine: 'e1', updated: 100 })];
    expect(pickSheetDedupeSurvivors(h)).toEqual(pickSheetDedupeSurvivors([...h].reverse()));
  });

  it('пустой вход — пустой план', () => {
    expect(pickSheetDedupeSurvivors([])).toEqual([]);
  });
});
