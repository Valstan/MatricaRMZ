import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Воронка записи этапов (таблица 05.10.2026, PR2): все точки входа обязаны идти
// через `saveRepairStageRow` / `ensureRepairStageRow` — там субординация дат,
// пометка возврата и реестр кодов. Прямая запись stage-строк мимо воронки
// молча обходит гейты, и типам её не видно — поэтому сторож:
//
//  1) ручной ввод — только IPC `workSheets:stages:save` → `saveRepairStageRow`;
//  2) снесённый `kitting_done` не пишется нигде в клиенте (алиас — только чтение);
//  3) карта писателей зафиксирована: arrival/shipped/accepted — карточка,
//     disassembly_defect — проведение дефектовки, card_created — материализация
//     сущности, obkatka — строка обкатки, sborka — сборочный наряд;
//  4) триггер авто-метки дефектовки — только решения оператора (утиль/замена),
//     выведенный repairable нормой не считается (иначе голая приёмка метила бы
//     дефектовку на каждом сохранении листа).

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const STAGES_IPC = src('../ipc/register/workSheets.ts');
const CHECKLISTS_IPC = src('../ipc/register/checklists.ts');
const ENGINE_CARDS_IPC = src('../ipc/register/engineCards.ts');
const ENGINE_SERVICE = src('./engineService.ts');
const WORKSHEET_SERVICE = src('./workSheetService.ts');
const CARD = src('../../renderer/src/ui/pages/EngineDetailsPage.tsx');
const CHECKLIST_PANEL = src('../../renderer/src/ui/components/RepairChecklistPanel.tsx');
const TRIGGER = src('../../../../shared/src/domain/repairChecklist.ts');

describe('воронка этапов: все писатели через save/ensure', () => {
  it('ручной ввод идёт только через stages.save → saveRepairStageRow', () => {
    expect(STAGES_IPC).toContain('workSheets:stages:save');
    expect(STAGES_IPC).toContain('saveRepairStageRow');
  });

  it('снесённый kitting_done не пишется в клиенте', () => {
    for (const [name, text] of [
      ['RepairChecklistPanel', CHECKLIST_PANEL],
      ['EngineDetailsPage', CARD],
      ['engineService', ENGINE_SERVICE],
      ['workSheetService', WORKSHEET_SERVICE],
      ['checklists IPC', CHECKLISTS_IPC],
      ['engineCards IPC', ENGINE_CARDS_IPC],
    ] as Array<[string, string]>) {
      expect(`${name}: ${text.includes('kitting_done')}`).toBe(`${name}: false`);
    }
  });

  it('карта писателей: arrival — setAttr и strict-save карточки (main, не renderer)', () => {
    expect(ENGINE_SERVICE).toContain("code === 'arrival_date'");
    expect(ENGINE_CARDS_IPC).toContain("ensureRepairStageRow(db, id, 'arrival'");
  });

  it('карта писателей: shipped/accepted из карточки — mark-if-absent', () => {
    expect(CARD).toContain("code: 'shipped'");
    expect(CARD).toContain("code: 'accepted'");
  });

  it('карта писателей: дефектовка — проведение, карточка — материализация сущности', () => {
    expect(CHECKLIST_PANEL).toContain("code: 'disassembly_defect'");
    expect(ENGINE_SERVICE).toContain("ensureRepairStageRow(db, engineId, 'card_created'");
  });

  it('карта писателей: обкатка — строка обкатки, сборка — сборочный наряд', () => {
    expect(WORKSHEET_SERVICE).toContain("ensureRepairStageRow(db, engineId, 'obkatka'");
    expect(ENGINE_SERVICE).toContain("ensureRepairStageRow(db, id, 'sborka'");
  });

  it('триггер авто-метки — решения (утиль/замена), не выведенный repairable', () => {
    const start = TRIGGER.indexOf('export function engineInventoryHasDefectData');
    const end = TRIGGER.indexOf('\nexport ', start + 1);
    const fn = TRIGGER.slice(start, end < 0 ? undefined : end);
    expect(fn).toContain('rec.scrap_qty');
    expect(fn).toContain('rec.replace_qty');
    expect(fn).not.toContain('rec.repairable_qty');
  });
});
