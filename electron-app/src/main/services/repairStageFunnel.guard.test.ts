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
//     disassembly_defect — выводится из акта (проведение пишет только акт, шаг 3
//     унификации 10.10.2026), incoming_otk — проведение комплектности
//     (слово владельца 14.10.2026), card_created — материализация сущности,
//     obkatka — строка обкатки, sborka — сборочный наряд;
//  4) триггер авто-метки дефектовки — только решения оператора (утиль/замена),
//     выведенный repairable нормой не считается (иначе голая приёмка метила бы
//     дефектовку на каждом сохранении листа).

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const STAGES_IPC = src('../ipc/register/workSheets.ts');
const CHECKLISTS_IPC = src('../ipc/register/checklists.ts');
const ENGINE_CARDS_IPC = src('../ipc/register/engineCards.ts');
/** Единственная дверь записи карточки (карточка + пакетный приём списком). */
const ENGINE_CARD_WRITE = src('./engineCardWrite.ts');
const ENGINE_SERVICE = src('./engineService.ts');
const WORKSHEET_SERVICE = src('./workSheetService.ts');
const CARD = src('../../renderer/src/ui/pages/EngineDetailsPage.tsx');
const CHECKLIST_PANEL = src('../../renderer/src/ui/components/RepairChecklistPanel.tsx');
const TRIGGER = src('../../../../shared/src/domain/repairChecklist.ts');
/** Серверный разбор разнобоя «строка этапа ↔ дата карточки». */
const REVIEW_SCRIPT = src('../../../../backend-api/src/scripts/reviewRepairStageOrder.ts');
/** Гейт утиля (промт КАРМАНА #170): правило, сбор состояния, воронка и окно. */
const SCRAP_GATE_DOMAIN = src('../../../../shared/src/domain/engineScrapStageGate.ts');
const SCRAP_GATE_SERVICE = src('./engineScrapStageGateService.ts');
const REPAIR_STAGE_SERVICE = src('./repairStageService.ts');
const ENGINE_HISTORY_PANEL = src('../../renderer/src/ui/components/EngineHistoryFeedPanel.tsx');
const ENGINES_PAGE = src('../../renderer/src/ui/pages/EnginesPage.tsx');
const PRODUCTION_PROGRAM_PAGE = src('../../renderer/src/ui/pages/ProductionProgramPage.tsx');
const BULK_STAGE_DIALOG = src('../../renderer/src/ui/components/BulkStageAddDialog.tsx');
const SCRAP_BLOCK_DIALOG = src('../../renderer/src/ui/components/ScrapStageBlockDialog.tsx');

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
      ['engineCardWrite', ENGINE_CARD_WRITE],
    ] as Array<[string, string]>) {
      expect(`${name}: ${text.includes('kitting_done')}`).toBe(`${name}: false`);
    }
  });

  it('карта писателей: arrival/shipped/accepted — strict-save карточки (main, не renderer)', () => {
    expect(ENGINE_SERVICE).toContain("code === 'arrival_date'");
    // Этап следует за датой карточки (промты КАРМАНА #133/#136): обе двери — и карточка,
    // и EAV-путь — зовут один и тот же `syncCardDateStageRow`, а не «ensure mark-if-absent».
    expect(ENGINE_CARD_WRITE).toContain('syncCardDateStageRow');
    expect(ENGINE_SERVICE).toContain('syncCardDateStageRow');
    expect(ENGINE_CARD_WRITE).toContain("code: 'arrival'");
    expect(ENGINE_CARD_WRITE).toContain("code: 'shipped'");
    expect(ENGINE_CARD_WRITE).toContain("code: 'accepted'");
    // Через эту дверь ходят оба входа — карточка и пакетный приём списком.
    expect(ENGINE_CARDS_IPC).toContain('saveEngineCardGated(');
  });

  it('этап помнит источник: у авто-этапа есть атрибут-источник, а список — общий', () => {
    // Связь «этап ← дата карточки» живёт в домене, а не в двух местах сразу: список
    // «код этапа → атрибут» один (`CARD_SOURCE_ATTR`), и серверный разбор берёт его оттуда.
    expect(ENGINE_CARD_WRITE).toContain("attr: 'arrival_date'");
    expect(ENGINE_CARD_WRITE).toContain("attr: 'status_customer_sent_date'");
    expect(ENGINE_CARD_WRITE).toContain("attr: 'status_customer_accepted_date'");
    expect(REVIEW_SCRIPT).toContain('CARD_SOURCE_ATTR');
    expect(REVIEW_SCRIPT).not.toContain('const CARD_SOURCE_ATTR');
  });

  it('даты «Основного» → этапы пишет main, а не рендерер (дефект 07.10.2026)', () => {
    // Прежде рендерер звал `workSheets:stages:save` под правом `work_sheets.edit` —
    // у ролей без него (инженер, админ) этап молча не появлялся. Сторож держит
    // место записи: main-путь + check права-дизъюнкции (и сервер её требует).
    expect(ENGINE_CARD_WRITE).toContain('if (deps.canWriteStageRow)');
    expect(ENGINE_CARDS_IPC).toContain('canWriteStageRow');
    expect(ENGINE_CARDS_IPC).toContain("stageWritePerms['work_sheets.edit']");
    expect(ENGINE_CARDS_IPC).toContain("stageWritePerms['operations.edit']");
    expect(CARD, 'рендерер снова пишет этапы мимо main').not.toContain("code: 'shipped'");
    expect(CARD, 'рендерер снова пишет этапы мимо main').not.toContain("code: 'accepted'");
  });

  it('карта писателей: дефектовка — вывод из акта, карточка — материализация сущности', () => {
    // Унификация актов, шаг 3: проведение пишет только акт, этап disassembly_defect
    // выводится читателями (см. actStages) — прямой записи в панели нет.
    expect(CHECKLIST_PANEL).not.toContain("code: 'disassembly_defect'");
    expect(ENGINE_SERVICE).toContain("ensureRepairStageRow(db, engineId, 'card_created'");
  });

  it('карта писателей: обкатка — строка обкатки, сборка — сборочный наряд', () => {
    expect(WORKSHEET_SERVICE).toContain("ensureRepairStageRow(db, engineId, 'obkatka'");
    expect(ENGINE_SERVICE).toContain("ensureRepairStageRow(db, id, 'sborka'");
  });

  it('карта писателей: входной контроль — проведение комплектности (акт, не карточка)', () => {
    // Слово владельца 14.10.2026: проведение акта комплектности означает и приёмку,
    // и входной контроль ОТК. Триггер — дата осмотра в акте (кнопка «Провести
    // комплектность» — лишь ярлык к этому полю), запись — ensure mark-if-absent.
    expect(CHECKLISTS_IPC).toContain("ensureRepairStageRow(ctx.dataDb(), args.engineId, 'incoming_otk'");
    expect(CHECKLISTS_IPC).toContain('completeness_inspection_date');
    expect(CHECKLIST_PANEL).not.toContain("code: 'incoming_otk'");
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

/**
 * ГЕЙТ УТИЛЯ (промт КАРМАНА #170): утильный двигатель не начинает ремонт.
 *
 * Сторож держит МЕСТО блокировки: она обязана стоять в воронке записи этапа
 * (`saveRepairStageRow`), а не на одном экране — иначе её обойдут другим путём
 * (карточка, производственная программа, автоматы мастеров). Проверено временной правкой:
 * убрать вызов гейта из `saveRepairStageRow` — краснеют проверки этого блока.
 */
describe('гейт утиля: блокировка стоит в воронке записи этапа', () => {
  it('правило живёт в домене, а не в экране', () => {
    expect(SCRAP_GATE_DOMAIN).toContain('export function evaluateScrapStageGate');
    expect(SCRAP_GATE_DOMAIN).toContain('export function isScrapStageStateConsistent');
    // Правило «блокирует только утиль, неглавная деталь — подсказка» — здесь же.
    expect(SCRAP_GATE_DOMAIN).toContain('SCRAP_PART_HINT');
  });

  it('воронка записи этапа спрашивает гейт и возвращает его экрану', () => {
    expect(REPAIR_STAGE_SERVICE).toContain('resolveScrapStageGate');
    expect(REPAIR_STAGE_SERVICE).toContain('scrapGate');
    // Гейт спрашивается ВНУТРИ saveRepairStageRow (общий путь), а не в отдельной функции.
    const start = REPAIR_STAGE_SERVICE.indexOf('export async function saveRepairStageRow');
    const end = REPAIR_STAGE_SERVICE.indexOf('\nexport ', start + 1);
    const fn = REPAIR_STAGE_SERVICE.slice(start, end < 0 ? undefined : end);
    // Именно ВЫЗОВ, а не упоминание в типе: `typeof resolveScrapStageGate` в аннотации
    // остался бы, даже если вызов убрать — сторож обязан краснеть на такой откат.
    expect(fn).toContain('resolveScrapStageGate(');
    expect(fn).toContain('scrapGate');
  });

  it('гейт спрашивается ДО записи строки — этап не пишется мимо гейта', () => {
    const start = REPAIR_STAGE_SERVICE.indexOf('export async function saveRepairStageRow');
    const end = REPAIR_STAGE_SERVICE.indexOf('\nexport ', start + 1);
    const fn = REPAIR_STAGE_SERVICE.slice(start, end < 0 ? undefined : end);
    const gateAt = fn.indexOf('resolveScrapStageGate(');
    const writeAt = fn.indexOf('upsertOperation(');
    expect(gateAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(gateAt, 'гейт спрашивается до записи строки').toBeLessThan(writeAt);
  });

  it('автоматы мастеров идут через тот же путь — гейт останавливает и их', () => {
    const start = REPAIR_STAGE_SERVICE.indexOf('export async function ensureRepairStageRow');
    const end = REPAIR_STAGE_SERVICE.indexOf('\nexport ', start + 1);
    const fn = REPAIR_STAGE_SERVICE.slice(start, end < 0 ? undefined : end);
    expect(fn).toContain('saveRepairStageRow');
  });

  it('состояние двигателя для гейта собирается в одном месте', () => {
    expect(SCRAP_GATE_SERVICE).toContain('export async function readEngineScrapGateState');
    expect(SCRAP_GATE_SERVICE).toContain('isScrapCriterionEngineUtil');
  });

  it('все экраны, которые заводят этап, обрабатывают отказ гейта', () => {
    for (const [name, text] of [
      ['EngineHistoryFeedPanel', ENGINE_HISTORY_PANEL],
      ['EnginesPage', ENGINES_PAGE],
      ['ProductionProgramPage', PRODUCTION_PROGRAM_PAGE],
      ['BulkStageAddDialog', BULK_STAGE_DIALOG],
    ] as Array<[string, string]>) {
      expect(`${name}: ${text.includes('handleScrapStageResult')}`).toBe(`${name}: true`);
    }
  });

  it('окно предлагает ровно два действия и спрашивает причину', () => {
    expect(SCRAP_BLOCK_DIALOG).toContain('Деталь отремонтирована');
    expect(SCRAP_BLOCK_DIALOG).toContain('Отмена (не была отремонтирована)');
    expect(SCRAP_BLOCK_DIALOG).toContain('Причина снятия утиля');
  });
});
