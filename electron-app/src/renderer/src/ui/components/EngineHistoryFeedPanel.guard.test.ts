import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Единая лента истории ремонта (задача владельца 01.10.2026). Прежде на вкладке было
// три ленты — этапы, записи истории и паспорт по всем операциям — на одних и тех же
// строках `operations`. Каждая часть ленты рвётся молча, и ни одна из поломок не видна
// типам, поэтому свойства держит этот сторож:
//
//  1) три ленты не вернутся отдельными компонентами (иначе строки снова разъедутся);
//  2) лента собирается в домене (`buildEngineHistoryFeed`), а не в компоненте;
//  3) видны ОБЕ даты — события и записи: этап «Сборка» за 20-е может быть введён сегодня,
//     и без второй даты он читается как свежее событие;
//  4) сортировка сверху вниз по дате события;
//  5) этап по-прежнему пишется, правится датой и снимается прямо здесь;
//  6) автозапись стадии и дата «задним числом» не теряются.

function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PANEL = src('./EngineHistoryFeedPanel.tsx');
const CARD = src('../pages/EngineDetailsPage.tsx');
const WSH = src('../pages/WorkSheetsPage.tsx');
const SERVICE = src('../../../../main/services/engineService.ts');
const APP = src('../App.tsx');

describe('вкладка «История ремонта» — одна лента, а не три', () => {
  it('карточка монтирует только панель ленты', () => {
    expect(CARD).toContain('<EngineHistoryFeedPanel');
    // Прежние три ленты не должны вернуться: они читают те же строки operations
    // и расходятся между собой по дате и подписи.
    expect(CARD).not.toContain('EngineRepairHistoryPanel');
    expect(CARD).not.toContain('EngineTimelinePanel');
    expect(CARD).not.toContain('RepairStagesSection');
  });

  it('лента собирается доменом, а не сортируется в компоненте', () => {
    // Правило «одна строка = одно событие, новые сверху» обязано быть одно, иначе
    // карточка и любой будущий отчёт разойдутся по датам.
    expect(PANEL).toContain('buildEngineHistoryFeed(rows)');
    expect(PANEL).not.toMatch(/\.sort\(\s*\(a, b\)\s*=>\s*b\.at/);
  });

  it('в строке видны обе даты — события и записи', () => {
    expect(PANEL).toContain('data-history-feed-recorded={item.id}');
    expect(PANEL).toContain('formatMoscowDate(new Date(item.at))');
    expect(PANEL).toContain('formatMoscowDate(new Date(item.recordedAt))');
    // Без колонки «Записано» введённый задним числом этап выглядит свежим событием.
    expect(PANEL).toContain("'Записано'");
  });

  it('строка несёт тип события — иначе этап и наряд не отличить', () => {
    expect(PANEL).toContain('data-history-feed-kind={item.kind}');
    expect(PANEL).toContain('item.kindLabel');
  });

  it('автор виден по-русски, служебный логин не рисуется', () => {
    expect(PANEL).toContain('data-history-feed-by={item.id}');
    expect(PANEL).toContain('{item.by ?');
    expect(PANEL).not.toMatch(/\{(?:entry\.performedBy|row\.by)\}/);
  });

  it('из ленты есть переход в карточку этапа работ — там его и правят', () => {
    expect(PANEL).toContain('data-repair-history-open-sheet');
    expect(PANEL).toContain('props.onOpenWorkSheet?.(item.sheetRowId as string, item.title)');
    expect(PANEL).toContain('item.sheetRowId && props.onOpenWorkSheet');
    expect(APP, 'карточка двигателя получает открывашку от приложения').toContain('onOpenWorkSheet={(id: string, title?: string)');
  });
});

// Dual-entry дефектовки (PR4): этап ставится и кнопкой «Провести дефектовку», и вручную
// с датой. Прежде service отказывал на смене даты жёстко, и стоило авто-метке создать
// строку первой — ручной ввод становился невозможен. Теперь это вопрос оператору, и
// молчаливых двух дорог быть не должно: вопрос обязан быть виден и снимаемым.
describe('лента: смена даты дефектовки спрашивает оператора (dual-entry, PR4)', () => {
  it('ответ сервиса о смене даты превращается в вопрос с кнопкой', () => {
    expect(PANEL, 'вопрос о смене даты дефектовки не разобран — оператор увидит молчаливый отказ').toContain(
      'r.defectDateChange',
    );
    expect(PANEL).toContain('data-repair-stage-confirm-defect-date');
    expect(PANEL, 'в подтверждении нет confirmDefectDate — повтор уйдёт в тот же вопрос по кругу').toContain(
      'confirmDefectDate: true',
    );
  });

  it('вопрос виден и его можно отклонить', () => {
    expect(PANEL, 'состояние вопроса не сбрасывается после успеха — кнопка повиснет на экране').toContain(
      'setPendingDefectDate(null)',
    );
    expect(PANEL).toContain('{pendingDefectDate && (');
  });
});

describe('лента пишется так же, как писалась раньше', () => {
  it('этап добавляется, правится датой и снимается прямо в ленте', () => {
    expect(PANEL).toContain('window.matrica.workSheets.stages.save({ ...args, engineId: props.engineId })');
    expect(PANEL).toContain('data-repair-stage-add');
    expect(PANEL).toContain('data-repair-stage-date={item.id}');
    expect(PANEL).toContain('data-repair-stage-apply-date={item.id}');
    expect(PANEL).toContain('window.matrica.workSheets.stages.remove(id)');
  });

  it('ручная запись идёт через operations, дата события — в meta', () => {
    expect(PANEL).toContain('window.matrica.operations.add(');
    expect(PANEL).toContain('REPAIR_HISTORY_OPERATION_TYPE');
    // operations.add не принимает дату: без переноса в meta запись задним числом легла бы
    // сегодняшним днём, и лента соврала бы о времени события.
    expect(PANEL).toContain('...(Number.isFinite(typed) ? { at: typed } : {})');
  });

  it('действие вводится свободно, а не выбирается из закрытого списка', () => {
    expect(PANEL).toContain('list="repair-history-actions"');
    expect(PANEL).toContain('<datalist id="repair-history-actions">');
  });

  it('гейт дублей этапа спрашивает проходом, а не красной ошибкой', () => {
    expect(PANEL).toContain('data-repair-stage-confirm-pass');
    expect(PANEL).toContain('repeatPass: pendingPass.pass');
  });

  it('ручная запись правится и удаляется в ленте (текст, дата, примечание)', () => {
    expect(PANEL, 'у ручной записи нет кнопки правки — поправить опечатку негде').toContain('data-manual-edit={item.id}');
    expect(PANEL, 'у ручной записи нет кнопки удаления — убрать неверную строку негде').toContain('data-manual-remove={item.id}');
    expect(PANEL).toContain('window.matrica.operations.updateManual(');
    expect(PANEL).toContain('window.matrica.operations.remove(');
  });

  it('правка даты этапа не стирает примечание (писатель собирает строку заново)', () => {
    // writeStage пересоздаёт meta из входа: вызов без note уронил бы примечание,
    // и смена даты молча съедала бы текст. Передаём note из строки.
    expect(PANEL, 'правка даты этапа вызывается без примечания — оно сотрётся').toContain('...(item.note ? { note: item.note } : {})');
  });

  it('последнее действие в ленте откатывается кнопкой «Отменить»', () => {
    expect(PANEL, 'кнопки отката нет — неправильно добавленное/удалённое не вернуть').toContain('data-history-undo');
    expect(PANEL).toContain('runUndo');
  });

  it('гейт отгрузки при незакрытом сборочном наряде остался на отметке этапа', () => {
    expect(PANEL).toContain('confirmShipmentWithOpenAssembly');
    expect(PANEL).toContain("stageCode === 'shipped' || stageCode === 'accepted'");
    expect(PANEL).toContain('props.engineLabel');
  });

  it('шаблон этапов читается мостом, а не локальной константой', () => {
    expect(PANEL).toContain('window.matrica.workSheets.stages.templates.list()');
    // Порядок линейки задаёт сервер: со статичным списком половина подписей разъехалась бы
    // после правки шаблона владельцем.
    expect(PANEL).not.toContain('DEFAULT_REPAIR_STAGE_TEMPLATES');
  });

  it('поля строки этапа работ показываются подписями, а не кодами', () => {
    expect(PANEL).toContain('engineHistoryFeedFieldLines(item)');
  });
});

describe('лента не потеряла то, ради чего её строки заводились', () => {
  it('сервис списка по-прежнему собирает историю по двигателям', () => {
    expect(SERVICE).toContain('const historyByEngineId = await getEngineRepairHistoryMap(db, engineIds);');
    expect(SERVICE, 'читаем только строки истории и переезды — прочих операций у двигателя больше всего').toContain(
      "inArray(operations.operationType, [REPAIR_HISTORY_OPERATION_TYPE, 'workshop_transfer'])",
    );
    expect(SERVICE).toContain('lastHistoryAction: history.lastAction');
    expect(SERVICE).toContain('lastHistoryAt: history.lastAt');
    expect(SERVICE).toContain("...(history?.workshopId || workshopId ? { workshopId: history?.workshopId || workshopId } : {})");
  });

  // M118: список заменяется только если подпись строки изменилась. Поля, которые меняются БЕЗ
  // правки самой сущности (операции!), обязаны быть в подписи — иначе после записи события
  // оператор видит «событий нет».
  it('поля ступеней входят в подпись строки списка', () => {
    for (const field of ['e.hasDefectAct', 'e.defectDate', 'e.workshopId', 'e.lastHistoryAction', 'e.lastHistoryAt', 'e.lastSheetNode', 'e.lastSheetAt', 'e.lastStageCode', 'e.lastStageAt']) {
      expect(APP, `${field} нет в engineRowSignature — свежий список будет отброшен`).toContain(field);
    }
  });

  it('карточка галочек статусов не вернулась — ввод только из ленты', () => {
    expect(CARD).not.toContain('repairHistoryMetaForStatus(code as StatusCode)');
    expect(CARD).not.toContain('applyStatusCheckboxChange(code, next)');
    expect(CARD).not.toContain('Статусы ремонта');
  });

  it('кнопка «Провести дефектовку» по-прежнему отмечает этап сама', () => {
    const CHECKLIST = src('./RepairChecklistPanel.tsx');
    expect(CHECKLIST).toContain("window.matrica.workSheets.stages.save({");
    expect(CHECKLIST).toContain("code: 'disassembly_defect'");
    expect(CHECKLIST).toContain('!rows.some((r) => r.code ===');
    expect(CHECKLIST).toContain("code: 'arrival'");
  });

  // Дефектовка 30.09.2026: этап вставал датой НАЖАТИЯ кнопки, а не «Дата разборки/дефектовки»
  // из вкладки акта — по смыслу этап уезжал за обкатку.
  it('дата этапа дефектовки — из поля акта, не из момента нажатия', () => {
    const CHECKLIST = src('./RepairChecklistPanel.tsx');
    expect(CHECKLIST).toContain('answers as any)?.defect_start_date');
    expect(CHECKLIST).toContain('atMs: defectStartMs');
    const stageBlock = CHECKLIST.slice(CHECKLIST.indexOf("code: 'disassembly_defect'") - 1200, CHECKLIST.indexOf("code: 'disassembly_defect'") + 200);
    expect(stageBlock).not.toContain('atMs: Date.now()');
  });
});

describe('вверху только две кнопки, инлайн-полей нет (владелец 01.10.2026)', () => {
  it('форма этапа раскрывается кнопкой и несёт цех, дату и Применить/Отмену', () => {
    expect(PANEL).toContain('data-repair-stage-form-open');
    expect(PANEL).toContain('Добавить этап ремонта');
    // Инлайн-форма всегда видимой не должна возвращаться: селект живёт только в раскрытой форме.
    expect(PANEL).toContain('addingStage && (');
    expect(PANEL).toContain('stageWorkshopId');
    expect(PANEL).toContain('Применить');
  });

  it('ручная запись — дата, действие, цех и комментарий; причины и произвольных полей нет', () => {
    expect(PANEL).toContain('data-repair-history-add');
    expect(PANEL).not.toContain('draftReason');
    expect(PANEL).not.toContain('+ поле');
    // Уже записанные причины продолжают показываться — резали только ввод.
    expect(PANEL).toContain('{item.reason && <div>{item.reason}</div>}');
  });

  it('кнопка списка этапов — первая слева, синяя, короткая', () => {
    expect(WSH).toContain('data-bulk-stage-add-open');
    expect(WSH).toContain('Добавить этап');
    expect(WSH).not.toContain('Добавить этап на движки');
    // Главная кнопка — primary по умолчанию (без variant="ghost").
    expect(WSH).toContain('<Button onClick={() => setBulkAddOpen(true)}');
  });

  it('лента резиновая по контенту и по центру: без фикс-раскладки и без горизонтального скролла', () => {
    // Жалоба владельца 02.10.2026: фикс-ширины рвали «Событие» и «Кто» в несколько строк,
    // а пустая «Причина» забирала полэкрана. Ширина теперь по содержимому, короткие
    // колонки в одну строку (nowrap), таблица ужата по контенту и отцентрирована.
    expect(PANEL).not.toContain("overflowX: 'auto'");
    expect(PANEL).not.toContain("tableLayout: 'fixed'");
    expect(PANEL).not.toContain('<colgroup>');
    expect(PANEL).toContain("width: 'max-content'");
    expect(PANEL).toContain('justifyContent: \'center\'');
    expect(PANEL).toContain("whiteSpace: 'nowrap'");
  });

  it('правка даты — крайняя слева, удаление — крайнее справа (владелец 02.10.2026)', () => {
    // Кнопка ✎ жила внутри ячейки события и уезжала под название; ✕ сидел в безымянной
    // колонке. Теперь у таблицы пустые крайние заголовки, а кнопки несут data-атрибуты.
    expect(PANEL).toContain("['', 'Дата'");
    expect(PANEL).toContain('data-repair-stage-edit-date={item.id}');
    expect(PANEL).toContain('data-repair-stage-remove={item.id}');
  });
});

describe('лента: дата дефектовки из истории доносится до листа (09.10.2026)', () => {
  it('успешная запись disassembly_defect зовёт setAnswerDate', () => {
    expect(PANEL, 'дата истории не доходит до листа — снова две правды').toContain(
      'window.matrica.checklists.engineSetAnswerDate(',
    );
    expect(PANEL).toContain("code: 'defect_start_date'");
  });

  it('вопрос о смене даты больше не врёт про лист', () => {
    expect(PANEL, 'текст вопроса обещает несвязанность — оператор не поверит связке').not.toContain(
      'Лист дефектовки свою дату не поменяет',
    );
  });
});