import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// История ремонта рвётся молча в трёх местах, и ни одно из них не видят типы:
//  1) автозапись стадии не доходит до `operations` — история просто не пополняется;
//  2) дата, введённая задним числом, теряется: `operations.add` даты не принимает, и без
//     переноса в meta событие ложится сегодняшним днём;
//  3) список перестаёт читать историю — ступени «Последнее событие» и «Цех» показывают
//     карточку вместо фактического движения.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const PANEL = src('./EngineRepairHistoryPanel.tsx');
const CARD = src('../pages/EngineDetailsPage.tsx');
const SERVICE = src('../../../../main/services/engineService.ts');
const APP = src('../App.tsx');

describe('история ремонта пишется', () => {
  it('панель заводит ручную запись через operations', () => {
    expect(PANEL).toContain('window.matrica.operations.add(');
    expect(PANEL).toContain('REPAIR_HISTORY_OPERATION_TYPE');
  });

  it('дата события уезжает в meta — иначе запись задним числом ляжет сегодняшним днём', () => {
    expect(PANEL).toContain('...(Number.isFinite(typed) ? { at: typed } : {})');
  });

  it('действие вводится свободно, а не выбирается из закрытого списка', () => {
    expect(PANEL).toContain('list="repair-history-actions"');
    expect(PANEL).toContain('<datalist id="repair-history-actions">');
  });

  it('карточка галочки статусов больше не пишет — ввод только из единого списка (шаг 8/3)', () => {
    expect(CARD).not.toContain('repairHistoryMetaForStatus(code as StatusCode)');
    expect(CARD).not.toContain('applyStatusCheckboxChange(code, next)');
    expect(CARD).not.toContain('handleStatusCheckboxChange(');
    expect(CARD).not.toContain('Статусы ремонта');
  });

  it('автоматические записи помечены — оператор не должен принимать их за свои', () => {
    // С 15.09.2026 пометка — бейдж класса записи (Ручная / Стадия / Переезд / Этап работ: вид работ),
    // а строка этапа работ ещё и говорит, где её правят.
    expect(PANEL).toContain('REPAIR_HISTORY_ENTRY_TYPE_LABELS[entry.entryType]');
    expect(PANEL).toContain('data-repair-history-row={entry.source}');
    expect(PANEL).toContain('data-repair-history-kind={entry.entryType}');
    expect(PANEL).toContain('Правится в «Этапах работ»');
    expect(PANEL).toContain('formatWorkSheetValue(f)');
  });
});

describe('история доезжает до списка', () => {
  it('сервис списка собирает историю по двигателям', () => {
    expect(SERVICE).toContain('const historyByEngineId = await getEngineRepairHistoryMap(db, engineIds);');
    expect(SERVICE, 'читаем только строки истории и переезды — прочих операций у двигателя больше всего').toContain(
      "inArray(operations.operationType, [REPAIR_HISTORY_OPERATION_TYPE, 'workshop_transfer'])",
    );
  });

  it('цех истории важнее атрибута карточки', () => {
    expect(SERVICE).toContain("...(history?.workshopId || workshopId ? { workshopId: history?.workshopId || workshopId } : {})");
  });

  it('последнее событие и его дата попадают в строку списка', () => {
    expect(SERVICE).toContain('lastHistoryAction: history.lastAction');
    expect(SERVICE).toContain('lastHistoryAt: history.lastAt');
  });

  // Запись этапа работ правится не в истории: до карточки оператору оставалось идти искать
  // её в списке руками, зная только дату и вид работ.
  it('из истории ремонта можно перейти в карточку самого этапа работ', () => {
    expect(PANEL).toContain('data-repair-history-open-sheet');
    expect(PANEL).toContain('props.onOpenWorkSheet?.(entry.id, entry.sheet?.typeName)');
    expect(PANEL, 'переход только у записей этапа работ').toContain("entry.entryType === 'sheet' && entry.sheet && props.onOpenWorkSheet");
    expect(APP, 'карточка двигателя получает открывашку от приложения').toContain('onOpenWorkSheet={(id: string, title?: string)');
  });

  // M118: список заменяется только если подпись строки изменилась. Поля, которые меняются БЕЗ
  // правки самой сущности (операции!), обязаны быть в подписи — иначе свежий список признаётся
  // тем же самым и отбрасывается, а оператор видит «событий нет» сразу после записи события.
  it('поля ступеней входят в подпись строки списка', () => {
    for (const field of ['e.hasDefectAct', 'e.defectDate', 'e.workshopId', 'e.lastHistoryAction', 'e.lastHistoryAt', 'e.lastSheetNode', 'e.lastSheetAt', 'e.lastStageCode', 'e.lastStageAt']) {
      expect(APP, `${field} нет в engineRowSignature — свежий список будет отброшен`).toContain(field);
    }
  });
});

describe('единый список этапов в карточке (план unified-repair-stages, шаг 4)', () => {
  it('секция этапов живёт во вкладке истории и читает шаблон с мостом', () => {
    expect(PANEL).toContain('<RepairStagesSection');
    expect(src('./RepairStagesSection.tsx')).toContain('window.matrica.workSheets.stages.list(props.engineId)');
    expect(src('./RepairStagesSection.tsx')).toContain('window.matrica.workSheets.stages.templates.list()');
  });

  it('этап пишется, правится датой и убирается — всё из секции', () => {
    const SECTION = src('./RepairStagesSection.tsx');
    expect(SECTION).toContain("window.matrica.workSheets.stages.save({ ...args, engineId: props.engineId })");
    expect(SECTION).toContain('data-repair-stage-add');
    expect(SECTION).toContain('data-repair-stage-date={row.id}');
    expect(SECTION).toContain('window.matrica.workSheets.stages.remove(id)');
    expect(SECTION).toContain('data-repair-stage-row={row.code}');
  });

  it('гейт дублей спрашивает проходом, а не красной ошибкой', () => {
    expect(src('./RepairStagesSection.tsx')).toContain('data-repair-stage-confirm-pass');
    expect(src('./RepairStagesSection.tsx')).toContain('repeatPass: pendingPass.pass');
  });

  it('кнопка «Провести дефектовку» отмечает этап сама, ручной не перезаписывает', () => {
    const CHECKLIST = src('./RepairChecklistPanel.tsx');
    expect(CHECKLIST).toContain("window.matrica.workSheets.stages.save({");
    expect(CHECKLIST).toContain("code: 'disassembly_defect'");
    expect(CHECKLIST).toContain('!rows.some((r) => r.code ===');
  });

  // Дефектовка 30.09.2026: этап вставал датой НАЖАТИЯ кнопки, а не «Дата разборки/дефектовки»
  // из вкладки акта. Повторная проводка двигала этап вперёд, и он оказывался ПОСЛЕ
  // обкатки/сборки — по смыслу невозможно. Сторож держит правило, а не разовое исправление:
  // дата этапа = `defect_start_date`, а `Date.now()` живёт только в ветке «поле не заполнено».
  it('дата этапа дефектовки — из поля «Дата разборки/дефектовки», не из момента нажатия', () => {
    const CHECKLIST = src('./RepairChecklistPanel.tsx');
    expect(CHECKLIST).toContain('answers as any)?.defect_start_date');
    expect(CHECKLIST).toContain('atMs: defectStartMs');
    const stageBlock = CHECKLIST.slice(CHECKLIST.indexOf("code: 'disassembly_defect'") - 1200, CHECKLIST.indexOf("code: 'disassembly_defect'") + 200);
    expect(stageBlock).not.toContain('atMs: Date.now()');
  });

  it('кнопка «Провести комплектность» отмечает этап сама (шаг 8: пара к autoFrom kittingAct)', () => {
    const CHECKLIST = src('./RepairChecklistPanel.tsx');
    expect(CHECKLIST).toContain("code: 'kitting_done'");
    expect(CHECKLIST).toContain('Этап «Комплектовка сделана» отмечен.');
  });

  it('гейт отгрузки живёт в секции этапов: shipped/accepted без закрытых нарядов не встают (шаг 8/3)', () => {
    const SECTION = src('./RepairStagesSection.tsx');
    expect(SECTION).toContain('confirmShipmentWithOpenAssembly');
    expect(SECTION).toContain("addingCode === 'shipped' || addingCode === 'accepted'");
    expect(SECTION).toContain('engineLabel');
  });

  it('у строки этапа виден автор внесения (H1: автор навсегда, не правщик)', () => {
    const SECTION = src('./RepairStagesSection.tsx');
    expect(SECTION).toContain("'Кто'");
    expect(SECTION).toContain('data-repair-stage-by={row.id}');
    expect(SECTION).toContain('{row.by ?');
  });
});
