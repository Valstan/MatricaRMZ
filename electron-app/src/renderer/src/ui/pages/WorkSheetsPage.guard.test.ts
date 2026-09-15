import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Ведомости работ (15.09.2026) рвутся молча в четырёх местах: вкладка исчезает из меню
// (реестр разделов), строка уходит не в main-сервис (и «Отремонтирован» не ставится),
// скрытая панель остаётся на экране (M78), список теряет счётчик и «№».
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./WorkSheetsPage.tsx');
const CARD = src('./WorkSheetDetailsPage.tsx');
const TYPE_DIALOG = src('../components/WorkSheetTypeEditorDialog.tsx');
const APP = src('../App.tsx');
const SECTIONS = src('../../../../../../shared/src/domain/uiSections.ts');
const ACCESS = src('../../../../../../shared/src/domain/sectionAccess.ts');
const GATE = src('../../../../main/ipc/sectionGate.ts');
const SERVICE = src('../../../../main/services/workSheetService.ts');
const IPC = src('../../../../main/ipc/register/workSheets.ts');
const ANDROID_WIRING = src('../../../../../../android-app/src/core/ipcWiring.ts');
const CACHE = src('../utils/workSheetTypesCache.ts');
const REST_ROUTE = src('../../../../../../backend-api/src/routes/workSheetTypes.ts');

describe('ведомости работ — экран', () => {
  it('вкладка заведена в реестре разделов, меню и приложении под правом на операции', () => {
    expect(SECTIONS).toContain("work_sheets: 'Ведомости работ'");
    expect(SECTIONS).toContain("production: ['engines', 'work_sheets'");
    expect(ACCESS).toContain("menuTabs: ['engines', 'work_sheets'");
    expect(APP).toContain("...(caps.canViewOperations ? (['work_sheets'] as const) : [])");
    expect(APP).toContain("{t === 'work_sheets' && (");
    expect(GATE, 'IPC ведомостей гейтится разделом «Производство»').toContain("['workSheets:', 'production']");
  });

  it('запись в ведомости — отдельное право, и раздельный уровень у секционного гейта', () => {
    // Проверяем пропы по отдельности: разметка многострочная, и непрерывная подстрока
    // ломалась бы от любого переноса, а не от потери права.
    for (const prop of ['canEdit={caps.canEditWorkSheets}', 'canManageTypes={caps.canEditWorkSheets}']) {
      expect(APP, `ведомости: ${prop} — строки и виды работ под одним правом`).toContain(prop);
    }
    expect(IPC, 'запись — work_sheets.edit, а не operations.edit мастеров').toContain(
      "requirePermOrResult(ctx, 'work_sheets.edit')",
    );
    expect(IPC, 'чтение остаётся правом истории').toContain("requirePermOrResult(ctx, 'operations.view')");
    expect(IPC, 'erp.dictionary.edit больше не при чём').not.toContain('erp.dictionary.edit');
    for (const ch of ['workSheets:rows:save', 'workSheets:rows:delete', 'workSheets:types:upsert']) {
      expect(GATE, `наблюдателю раздела запись ${ch} закрыта`).toContain(`'${ch}'`);
    }
    // Узлы — REST: гейт клиента без такого же гейта на сервере означал бы, что выданное
    // поимённо право работает до первого сохранения, а потом сервер отвечает отказом.
    expect(REST_ROUTE, 'серверный роут узлов — то же право, что и IPC').toContain(
      'requirePermission(PermissionCode.WorkSheetsEdit)',
    );
    expect(REST_ROUTE, 'чтение справочника остаётся правом истории').toContain(
      'requirePermission(PermissionCode.OperationsView)',
    );
  });

  it('домен ведомостей подключён и на планшете — плитка без IPC открывалась и молчала', () => {
    expect(ANDROID_WIRING).toContain('registerWorkSheetsIpc(ctx);');
  });

  // Вкладки по видам работ разрезали экран на копии одного списка — каждая со своим
  // тулбаром, ступенями и раскладкой колонок. Отобрать одно значение умеет ступень.
  it('список ОДИН: вкладок нет, вид работ — колонка и ступень', () => {
    expect(PAGE, 'вкладки сняты').not.toContain('<CardTabs');
    expect(PAGE, 'вид работ — колонка списка').toContain("id: 'type', label: 'Вид работ'");
    expect(PAGE, 'ступени общие для всего списка, без полей отдельного вида').toContain('workSheetFacets([])');
    expect(PAGE, 'раскладка колонок одна на список, а не на вид').toContain("useColumnLayout('list:workSheets:columns'");
  });

  it('новая ведомость берёт вид работ из фильтра, а не первый из справочника', () => {
    expect(PAGE).toContain('const initialTypeCode = useMemo(');
    expect(PAGE).toContain('ui.facets?.[TYPE_FACET_ID]');
    expect(PAGE).toContain('initialTypeCode={initialTypeCode}');
  });

  it('печать списка — общим механизмом и вне тулбара', () => {
    expect(PAGE).toContain('<ListPrintDialog');
    expect(PAGE).toContain('buildListPrintColumns(columns)');
    // Внутри PageToolbar диалог уехал бы в меню переполнения вместе с кнопкой.
    const toolbarEnd = PAGE.indexOf('</PageToolbar>');
    expect(toolbarEnd, 'тулбар на месте').toBeGreaterThan(0);
    expect(PAGE.indexOf('<ListPrintDialog'), 'диалог печати ниже тулбара').toBeGreaterThan(toolbarEnd);
    expect(PAGE, 'на планшете печати нет — как у всех списков').toContain('!isAndroidPlatform()');
  });

  it('список — на общей обвязке: счётчик, «№», виртуализация', () => {
    expect(PAGE).toContain('<ListCount');
    expect(PAGE).toContain('<RowNumberHeaderCell');
    expect(PAGE).toContain('rowNumbers');
  });

  // Слово сменилось по решению владельца: узлом в программе зовётся сборочная единица
  // (`warehouse.ts`, «№ узла сборки» в дефектовке), и два значения одного слова путали.
  it('на экране — «вид работ», а не «узел»', () => {
    // Смотрим ТОЛЬКО на то, что видит оператор: комментарии объясняют само переименование
    // и обязаны называть старое слово, иначе объяснение теряет смысл.
    const withoutComments = (text: string) =>
      text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [name, text] of [
      ['страница', PAGE],
      ['карточка ведомости', CARD],
      ['редактор видов работ', TYPE_DIALOG],
    ] as const) {
      expect(withoutComments(text), `${name}: на экране осталось слово «узел»`).not.toMatch(/[Уу]зл|[Уу]зел/);
    }
  });

  // Ведомость пишется по id, который сгенерировал список: карточка новой открывается
  // сразу, а запись появляется только по «Сохранить» — пустых ведомостей не остаётся.
  it('ведомость пишется через main-сервис тем же id, что открыл карточку', () => {
    expect(CARD).toContain('window.matrica.workSheets.rows.save(');
    expect(CARD, 'сохраняем ровно тот id, с которым карточку открыли').toContain('id: props.rowId,');
    expect(PAGE, 'id новой ведомости даёт список').toContain('crypto.randomUUID()');
    expect(CARD, 'ведомость не переезжает на другой двигатель и не меняет вид работ').toContain(
      'disabled={!props.canEdit || !props.isNew}',
    );
  });

  it('карточка ведомости — вкладка со стандартной обвязкой, а не модальное окно', () => {
    expect(CARD).toContain('<EntityCardShell');
    expect(CARD, 'сохранить / сохранить и выйти / сброс / удалить / закрыть').toContain('<CardActionBar');
    expect(CARD, 'сторож несохранённого').toContain('props.registerCardCloseActions({');
    expect(APP, 'вид вкладки заведён и рисуется').toContain("{t === 'work_sheet' && selectedWorkSheetId && (");
    expect(APP, 'карточку не выкидывает гейт скрытых вкладок').toContain("tab === 'work_sheet' ||");
    expect(APP, 'вкладка восстанавливается из сессии').toContain("case 'work_sheet': return void openWorkSheet(entityId);");
    expect(APP, 'в шапке вкладки — не огрызок id').toContain("return known ? `📒 ${known}` : '📒 Ведомость';");
  });

  it('из карточки ведомости можно уйти в двигатель', () => {
    expect(CARD).toContain('data-work-sheet-open-engine');
    expect(CARD).toContain('props.onOpenEngine(engineId)');
  });

  it('завершение ремонта — один раз при добавлении, той же формой автозаписи, что у карточки', () => {
    expect(SERVICE).toContain("if (created && input.type.completesRepair === true)");
    expect(SERVICE).toContain("advanceEngineStatusForWorkOrder(db, engineId, 'status_repaired', atMs, actor)");
    expect(SERVICE).toContain("repairHistoryMetaForStatus('status_repaired', atMs)");
    expect(SERVICE).toContain("if (current.status_repaired) return { applied: false, reason: 'already-repaired' };");
  });

  // Идентификатор не заменяет подпись: огрызок uuid в колонке «Двигатель» и голый uuid в
  // колонке «Цех» читаются как испорченные данные, а не как «подписи нет».
  it('на экран не уходит идентификатор: ни огрызок uuid двигателя, ни uuid цеха', () => {
    expect(PAGE, 'огрызок uuid двигателя убран').not.toContain('engineId.slice(0, 8)');
    expect(PAGE).toContain('return r.engineNumber || HUMAN_LABEL_NO_NUMBER;');
    expect(PAGE, 'цех: справочник → снимок строки → прочерк').toContain(
      "return fromDirectory(r.workshopId) || r.workshopName || HUMAN_LABEL_DASH;",
    );
    expect(SERVICE, 'снимок имени цеха отдаётся из самой строки').toContain("workshopName: meta.workshopName ?? ''");
  });

  it('справочник узлов недоступен — экран говорит это вслух, а не показывает пустоту', () => {
    expect(PAGE).toContain("typesSource === 'none'");
    expect(PAGE).toContain('data-work-sheet-types-unavailable');
    expect(CACHE, 'три состояния источника, а не флаг «из кэша»').toContain("source: (cached.length > 0 ? 'cache' : 'none')");
  });

  it('правка без справочника видов работ: колонки восстанавливаются из полей самой ведомости', () => {
    expect(CARD).toContain('const rowColumns = useMemo<WorkSheetColumn[]>(');
    expect(CARD, 'форма рисует восстановленный набор, а не только колонки вида').toContain('{columns.map((col) => (');
    expect(CARD, 'статус при правке не ставится — подставлять чужой completesRepair нельзя').toContain('completesRepair: false');
    expect(CARD, 'имя цеха уезжает снимком вместе с ведомостью').toContain(
      'workshopName: props.workshops.find((w) => w.id === workshopId)?.label ?? null,',
    );
  });

  // Откат без штампа — угадывание: историю стадий пишут не все пути, а карточка не помнит,
  // кто поставил статус. И спрашивать оператора можно только там, где откатывать есть что.
  it('откат «Отремонтирован» опирается на штамп строки и на второе подтверждение', () => {
    expect(SERVICE, 'строка запоминает свой след в карточке').toContain('repairStamp: done.stamp');
    expect(SERVICE, 'откатываем только то, что с тех пор не меняли').toContain(
      'if (isEavFlagSet(attrs[flag.code]) !== flag.to) {',
    );
    expect(SERVICE, 'автозапись стадии гаснет вместе со статусом').toContain(
      'await softDeleteOperation(db, stamp.statusEntryId);',
    );
    expect(CARD, 'второй вопрос — только когда откатывать есть что').toContain('row.repairStamped && window.confirm(');
  });

  it('архив узла обратим из того же окна — иначе это дверь в одну сторону', () => {
    expect(TYPE_DIALOG, 'редактор видит архивные узлы').toContain('loadWorkSheetTypes({ includeArchived: true })');
    expect(TYPE_DIALOG).toContain('window.matrica.workSheets.types.restore(t.id)');
    expect(TYPE_DIALOG).toContain('data-work-sheet-type-archived');
  });

  it('код узла и код колонки после создания заморожены — на них ссылаются строки', () => {
    expect(TYPE_DIALOG).toContain('Код заморожен');
    expect(TYPE_DIALOG).toContain('workSheetCodeFromName(label)');
  });
});
