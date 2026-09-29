import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Этапы работ (15.09.2026) рвутся молча в четырёх местах: вкладка исчезает из меню
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
const BACKEND_PERMS = src('../../../../../../backend-api/src/auth/permissions.ts');
const STAGE_DIALOG = src('../components/RepairStageTemplateDialog.tsx');
const STAGE_REST_ROUTE = src('../../../../../../backend-api/src/routes/repairStageTemplates.ts');
const SYNC_GUARD = src('../../../../../../backend-api/src/services/sync/ledgerAuthzGuard.ts');
const OVERLAY = src('../components/GlobalSearchOverlay.tsx');
const GLOBAL_SEARCH = src('../../../../../../shared/src/domain/globalSearch.ts');

describe('этапы работ — экран', () => {
  it('вкладка заведена в реестре разделов, меню и приложении под правом на операции', () => {
    expect(SECTIONS).toContain("work_sheets: 'Этапы работ'");
    expect(SECTIONS).toContain("production: ['engines', 'work_sheets'");
    expect(ACCESS).toContain("menuTabs: ['engines', 'work_sheets'");
    expect(APP).toContain("...(caps.canViewOperations ? (['work_sheets'] as const) : [])");
    expect(APP).toContain("{t === 'work_sheets' && (");
    expect(GATE, 'IPC этапов работ гейтится разделом «Производство»').toContain("['workSheets:', 'production']");
  });

  // Два права (владелец 15.09.2026, вечер): строки заполняют одни люди, виды работ ведут
  // другие. Под одним кодом «выдать заполнение» означало бы «выдать и справочник».
  // Шаг 7 плана unified-repair-stages (29.09.2026): страница — сводка, заполнение только
  // в карточке двигателя, поэтому список всегда read-only (`canEdit={false}`); право
  // `work_sheets.edit` живёт в карточке этапа и секции этапов (проверяется их сторожами).
  it('строки и виды работ — два отдельных права, и раздельный уровень у секционного гейта', () => {
    // Проверяем пропы по отдельности: разметка многострочная, и непрерывная подстрока
    // ломалась бы от любого переноса, а не от потери права.
    expect(APP, 'список — сводка: пропса правки нет вовсе').not.toMatch(/<WorkSheetsPage[^>]*canEdit=/);
    expect(APP, 'виды работ — своё право, не то же, что строки').toContain('canManageTypes={caps.canEditWorkSheetTypes}');
    expect(APP).not.toContain('canManageTypes={caps.canEditWorkSheets}');
    expect(IPC, 'строки — work_sheets.edit, а не operations.edit мастеров').toContain(
      "requirePermOrResult(ctx, 'work_sheets.edit')",
    );
    expect(IPC, 'виды работ — work_sheet_types.edit').toContain("requirePermOrResult(ctx, 'work_sheet_types.edit')");
    expect(IPC, 'чтение остаётся правом истории').toContain("requirePermOrResult(ctx, 'operations.view')");
    expect(IPC, 'erp.dictionary.edit больше не при чём').not.toContain('erp.dictionary.edit');
    for (const ch of ['workSheets:rows:save', 'workSheets:rows:delete', 'workSheets:types:upsert']) {
      expect(GATE, `наблюдателю раздела запись ${ch} закрыта`).toContain(`'${ch}'`);
    }
    // Виды работ — REST: гейт клиента без такого же гейта на сервере означал бы, что
    // выданное поимённо право работает до первого сохранения, а потом сервер отвечает отказом.
    expect(REST_ROUTE, 'серверный роут видов работ — то же право, что и IPC').toContain(
      'requirePermission(PermissionCode.WorkSheetTypesEdit)',
    );
    expect(REST_ROUTE, 'право строк на справочник не распространяется').not.toContain('PermissionCode.WorkSheetsEdit)');
    expect(REST_ROUTE, 'чтение справочника остаётся правом истории').toContain(
      'requirePermission(PermissionCode.OperationsView)',
    );
  });

  // Роль admin получает «всё» циклом, и без точечного исключения любой администратор снова
  // молча редактировал бы этапы работ — а владелец снял право у всех, чтобы выдавать поимённо.
  it('роль не даёт прав на этапы работ никому, кроме суперадмина; сервер режет строку без права', () => {
    expect(BACKEND_PERMS).toContain("all[PermissionCode.WorkSheetsEdit] = r === 'superadmin';");
    expect(BACKEND_PERMS).toContain("all[PermissionCode.WorkSheetTypesEdit] = r === 'superadmin';");
    // Строка этапа работ идёт обычным синком: клиентский гейт без серверного — не гейт.
    expect(SYNC_GUARD, 'backstop до обхода для admin / легаси user').toContain("reason: 'forbidden:work_sheet_row'");
    expect(SYNC_GUARD.indexOf("forbidden:work_sheet_row"), 'backstop стоит ДО ветки !operatorScoped').toBeLessThan(
      SYNC_GUARD.indexOf('if (!operatorScoped) {'),
    );
  });

  it('домен этапов работ подключён и на планшете — плитка без IPC открывалась и молчала', () => {
    expect(ANDROID_WIRING).toContain('registerWorkSheetsIpc(ctx);');
  });

  // Шаблон единого списка этапов (план unified-repair-stages, шаг 5b): своё поимённое
  // право, свой REST, приоритет — порядком (мышь или стрелки), код после создания frozen.
  it('шаблон этапов — отдельное право и отдельный REST, приоритет двигается порядком', () => {
    expect(APP, 'шаблон — своё право, не то же, что строки').toContain('canManageStageTemplates={caps.canEditRepairStageTemplates}');
    expect(IPC, 'запись шаблона — repair_stage_templates.edit').toContain("requirePermOrResult(ctx, 'repair_stage_templates.edit')");
    expect(STAGE_REST_ROUTE, 'серверный роут шаблона — то же право').toContain('requirePermission(PermissionCode.RepairStageTemplatesEdit)');
    expect(BACKEND_PERMS).toContain("all[PermissionCode.RepairStageTemplatesEdit] = r === 'superadmin';");
    expect(PAGE).toContain('data-repair-stage-edit-templates');
    expect(STAGE_DIALOG).toContain('data-stage-template-row={t.code}');
    expect(STAGE_DIALOG).toContain('data-stage-template-new');
    expect(STAGE_DIALOG).toContain('data-stage-template-save');
    expect(STAGE_DIALOG, 'приоритет — drag-and-drop, на планшете стрелки').toContain('onDrop');
    expect(STAGE_DIALOG).toContain('RowReorderButtons');
    expect(STAGE_DIALOG).toContain('window.matrica.workSheets.stages.templates.reorder(');
  });

  // Вкладки по видам работ разрезали экран на копии одного списка — каждая со своим
  // тулбаром, ступенями и раскладкой колонок. Отобрать одно значение умеет ступень.
  it('список ОДИН: вкладок нет, вид работ — колонка и ступень', () => {
    expect(PAGE, 'вкладки сняты').not.toContain('<CardTabs');
    expect(PAGE, 'вид работ — колонка списка').toContain("id: 'type', label: 'Вид работ'");
    expect(PAGE, 'ступени общие для всего списка, без полей отдельного вида').toContain('workSheetFacets([])');
    expect(PAGE, 'раскладка колонок одна на список, а не на вид').toContain("useColumnLayout('list:workSheets:columns'");
  });

  it('новый этап работ берёт вид из фильтра, а не первый из справочника', () => {
    expect(PAGE).toContain('const initialTypeCode = useMemo(');
    expect(PAGE).toContain('ui.facets?.[TYPE_FACET_ID]');
    expect(PAGE).toContain('initialTypeCode={initialTypeCode}');
  });

  // Шаг 8 плана unified-repair-stages (29.09.2026): сводка read-only — инлайн-редактор
  // снесён, заполнение только в карточке двигателя. Щелчок по строке открывает карточку
  // этапа (там же удаление и поля вида); кнопки «Добавить» нет вовсе.
  it('список — сводка: без редактора, щелчок открывает карточку этапа', () => {
    expect(PAGE, 'редактора нет').not.toContain('data-work-sheet-editor-row');
    expect(PAGE, 'полки нет').not.toContain('data-work-sheet-editor-actions');
    expect(PAGE, 'кнопки «Добавить» нет').not.toContain('data-work-sheet-add-row');
    expect(PAGE, 'состояния редактора нет').not.toContain('SheetEditor');
    expect((PAGE.match(/<VirtualTable/g) ?? []).length, 'таблица одна: две разъехались бы по ширинам').toBe(1);
    expect(PAGE, 'номера сквозные 1..N — служебных рядов больше нет').toContain('rowNumberOf={(i) => (sorted[i] ? i + 1 : null)}');
    expect(PAGE, 'строка кликабельна в карточку').toContain("'data-work-sheet-row': r.id,");
    expect(PAGE, 'карточка открывается вкладкой приложения').toContain('props.onOpenSheet(');
    expect(PAGE, 'служебных рядов нет: счётчик и печать берут выборку').toContain(
      'total={rows.length} shown={sorted.length}',
    );
    expect(APP, 'приложение не просит правку у сводки').not.toMatch(/<WorkSheetsPage[^>]*canEdit=/);
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

  // Бланка одного этапа работ НЕТ (владелец 17.09.2026, C6): этапы печатаются только
  // списками и отчётом движений двигателя. Кнопка «Распечатать» на карточке и её модель сняты;
  // вернувшийся `onPrint` в карточке — это возврат снятого решения, а не улучшение.
  it('карточка этапа работ не печатает бланк одного этапа', () => {
    expect(CARD).not.toContain('onPrint');
    expect(CARD).not.toContain('workSheetPrintModel');
    expect(CARD).not.toContain('openPrintPreview(');
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
      ['карточка этапа работ', CARD],
      ['редактор видов работ', TYPE_DIALOG],
    ] as const) {
      expect(withoutComments(text), `${name}: слово «узел» осталось на виду у оператора`).not.toMatch(/[Уу]зл|[Уу]зел/);
    }
  });

  // Этап работ пишется через main-сервис idempotent upsert'ом: правка идёт тем же id,
  // и это одна запись в истории ремонта, а не вторая строка. Новые строки заводятся только
  // карточкой (шаг 8: список id не генерирует).
  it('этап работ пишется через main-сервис тем же id, что открыл карточку', () => {
    expect(CARD).toContain('window.matrica.workSheets.rows.save(');
    expect(CARD, 'сохраняем ровно тот id, с которым карточку открыли').toContain('id: props.rowId,');
    expect(PAGE, 'список id не генерирует').not.toContain('crypto.randomUUID()');
    expect(CARD, 'этап работ не переезжает на другой двигатель и не меняет вид').toContain(
      'disabled={!props.canEdit || !props.isNew}',
    );
  });

  it('карточка этапа работ — вкладка со стандартной обвязкой, а не модальное окно', () => {
    expect(CARD).toContain('<EntityCardShell');
    expect(CARD, 'сохранить / сохранить и выйти / сброс / удалить / закрыть').toContain('<CardActionBar');
    expect(CARD, 'сторож несохранённого').toContain('props.registerCardCloseActions({');
    expect(APP, 'вид вкладки заведён и рисуется').toContain("{t === 'work_sheet' && selectedWorkSheetId && (");
    expect(APP, 'карточку не выкидывает гейт скрытых вкладок').toContain("tab === 'work_sheet' ||");
    expect(APP, 'вкладка восстанавливается из сессии').toContain("case 'work_sheet': return void openWorkSheet(entityId);");
    expect(APP, 'в шапке вкладки — не огрызок id').toContain("return known ? `📒 ${known}` : '📒 Этап работ';");
  });

  it('из карточки этапа работ можно уйти в двигатель', () => {
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

  it('правка без справочника видов работ: колонки восстанавливаются из полей самого этапа работ', () => {
    expect(CARD).toContain('const rowColumns = useMemo<WorkSheetColumn[]>(');
    expect(CARD, 'форма рисует восстановленный набор, а не только колонки вида').toContain('{columns.map((col) => (');
    expect(CARD, 'статус при правке не ставится — подставлять чужой completesRepair нельзя').toContain('completesRepair: false');
    expect(CARD, 'имя цеха уезжает снимком вместе с этапом работ').toContain(
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

// Ctrl+K (16.09.2026). Строка этапа работ лежит в локальной реплике `operations`: её не видит
// ни серверный /search (там другое пространство id), ни deep-поиск по `attribute_values`.
// Отсюда собственный узкий main-поиск на канале раздела «Производство» и своя группа в
// палитре. Сторожа ниже держат свойства этой развязки, а не её написание: переход по хиту,
// словарь C1, цену одной буквы, гейт, разбор ответа и невмешательство в чужие ярусы.
describe('этапы работ — Ctrl+K', () => {
  // Единственное место C4, не защищённое типами: `navigateToRoute` — цепочка `if` без
  // never-проверки и с фолбэком «переключить вкладку по id». Забытая ветка собирается и
  // проходит typecheck, а оператор по клику на хит уезжает на вкладку с uuid вместо карточки.
  it('переход по хиту знает вид: ветка стоит ДО фолбэка setTab', () => {
    const branch = APP.indexOf("route.kind === 'work_sheet'");
    const fallback = APP.indexOf('setTab(route.id as TabId);');
    expect(branch, 'navigateToRoute не знает вида work_sheet — клик по хиту уйдёт мимо карточки').toBeGreaterThan(0);
    expect(fallback, 'фолбэк navigateToRoute на месте — относительно него и меряем').toBeGreaterThan(0);
    expect(branch, 'ветка ниже фолбэка не выполнится никогда: фолбэк возвращает управление первым').toBeLessThan(
      fallback,
    );
    expect(APP, 'хит открывает карточку этапа работ, а не просто меняет вкладку').toContain(
      "return await openWorkSheet(route.id);",
    );
  });

  // Словарь C1: голое «этап» в программе занято тремя другими смыслами (стадия двигателя,
  // шаг мастера, ступень фильтра). Сторожим свойство — подпись группы называет сущность
  // целиком, — а не строку: «Этапы работ по двигателям» тест переживёт, «Этапы» нет.
  it('группа в палитре названа по словарю: «этапы работ», а не голое «Этапы»', () => {
    const at = GLOBAL_SEARCH.indexOf('const KIND_LABELS');
    expect(at, 'подписи видов глобального поиска на месте').toBeGreaterThan(0);
    const block = GLOBAL_SEARCH.slice(at, GLOBAL_SEARCH.indexOf('};', at));
    const label = /work_sheet: '([^']*)'/.exec(block)?.[1] ?? '';
    expect(label, 'у вида work_sheet нет подписи — заголовком группы стал бы код вида').not.toBe('');
    expect(label, 'заголовок группы обязан называть сущность целиком — «этап работ»').toMatch(/этап(ы)? работ/i);
  });

  // Цена одной буквы. `listWorkSheetRows` поднимает ВСЕ колонки до 20 000 строк (включая
  // meta_json), разбирает каждую мету и резолвит подписи двигателей по всей выборке вместе с
  // договорами и контрагентами — тот самый класс расхода, что однажды стоил main секунды на
  // нажатие. Поиск обязан остаться узким: дешёвая проверка сырого текста ДО разбора меты и
  // резолв подписей только по совпавшим строкам.
  it('поиск не читает список целиком: грубый отсев стоит раньше разбора меты', () => {
    const start = SERVICE.indexOf('export async function searchWorkSheetRows(');
    expect(start, 'main-поиск этапов работ пропал — палитра осталась без источника').toBeGreaterThan(0);
    const end = SERVICE.indexOf('\n}\n', start);
    const fn = SERVICE.slice(start, end > 0 ? end : SERVICE.length);
    expect(fn, 'поиск через полный список строк вернул бы расход списка на каждую букву').not.toContain(
      'listWorkSheetRows(',
    );
    expect(fn, 'в хите нужен номер двигателя — договоры и контрагенты это три лишних справочника').not.toContain(
      'withCounterparty',
    );
    const rough = fn.search(/raw\w*\.(includes|indexOf|match|search)\(/);
    const parse = ['parseRepairHistoryMeta(', 'JSON.parse('].reduce((min, needle) => {
      const i = fn.indexOf(needle);
      return i >= 0 && i < min ? i : min;
    }, fn.length);
    expect(rough, 'грубого отсева по сырой мете нет — значит разбирается каждая из 20 000 строк').toBeGreaterThan(0);
    expect(rough, 'разбор меты раньше отсева — это полный парс всей выборки на каждую букву').toBeLessThan(parse);
  });

  // Имя канала здесь — часть гейта, а не косметика: секционный гейт требует раздел
  // «Производство» по префиксу `workSheets:`, и у префикса `search:` правила нет вовсе.
  it('канал поиска — под секционным гейтом «Производство» и под правом истории', () => {
    expect(IPC, 'поиск живёт в namespace этапов работ — по префиксу его и гейтят').toContain(
      "ipcMain.handle('workSheets:rows:search'",
    );
    expect(IPC, 'канал search:* оказался бы вне секционного гейта — палитра стала бы его обходом').not.toContain(
      "ipcMain.handle('search:",
    );
    expect(GATE, 'у префикса search: раздела нет — потому имя канала и держим в namespace этапов работ').not.toContain(
      "['search:'",
    );
    const at = IPC.indexOf("ipcMain.handle('workSheets:rows:search'");
    const next = IPC.indexOf('ipcMain.handle(', at + 1);
    const handler = IPC.slice(at, next > 0 ? next : IPC.length);
    expect(handler, 'чтение этапов работ — право истории операций, и поиск не исключение').toContain(
      "requirePermOrResult(ctx, 'operations.view')",
    );
  });

  // Грабля соседнего яруса: `safeList` в globalSearchSources отдаёт [] на любой не-массив, и
  // источник, собранный по его образцу, молча давал бы ноль хитов навсегда — форма ответа
  // канала другая. Эффект обязан разбирать именно её: сначала признак успеха, потом хиты.
  it('ответ канала разбирается по форме {ok, hits} — молчаливый ноль невозможен', () => {
    expect(OVERLAY, 'отказ по праву и ошибка гасят группу осознанно, а не мимо разбора ответа').toContain(
      'setSheetHits(res?.ok ? res.hits : [])',
    );
  });

  // Deep-поиск (L2.5) ходит ТОЛЬКО в `attribute_values`, а строка этапа работ лежит в
  // `operations`. Вид в DEEP_KINDS дал бы ноль попаданий и раздутый список entityIds на каждую
  // букву — поэтому его там нет намеренно, и это не забытая строка, которую надо «дописать».
  it('вид не подмешан в deep-поиск по EAV', () => {
    const at = OVERLAY.indexOf('const DEEP_KINDS');
    expect(at, 'набор видов deep-поиска на месте').toBeGreaterThan(0);
    const block = OVERLAY.slice(at, OVERLAY.indexOf('];', at));
    expect(block, 'этап работ живёт в operations — в EAV искать его нечем, попаданий будет ноль').not.toContain(
      "'work_sheet'",
    );
  });

  // Палитра открывается с пустым запросом, и все соседние наборы хитов на открытии гасятся.
  // Не сброшенный набор показал бы результат прошлого Ctrl+K под новым пустым вводом.
  it('хиты этапов работ сбрасываются при открытии палитры', () => {
    const at = OVERLAY.indexOf('if (!open) return;');
    const end = OVERLAY.indexOf('}, [open]);', at);
    expect(at, 'эффект открытия палитры на месте').toBeGreaterThan(0);
    expect(end, 'эффект открытия палитры замкнут на [open] — в нём и сбрасывают наборы').toBeGreaterThan(at);
    expect(OVERLAY.slice(at, end), 'повторный Ctrl+K показал бы хиты прошлого запроса').toContain('setSheetHits([]);');
  });

  // Полный дубль строки (один двигатель, один вид работ, один день) оператор завёл дважды
  // нажатой кнопкой — владелец 18.09.2026. Гейт не запрещает: двигатель реально возвращается
  // на тот же этап, и запрет обошли бы сдвигом даты. Свойства ниже держат ФОРМУ решения:
  // спрашивают обе двери, отказ не пишет строку, осознанный возврат виден в списке.
  it('дубль строки за один день спрашивают у оператора, а не режут молча', () => {
    expect(SERVICE, 'совпадения ищет main — ключ дубля лежит внутри meta_json').toContain('export async function listWorkSheetDuplicates');
    expect(SERVICE, 'день сравнивается по московской зоне, а не по равенству меток').toContain('isSameWorkSheetDay(at, args.atMs)');
    expect(SERVICE, 'удалённая строка дублем быть перестаёт').toContain('isNull(operations.deletedAt)');
    // Дверь записи осталась одна — карточка (шаг 8: список не пишет). Она обязана поднять
    // гейт: молча писала бы дубли дальше — ровно так у гейта сборочных нарядов однажды
    // нашлась третья непокрытая точка входа.
    expect(CARD, 'карточка: гейт дублей поднимается').toContain('askWorkSheetDuplicate(');
    expect(CARD, 'карточка: подтверждённый возврат уходит номером прохода').toContain('writeRow(decision.pass)');
    expect(PAGE, 'список не пишет — гейта дублей в нём нет').not.toContain('askWorkSheetDuplicate(');
    expect(PAGE, 'возврат подписан в списке — иначе отличие живёт только в базе').toContain('проход ${r.repeatPass}');
  });
});
