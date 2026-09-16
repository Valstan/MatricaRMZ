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
const PRINT_MODEL = src('../utils/workSheetPrintModel.ts');
const REST_ROUTE = src('../../../../../../backend-api/src/routes/workSheetTypes.ts');
const BACKEND_PERMS = src('../../../../../../backend-api/src/auth/permissions.ts');
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
  it('строки и виды работ — два отдельных права, и раздельный уровень у секционного гейта', () => {
    // Проверяем пропы по отдельности: разметка многострочная, и непрерывная подстрока
    // ломалась бы от любого переноса, а не от потери права.
    expect(APP, 'строки — work_sheets.edit').toContain('canEdit={caps.canEditWorkSheets}');
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

  // Владелец 15.09 (вечер) и 16.09.2026: «прямо в списке появлялась новая чистая строка, и мы
  // в ней всё забивали», а записанную строку правим щелчком по ней самой — отдельное окно с
  // вертикальной формой «иногда не совсем удобно». Редактор — ряды ТОЙ ЖЕ виртуальной таблицы
  // и тот же main-сервис, что у карточки; карточка осталась дверью в удаление и откат
  // «Отремонтирован». Ассерты ниже держат свойства, а не написание: одна таблица, номера без
  // дыр, один путь записи, один редактор на экран, карточка достижима.
  it('этап работ заводится И правится строкой в самом списке', () => {
    expect(PAGE, 'редактор строки размечен').toContain('data-work-sheet-editor-row');
    expect(PAGE, 'полка с кнопками — отдельный ряд под редактором').toContain('data-work-sheet-editor-actions');
    // colSpan считается по видимым колонкам плюс филлер: ячейку «№» VirtualTable рисует сам, и
    // в colSpan она не входит. В хвостовой ячейке кнопки уехали бы за правый край таблицы.
    expect(PAGE, 'кнопки — в полноширинной строке, а не в хвостовой ячейке').toMatch(
      /colSpan=\{[^}]*visibleColumns\.length[^}]*\+ 1\}/,
    );
    expect((PAGE.match(/<VirtualTable/g) ?? []).length, 'таблица одна: две разъехались бы по ширинам').toBe(1);
    // Рядов стало три вида, и пара «редактор + полка» встаёт в середину списка. Допущение
    // «служебный ряд один и он сверху» на этом ломается — его место заняла чистая функция,
    // а свойство «номера 1..N без дыр» проверяет отдельный unit-тест модели рядов.
    expect(PAGE, 'ряды списка собирает одна чистая функция').toContain('buildWorkSheetListItems(sorted, editor)');
    expect(PAGE, 'индексной арифметики «минус служебный ряд» больше нет').not.toMatch(/sorted\[[^\]]*\?\s*i\s*-\s*1/);
    expect(PAGE, 'номер несёт сам ряд, а не формула по индексу').toMatch(/rowNumberOf=\{\(i\) =>/);
    expect(PAGE, 'у полки номера нет, у правки — свой номер строки').toContain(
      "it.kind === 'actions' ? null : it.number",
    );
    expect(
      PAGE.split('window.matrica.workSheets.rows.save(').length - 1,
      'создание и правка — один путь записи: со вторым разъедется и оповещение об изменении двигателя',
    ).toBe(1);
    expect(
      PAGE.split("window.dispatchEvent(new Event('matrica:engines-changed'));").length - 1,
      'один путь сохранения — один dispatch: забытый оставит отчёт «Двигатели на заводе» на вчерашней стадии',
    ).toBe(1);
    expect(PAGE, 'Esc убирает редактор').toContain("e.key === 'Escape'");
    expect(PAGE, 'Enter из открытого списка двигателей не сохраняет').toContain("e.key === 'Enter' && !e.defaultPrevented");
    expect(
      (PAGE.match(/onKeyDown: editorKeyDown/g) ?? []).length,
      'Esc/Enter работают и из полки: общей обёртки у двух <tr> не бывает',
    ).toBe(2);
    expect(PAGE, 'кнопка «Добавить» на месте').toContain('data-work-sheet-add-row');
    expect(PAGE, 'второй редактор не заводится ни новым, ни правкой').toContain(
      'disabled={editor !== null || types.length === 0}',
    );
    expect(PAGE, 'щелчок по строке правит её на месте, и курсор встаёт в кликнутую колонку').toMatch(
      /beginEdit\(r, colIdFromEvent/,
    );
    expect(PAGE, 'без права — read-only карточка, а не мёртвый редактор').toMatch(
      /props\.canEdit[\s\S]{0,400}beginEdit[\s\S]{0,400}openRow\(r\)/,
    );
    expect(PAGE, 'путь в карточку не исчез: удаление и откат «Отремонтирован» живут только там').toContain(
      'data-work-sheet-open-card',
    );
    expect(PAGE, 'карточка открывается вкладкой приложения').toContain('props.onOpenSheet(');
    // Вид работ и двигатель у записанной строки — ТЕКСТ, а не редактор: поля пересобираются
    // строго по присланным колонкам (смена вида молча превратила бы строку в другой этап с
    // пустыми полями), а перевесить строку на другой двигатель сервис и так отказывается.
    expect(PAGE, 'вид работ у записанной строки заморожен').toMatch(
      /case 'type':[\s\S]{0,400}return base \? \(\s*base\.typeName/,
    );
    expect(PAGE, 'двигатель у записанной строки заморожен').toMatch(
      /case 'engine':[\s\S]{0,400}return base \? \(\s*engineLabel\(base\)/,
    );
    // «Отремонтирован» ставится один раз, при создании строки: правкой его нельзя ни поставить,
    // ни снять, и обещать это в правке было бы враньём.
    expect(PAGE, 'правка не ставит и не снимает статус двигателя').toContain('completesRepair: false');
    expect(PAGE, 'обещание «Завершает ремонт» — только у нового этапа работ').toMatch(
      /!base && liveType\?\.completesRepair[\s\S]{0,200}data-work-sheet-completes-hint/,
    );
    // Колонки правки — живой справочник плюс коды, которых в виде уже нет: без них правка
    // примечания стёрла бы значения удалённых колонок. Набор один и тот же на экране и в
    // записи — два разных разъехались бы на первой же правке.
    expect(PAGE, 'колонки, удалённые из вида, переживают правку').toContain('mergeWorkSheetColumns(');
    expect(PAGE, 'на экране — тот самый набор колонок').toContain('editorColumns.map((c) => (');
    expect(PAGE, 'и в запись уходит он же').toContain('columns: editorColumns,');
    expect(PAGE, 'без справочника цехов имя цеха берётся из снимка строки, а не обнуляется').toContain(
      '(base && ed.workshopId === base.workshopId ? base.workshopName || null : null)',
    );
    expect(PAGE, 'пустой редактор списку не мешает, набранное — замораживает обновление до сохранения').toContain(
      'enabled: editor === null || !editor.dirty',
    );
    expect(PAGE, 'у первой колонки данных есть вид — иначе полноширинная полка раздует «Дату» в компактном режиме').toContain(
      "id: 'at', label: 'Дата', kind: 'date'",
    );
    expect(PAGE, 'служебные ряды строятся поверх выборки: счётчик и печать остаются честными').toContain(
      'total={rows.length} shown={sorted.length}',
    );
    expect(PAGE, 'выбор двигателя — тем же полем, что в карточке').toContain('target="engine"');
    expect(PAGE, 'каталог двигателей приходит из приложения').toContain('engines: EngineListItem[];');
    expect(APP, 'приложение отдаёт каталог списку').toMatch(/<WorkSheetsPage[\s\S]{0,300}engines=\{engines\}/);
    // Редактор поля вида и опции двигателя — общие: две копии разошлись бы на первой новой колонке.
    for (const [name, text] of [['список', PAGE], ['карточка', CARD]] as const) {
      expect(text, `${name}: общий редактор поля вида`).toContain("from '../components/WorkSheetFieldEditor.js'");
      expect(text, `${name}: общие опции двигателя`).toContain('buildEngineSearchOptions(props.engines)');
    }
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

  // Печать бланка одного этапа работ — соседняя дверь к тем же граблям плюс своя: в репозитории
  // уже лежит ПАРАЛЛЕЛЬНЫЙ стек печати (`engineInventoryPrintHtml.ts`) со своим escapeHtml, своими
  // стилями и своим опенером окна. Скопировать его — завести ТРЕТИЙ и вернуть M11: в окне
  // `window.open` + `document.write` inline-script не исполняется, и обход этого живёт внутри
  // `printPreview.ts`. Потому карточка только СОБИРАЕТ модель, а окно открывает общий механизм.
  it('бланк этапа работ печатается общим механизмом, а кнопка закрыта новизной и планшетом', () => {
    expect(CARD, 'бланк собирает отдельная модель — склейка HTML на месте снова спрятала бы печать внутрь страницы, где её ничем не проверить').toContain(
      'buildWorkSheetPrintModel(',
    );
    expect(CARD, 'окно предпросмотра открывает общая печать, а не карточка').toContain('openPrintPreview(');
    expect(CARD, 'свой опенер окна — третий стек печати и возврат M11: inline-script в document.write-окне не исполняется').not.toContain(
      'window.open(',
    );
    expect(CARD, 'копия печати двигателя принесла бы вторые escapeHtml, стили и опенер окна').not.toContain(
      'engineInventoryPrintHtml',
    );
    // Условие показа читаем целиком: у нового этапа работ печатать ещё нечего (записи нет),
    // а на планшете печати нет вовсе — то же правило, что у печати списка выше.
    const at = CARD.indexOf('onPrint');
    expect(at, 'кнопка печати пропала с полосы действий карточки').toBeGreaterThan(0);
    const condStart = CARD.lastIndexOf('{...(', at);
    expect(condStart, 'проп onPrint выдаётся безусловно — условия показа кнопки нет вовсе').toBeGreaterThan(0);
    const cond = CARD.slice(condStart, at);
    expect(cond, 'у нового этапа работ печатать ещё нечего — кнопка обязана ждать сохранения').toContain(
      '!props.isNew',
    );
    expect(cond, 'на планшете печати нет — как у всех списков и карточек').toContain('!isAndroidPlatform()');
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
      // Бумага живёт дольше экрана: подпись бланка уходит в архив и в чужие руки, и словарю
      // она подчиняется ровно так же. Набросок программы звал эту таблицу «полями узла».
      ['печатный бланк этапа работ', PRINT_MODEL],
    ] as const) {
      expect(withoutComments(text), `${name}: слово «узел» осталось на виду у оператора`).not.toMatch(/[Уу]зл|[Уу]зел/);
    }
  });

  // Этап работ пишется по id, который сгенерировал список: карточка нового открывается
  // сразу, а запись появляется только по «Сохранить» — пустых этапов работ не остаётся.
  // Правка идёт тем же id: это upsert одной записи, а не вторая строка в истории ремонта.
  it('этап работ пишется через main-сервис тем же id, что открыл карточку', () => {
    expect(CARD).toContain('window.matrica.workSheets.rows.save(');
    expect(CARD, 'сохраняем ровно тот id, с которым карточку открыли').toContain('id: props.rowId,');
    expect(PAGE, 'id нового этапа работ даёт список').toContain('crypto.randomUUID()');
    expect(PAGE, 'правка сохраняет тот же id строки').toContain('id: ed.id,');
    expect(PAGE, 'новый id — только у нового этапа работ').toMatch(
      /base: null[\s\S]{0,200}crypto\.randomUUID\(\)|crypto\.randomUUID\(\)[\s\S]{0,200}base: null/,
    );
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
});
