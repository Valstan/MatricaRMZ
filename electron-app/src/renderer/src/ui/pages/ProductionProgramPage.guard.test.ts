import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Переверстка модуля ПП (владелец 10.11.2026). Требования заказчика — «ширину на всю
// программу», «слева плашки программ, справа настройка открытой», «порядок полей:
// название → цех → период → статус», «поиск в выпадашках договоров и двигателей».
//
// Сторож по тексту, а не рендером: экран собирается из таблиц и компонентов, а проверять
// надо именно ПОРЯДОК и НАЛИЧИЕ (иначе следующая правка тихо вернёт «три поля дат
// наползли на название»).
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
}

const PAGE = src('./ProductionProgramPage.tsx');
const PREVIEW = src('../components/ProductionProgramPrintPreview.tsx');
const SIGNATURE_EDITOR = src('../components/PrintSignatureBlockEditor.tsx');
const PRINT_HTML = src('../utils/productionProgramPrintHtml.ts');
const ADD_BY_NUMBERS = src('../components/ProductionProgramAddEnginesByNumbersDialog.tsx');
const LIST_ACTIONS = src('../utils/listContextActions.ts');
const APP = src('../App.tsx');
const CSS = src('../global.css');
const SHARED_DOMAIN = src('../../../../../../shared/src/domain/productionProgram.ts');

describe('производственная программа — экран после переверстки', () => {
  it('модуль во всю ширину области контента', () => {
    // Без этого карточка ПП упиралась в общий потолок 1400px, а её секция — в 1200px.
    expect(PAGE).toContain('production-program-page');
    expect(CSS).toContain('.ui-content-viewport > .production-program-page');
    expect(CSS).toContain('--ui-content-block-max-width: 100%');
  });

  it('экран разделён на две части: слева плашки программ, справа настройка открытой', () => {
    expect(PAGE).toContain('Производственные программы');
    expect(PAGE).toContain('Строки плана');
    // Слева — плашки с датой и статусом, справа — редактор.
    expect(PAGE).toContain('formatProductionProgramPeriod');
    expect(PAGE).toContain('PROGRAM_STATUS_TONES');
  });

  it('порядок полей шапки: название → цех → период → статус', () => {
    // Заказ владельца дословно: «сперва название, потом выбор цеха, потом период,
    // потом статус программы». Порядок закреплён текстом — иначе он снова разъедется.
    const order = ['Название программы', 'Цех', 'Период', 'Период с', 'Период по', 'Статус программы'];
    const positions = order.map((label) => PAGE.indexOf(`'${label}'`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });

  it('период выбирается: вид периода и календарь в обе даты', () => {
    expect(PAGE).toContain('PRODUCTION_PROGRAM_PERIOD_LABELS');
    expect(PAGE).toContain('UnifiedDateInput');
    expect(PAGE).toContain("'Период с'");
    expect(PAGE).toContain("'Период по'");
  });

  it('поиск в выпадашках договоров и двигателей — тот же механизм, что в списках', () => {
    expect(PAGE).toContain('SearchSelect');
    expect(PAGE).toContain("'Договор'");
    expect(PAGE).toContain("'Двигатель'");
  });

  it('выбор двигателя подтягивает договор из карточки (поиски взаимозаменяемы)', () => {
    expect(PAGE).toContain('engine?.contractId');
  });

  it('«Организация» — живая подпись из карточки: заказчик и три цифры договора', () => {
    expect(PAGE).toContain('productionProgramOrganizationLabel');
    expect(SHARED_DOMAIN).toContain('shortContractSuffix');
  });

  it('строки плана сгруппированы по договорам', () => {
    expect(PAGE).toContain('groups');
    expect(PAGE).toContain('contractLabelById');
  });

  it('статус программы различается цветом плашки', () => {
    expect(PAGE).toContain("draft: { bg: '#f1f5f9'");
    expect(PAGE).toContain("approved: { bg: '#dcfce7'");
  });

  it('id строки плана — постоянный (черновой id ронял строку при сохранении)', () => {
    expect(PAGE).toContain('crypto.randomUUID()');
    // Черновой id собирался шаблонной строкой — именно её и не должно остаться.
    expect(PAGE).not.toContain('draft-${');
  });

  it('план следит за выполнением сам: счётчики на плашке', () => {
    // Владелец (10.11.2026): «план сам себя отслеживал, выполнение плана по статусам
    // двигателей… показывать, сколько двигателей ещё не собраны, невыполнены, сколько
    // выполнены».
    // Владелец (20.11.2026): колонка «Выполнение» убрана — движение двигателя видно
    // по колонке «Этап». Счётчики на плашке остались: они считаются по факту из карточки.
    expect(PAGE).toContain('productionProgramExecutionSummary');
    expect(PAGE).toContain('Собрано');
    expect(PAGE).toContain('Просрочено');
    expect(PAGE, 'колонка «Выполнение» убрана — движение видно по этапу').not.toContain('<th>Выполнение</th>');
    expect(SHARED_DOMAIN).toContain('export function productionProgramExecutionSummary');
  });

  it('«Печать» открывает превью, а не сразу принтер', () => {
    // Владелец (10.11.2026): «нужен промежуточный этап, чтобы можно было редактировать
    // форму печати галочками… при нажатии кнопки Печать сперва показывать превью».
    expect(PAGE).toContain('ProductionProgramPrintPreview');
    // Прямая печать мимо превью — значит, оператор снова увидит только окно принтера.
    expect(PAGE).not.toContain('openProductionProgramPrint');
    expect(PREVIEW).toContain('data-pp-print-preview');
    // Галочка «снять подпись» теперь в общем редакторе подписей (23.11.2026).
    expect(PREVIEW).toContain('PrintSignatureBlockEditor');
    expect(SIGNATURE_EDITOR).toContain('type="checkbox"');
    expect(PREVIEW).toContain('Подписи');
    expect(PREVIEW).toContain('Размеры шрифта');
    // Печатная форма умеет настраиваться: кегли и состав подписей.
    // Состав — слотами, а не должностями: должность оператор теперь меняет (23.11.2026).
    expect(PRINT_HTML).toContain('signatureSlots');
    expect(PRINT_HTML).toContain('signatureFontSize');
    expect(PRINT_HTML).toContain('tableFontSize');
  });
});

// Производственная программа (жалоба владельца 19.11.2026): двигатель, добавленный
// в план, ПРОПАДАЛ через несколько секунд. Причина клиентская: строки жили только
// в памяти (писала только кнопка «Сохранить»), а живое обновление реплики (15 с)
// перечитывало её целиком и затирало несохранённое.
//
// Скрепы ниже держат инвариант «правка не пропадает» написанием: если кто-то
// вернёт безусловную перезапись строк из реплики или уберёт автосохранение —
// тест покраснеет до того, как оператор потеряет двигатель из плана.
describe('производственная программа — правка строк не пропадает', () => {
  it('реплика не затирает несохранённую правку (гейт канона #1240)', () => {
    expect(PAGE, 'живое обновление обязано уважать несохранённые строки').toContain(
      'if (unsavedRef.current.has(selectedId) && local) {',
    );
  });

  it('ни одна правка строк не идёт в обход applyRows', () => {
    expect(
      PAGE,
      'правка строк в обход applyRows теряет и автосохранение, и защиту от реплики',
    ).not.toContain('setRows((prev)');
  });

  it('добавление двигателя идёт через общий путь правки', () => {
    expect(PAGE).toContain('applyRows((prev) => [...prev, newRow], selectedId);');
  });

  it('правка уходит на сервер сама, а не только кнопкой «Сохранить»', () => {
    expect(PAGE, 'нужен отложенный автосэйв строк').toContain(
      'autosaveTimerRef.current = window.setTimeout(',
    );
    expect(PAGE, 'отложенный автосэйв должен звать ту же дверь записи').toContain(
      'for (const [pid, snapshot] of pendingSaves) void persist(pid, snapshot);',
    );
  });

  it('уход со страницы не теряет отложенную правку', () => {
    expect(PAGE, 'таймер автосэйва обязан досылать правку').toContain(
      'for (const [pid, snapshot] of pendingSaves) void persist(pid, snapshot);',
    );
    expect(PAGE, 'размонтирование страницы обязано досылать правку').toContain(
      'for (const [pid, snapshot] of pendingSavesNow) void persist(pid, snapshot);',
    );
  });

  it('зеркало, отставшее на минуту, не перетирает только что сохранённое', () => {
    expect(PAGE).toContain('const mirrorCaughtUp = pending.sent.every((sig) => {');
    expect(PAGE, 'слепок строки — по значениям, а не только по id: правку ячейки зеркало ещё не показало').toContain(
      'return !!row && rowContentSignature(row) === sig;',
    );
    expect(PAGE, 'снятая нами строка в зеркале = зеркало ещё старое').toContain(
      'const removedStillInMirror = pending.removedIds.some((id) => replicaIds.has(id));',
    );
  });

  it('шапку, которую правят на экране, реплика тоже не затирает', () => {
    expect(PAGE).toContain('headerOverrideRef.current.set(selectedId, { ...override, ...changed });');
  });

  it('несохранённая правка видна оператору, а не молчит', () => {
    expect(PAGE).toContain('Правка не сохранена');
  });

  it('отказ сервера показывается текстом с номером строки', () => {
    expect(PAGE, 'ошибка записи должна уходить на экран').toContain('setError(res.error);');
  });

  it('автосэйв не снимает строку соседа, которой мы ещё не видели', () => {
    // Замена набора — полная: строка, которой нет в наборе, снимается на сервере.
    // Значит в набор обязаны попасть и те строки, что уже есть в реплике, но не
    // пришли к нам (другой компьютер). Снятые НАМИ строки при этом исключены.
    expect(PAGE).toContain('!known.has(String(l.id)) && !removed.includes(String(l.id))');
  });
});

/**
 * Подписи ПП не теряются при синхронизации (жалоба владельца 24.11.2026:
 * «подписи то появляются, то исчезают», «с сервером долго синхронизируется»).
 *
 * Два независимых дефекта, оба закрыты здесь:
 *  1. сравнение «зеркало догнало мою правку» перечисляло поля поимённо и
 *     подписей в списке не было ⇒ правка подписей терялась на экране, как
 *     только совпали остальные поля (класс M118);
 *  2. в PATCH уезжала вся шапка из реплики, а `signatureSlots: null` сервер
 *     трактует как «очистить подписи» ⇒ правка названия стирала подписи
 *     на сервере.
 */
describe('производственная программа — подписи не теряются при синхронизации', () => {
  it('сравнение «зеркало догнало» учитывает подписи', () => {
    expect(PAGE, 'подписи должны ждать своего зеркала, а не отпускаться вместе с шапкой').toContain(
      'override.signatureSlots !== undefined && (p.signatureSlots ?? null) !== override.signatureSlots',
    );
  });

  it('в PATCH уходят только те поля шапки, которые правил оператор', () => {
    expect(PAGE).toContain("if (dirty.has('signatureSlots')) {");
    expect(PAGE).toContain('args.signatureSlots = h.signatureSlots;');
    // Снимок шапки из реплики в PATCH ехать не должен: реплика отстаёт на
    // минуту, и её `null` по подписям стирал бы подписи на сервере.
    expect(PAGE, 'PATCH не должен нести снимок шапки из реплики').not.toContain('signatureSlots: h.signatureSlots,');
    expect(PAGE, 'PATCH не должен нести снимок шапки из реплики').not.toContain('workshopId: h.workshopId,');
  });

  it('правленые поля шапки помечены отдельно — по ним и собирается PATCH', () => {
    expect(PAGE).toContain('const headerDirtyRef = useRef<Map<string, Set<ProgramHeaderField>>>(new Map());');
    expect(PAGE).toContain('for (const field of Object.keys(changed) as ProgramHeaderField[]) dirty.add(field);');
  });

  it('отказ записи возвращает правку в очередь — и она уходит повторно', () => {
    expect(PAGE).toContain('requeueSave(programId, payload);');
    expect(PAGE).toContain('scheduleRetry();');
    expect(PAGE, 'очередь повтора должна звать ту же дверь записи').toContain(
      'for (const [pid, snapshot] of pendingSaves) void persist(pid, snapshot);',
    );
  });

  it('оператору сказано честно: сохранено на сервере, остальным — при синхронизации', () => {
    expect(PAGE).toContain('Сохранено на сервере. На остальные компьютеры придёт при синхронизации');
  });
});

/**
 * Порядок в производственной программе (промты КАРМАНА #48 + #49): перетаскивание
 * двигателей и групп, две нумерации, тон строки по факту из карточки.
 *
 * Скрепы держат три вещи, которые молча ломаются:
 *  1. порядок групп — по строкам (как в печати), а не по названию договора:
 *     иначе экран и печать показывают разный порядок и перетащить группу некуда;
 *  2. обе нумерации считаются по позиции (домен `productionProgramNumbering`),
 *     а не берутся из сохранённого `orderNo`;
 *  3. перетаскивание — только тем же путём записи (`applyRows` → `saveRows`).
 */
describe('порядок в производственной программе', () => {
  it('группы идут в порядке строк, а не по названию договора', () => {
    expect(PAGE, 'сортировка групп по названию возвращает экран к прежнему виду').not.toContain(
      'a.label.localeCompare(b.label',
    );
    expect(PAGE).toContain('return [...byKey.values()];');
  });

  it('две нумерации — общая и внутри договора, по позиции', () => {
    expect(PAGE).toContain('productionProgramNumbering(rows)');
    expect(PAGE).toContain('<th title="Сквозной номер по программе">№ п/п</th>');
    expect(PAGE).toContain('<th title="Номер двигателя внутри своего договора">№ в договоре</th>');
    expect(PAGE).toContain('num?.global ??');
    expect(PAGE).toContain('num?.inContract ??');
  });

  it('перетаскивание: двигатель — в пределах договора, группа — целиком', () => {
    expect(PAGE).toContain('productionProgramMoveRowWithinGroup(current, sourceRowId, targetRowId, side)');
    expect(PAGE).toContain('productionProgramMoveGroup(current, sourceGroupKey, targetGroupKey, side)');
    expect(PAGE).toContain("kind: 'row'");
    expect(PAGE).toContain("kind: 'group'");
  });

  it('после перетаскивания правка уходит той же дверью записи', () => {
    expect(PAGE, 'перетаскивание — это правка строк, значит тот же applyRows').toContain(
      'applyRows(() => next, selectedId);',
    );
  });

  it('тон строки — доменное правило по факту из карточки', () => {
    expect(PAGE).toContain('productionProgramRowTone(engine, r.operatorNote)');
    // Тон кладётся в фон строки; синий выбор выделения накладывается ПОСЛЕ него
    // (так же, как в остальных списках программы).
    expect(PAGE).toContain('...(tone.background ? { background: tone.background } : {}),');
    expect(PAGE).toContain("...(isSelected ? { background: 'rgba(37, 99, 235, 0.14)' } : {}),");
  });

  it('печатная форма остаётся по образцу: шесть колонок, вторая нумерация — на бумаге', () => {
    // Промт КАРМАНА #104 (24.11.2026): «нумерация по контрактам пропадает при печати».
    // Решение владельца от ноября 2026 («вторую нумерацию в печать не добавляем») —
    // ПЕРЕВЁРНУТО: номер внутри договора печатается составным в той же колонке
    // «№ п/п» («сквозной / внутри договора»), без седьмой колонки — образец и
    // полоса набора (271 мм) те же.
    expect(PRINT_HTML, 'в колонке «№ п/п» — составной номер').toContain('${row.orderNo} / ${row.inContractNo}');
    expect(PRINT_HTML, 'пара чисел объяснена в шапке формы').toContain('сквозной / внутри договора');
    expect(SHARED_DOMAIN, 'модель печати несёт номер внутри договора').toContain('inContractNo: number;');
    expect(SHARED_DOMAIN, 'нумерация считается одной считалкой на все места').toContain(
      'productionProgramNumberingCounters',
    );
    expect(PRINT_HTML, 'колонки формы: этап вместо отгрузки и факторов').toContain("'Этап'");
    expect(PRINT_HTML).not.toContain('Факторы, влияющие на выполнение плана');
    expect(PRINT_HTML).not.toContain("'Отгрузка'");
  });
});

/**
 * Шов ПП с общим слоем кита (промт КАРМАНА #67, D-247).
 *
 * ПП была единственным списком программы, где перетаскивание было «своим»:
 * состояние жило в странице, подсветки перетаскиваемой строки не было, а
 * `onDragEnd` не стояло вовсе — отменённое перетаскивание оставляло страницу
 * «залипшей». Кит (`hooks/useListDrag.ts`) это закрывает, но только если ПП
 * берёт его, а не копит механику у себя.
 *
 * Скрепы ниже держат ровно это: состояние перетаскивания в ПП — из кита, строки
 * помечены (по ним кит считает место вставки), ручка — общая, а сопровождение
 * подчинено общей настройке программы.
 */
describe('ПП на общем ките списков', () => {
  it('состояние перетаскивания — из кита, а не своё в странице', () => {
    expect(PAGE, 'ПП должна брать перетаскивание из общего слоя кита').toContain('useListDrag');
    expect(PAGE, 'своего состояния перетаскивания в странице быть не должно — иначе «залипание» вернётся').not.toContain(
      "useState<{ kind: 'row' | 'group'; key: string } | null>",
    );
    // Сброс — на уровне документа, а не в обработчике строки: отмена (Esc) и
    // drop мимо строки тоже обязаны гасить состояние.
    expect(PAGE).toContain('dragLayer.drop(');
    expect(PAGE).toContain('dragLayer.overRow(');
  });

  it('строки и заголовки групп помечены — по ним кит считает место вставки', () => {
    expect(PAGE).toContain('data-list-row="true"');
    expect(PAGE).toContain('data-list-row-key={String(r.id)}');
    expect(PAGE).toContain('data-list-row-key={`${GROUP_ROW_PREFIX}${groupKey}`}');
  });

  it('ручка строки и группы — общая ручка кита, а не своя', () => {
    expect(PAGE).toContain('ListRowHandle');
    expect(PAGE, 'своя ручка ⠿ в ПП = разъезд с китом').not.toContain('⠿');
  });

  it('сопровождение перетаскивания — по общей настройке программы', () => {
    expect(PAGE, 'правила поведения списков берутся из общего источника').toContain('useListBehaviorSettings');
    expect(PAGE).toContain('listBehavior.dragVisual');
    expect(PAGE, 'цвет линии места вставки — из кита').toContain('LIST_DROP_INDICATOR_COLOR');
  });

  it('двигатель едет внутри своего договора, а группа — со своим блоком', () => {
    // Кит считает место вставки; «свой или чужой договор» решает домен.
    expect(PAGE).toContain('productionProgramMoveRowWithinGroup');
    expect(PAGE).toContain('productionProgramMoveGroup');
    expect(SHARED_DOMAIN).toContain('export function productionProgramMoveRowWithinGroup');
    expect(SHARED_DOMAIN).toContain('export function productionProgramMoveGroup');
  });

  it('группа встаёт между договорами, а не внутрь чужого блока', () => {
    // Внутри группы границы нет: блок двигается между договорами. Над заголовком —
    // «перед этой группой», над её строками — по половине строки (верхняя: перед,
    // нижняя: за блоком). Иначе переезд блока зависит от пикселя.
    expect(PAGE).toContain('groupDropTarget');
    expect(PAGE).toContain("isHeader ? ('before' as const) : side");
  });
});

/**
 * Ручная отметка оператора на строке плана (промты КАРМАНА #48 + #49).
 *
 * Владелец (20.11.2026) вернул колонку «Отметка» с экрана: в плане остались
 * «Этап» и «Примечание», а отдельный выпадающий список «особое внимание» —
 * лишний. Данные при этом НЕ выбрасываются: отметка остаётся в строке плана,
 * подсветка строки по ней работает, и вернуть колонку — одна правка.
 */
describe('отметка оператора в производственной программе', () => {
  it('колонки «Отметка» на экране нет', () => {
    expect(PAGE).not.toContain('Отметка оператора: особое внимание');
    expect(PAGE).not.toContain('PRODUCTION_PROGRAM_OPERATOR_MARKS.map');
  });

  it('отметка остаётся в данных строки и в подсветке', () => {
    // Слепок строки отметку включает — иначе живое обновление реплики (15 с)
    // снимет её с экрана (тот же класс, что «двигатель пропадал через 15 секунд»).
    expect(PAGE).toContain("String(row.operatorNote ?? ''),");
    expect(PAGE).toContain('productionProgramRowTone(engine, r.operatorNote)');
    expect(SHARED_DOMAIN).toContain('export function productionProgramRowTone(');
    expect(SHARED_DOMAIN).toContain('PRODUCTION_PROGRAM_ATTENTION_BACKGROUND');
  });
});

/**
 * Колонка «Этап» в производственной программе (владелец 20.11.2026).
 *
 * Заказ: «в производственной программе, в таблицу, в список добавить колонку —
 * этап, на каком этапе сейчас находится двигатель. Это берётся из карточки
 * двигателя, из истории его ремонта, и вписывается самый последний статус».
 *
 * Скрепы держат три вещи, которые молча ломаются:
 *  1. этап читается из ЖИВОЙ карточки, а не из снимка строки плана;
 *  2. смена этапа пишет ПОЛНОСТЬЮ — как строку истории ремонта (общим путём с
 *     карточкой), а не «статус в плане»;
 *  3. срок по плану не потерян вместе с колонкой «Отгрузка» — он в модалке.
 */
describe('колонка «Этап» в производственной программе', () => {
  it('колонка «Этап» есть, а убранных колонок нет', () => {
    expect(PAGE).toContain('<th title="На каком этапе сейчас двигатель — из истории ремонта">Этап</th>');
    expect(PAGE).not.toContain('<th>Отгрузка</th>');
    expect(PAGE).not.toContain('<th>Факторы</th>');
    expect(PAGE).not.toContain('<th>Выполнение</th>');
  });

  it('этап читается из живой карточки двигателя', () => {
    expect(PAGE).toContain('productionProgramEngineStage(engine)');
    expect(PAGE).toContain('productionProgramStageOptions(stageTemplates, null)');
    expect(SHARED_DOMAIN).toContain('export function productionProgramEngineStage(');
    expect(SHARED_DOMAIN).toContain('export function productionProgramStageOptions(');
    expect(SHARED_DOMAIN).toContain('export function productionProgramStageNeighbours(');
  });

  it('смена этапа идёт через модалку с полями этапа', () => {
    expect(PAGE).toContain('ProductionProgramStageDialog');
    const DIALOG = src('../components/ProductionProgramStageDialog.tsx');
    // Поля этапа: дата завершения, цех, примечание — как в карточке двигателя.
    expect(DIALOG).toContain('Дата завершения этапа');
    expect(DIALOG).toContain('Примечание к этапу');
    expect(DIALOG).toContain('Срок по плану (дата отгрузки)');
    // Следующий/предыдущий этап — заказ владельца: «выбрать другой этап, следующий
    // или предыдущий».
    expect(DIALOG).toContain('Следующий этап');
    expect(DIALOG).toContain('Предыдущий этап');
  });

  it('этап пишется в историю ремонта общим путём с карточкой', () => {
    // Не «статус в плане»: та же дверь `workSheets:stages:save`, что и в карточке
    // двигателя, — со всеми гейтами (субординация дат, дубль за день, возврат).
    expect(PAGE).toContain('window.matrica.workSheets.stages.save({');
    expect(PAGE).toContain("window.dispatchEvent(new Event('matrica:engines-changed'));");
  });

  it('срок по плану не потерян вместе с колонкой «Отгрузка»', () => {
    // Срок живёт в строке плана (`shippingPlanAt`) и пишется тем же путём, что
    // любая правка строки, — иначе счётчики «В срок / Просрочено» стали бы нулём.
    expect(PAGE).toContain('shippingPlanAt: deadline');
    expect(SHARED_DOMAIN).toContain('export function productionProgramExecutionSummary');
  });
});

/**
 * Добавление двигателей списком, блок «Требует данных» с автопереездом, клик в
 * карточку и контекстное меню (промты КАРМАНА #64 + #65, ответы владельца #66 → D-246).
 *
 * Скрепы держат вещи, которые молча ломаются:
 *  1. разбор номеров — общий с пакетным приёмом (своя грамматика номеров разойдётся);
 *  2. проблемная строка живёт в блоке «Требует данных» и уезжает в свой договор
 *     САМА — по смене `contractId`/`groupLabel`, без новых таблиц;
 *  3. причина проблемы едет в примечание — и в печать (значит, печать не правим);
 *  4. перепроверка пишет только при реальном изменении — иначе каждое открытие
 *     программы пишет в сервер и перебивает правку оператора;
 *  5. добавление списком не сносит строку, добавленную другим оператором.
 */
describe('производственная программа — добавление списком и работа со строками', () => {
  it('разбор номеров — общий с пакетным приёмом, свой парсер не заводим', () => {
    expect(ADD_BY_NUMBERS).toContain('parseEngineBulkIntake');
    expect(ADD_BY_NUMBERS).toContain('productionProgramEngineMatch');
  });

  it('по каждому номеру видна проблема, у строки есть галочка, кнопка — одна внизу', () => {
    expect(ADD_BY_NUMBERS).toContain('productionProgramEngineProblem');
    expect(ADD_BY_NUMBERS).toContain('type="checkbox"');
    expect(ADD_BY_NUMBERS).toContain('Добавить в производственную программу');
    // Причина видна рядом с номером, а не в тексте ошибки.
    expect(ADD_BY_NUMBERS).toContain('row.reason');
  });

  it('проблемная строка живёт в блоке «Требует данных», причина — в примечании', () => {
    expect(ADD_BY_NUMBERS).toContain('PRODUCTION_PROGRAM_PENDING_GROUP_LABEL');
    expect(ADD_BY_NUMBERS).toContain('note: row.reason');
    expect(SHARED_DOMAIN).toContain("export const PRODUCTION_PROGRAM_PENDING_GROUP_LABEL = 'Требует данных';");
    // Никаких новых таблиц и атрибутов: временный блок = существующая группа.
    expect(SHARED_DOMAIN).not.toContain('production_program_pending');
  });

  it('переезд — смена договора и подписи группы, ключ группы считается из них', () => {
    expect(SHARED_DOMAIN).toContain('export function productionProgramResolvePendingRows');
    expect(SHARED_DOMAIN).toContain('next.contractId = String(engine.contractId);');
    expect(SHARED_DOMAIN).toContain('next.groupLabel = label;');
    expect(SHARED_DOMAIN).toContain('export function productionProgramGroupKey');
  });

  it('перепроверка — и при открытии программы, и кнопкой, и только при реальном изменении', () => {
    expect(PAGE).toContain('recheckPending');
    expect(PAGE).toContain('data-pp-action="recheck"');
    expect(PAGE).toContain('void recheckPending();');
    // Запись — только через applyRows (одна дверь) и только при изменении.
    expect(PAGE).toContain('if (!result.changed) {');
    expect(PAGE).toContain('applyRows(() => result.rows, programId);');
  });

  it('добавление списком мержит серверные строки — чужую строку не сносим', () => {
    expect(PAGE).toContain('productionProgramMergeRows');
    expect(SHARED_DOMAIN).toContain('export function productionProgramMergeRows');
    // Модалка читает строки плана с сервера: реплика отстаёт на минуту.
    expect(ADD_BY_NUMBERS).toContain('window.matrica.productionProgram.get(props.programId)');
  });

  it('клик по двигателю открывает карточку', () => {
    expect(PAGE).toContain('onOpenEngine');
    expect(PAGE).toContain('data-pp-open-engine');
    expect(APP).toContain('onOpenEngine={(id: string) => void openEngine(id)}');
  });

  it('выделение строк и контекстное меню: печать, копия, почта', () => {
    expect(PAGE).toContain('useListSelection');
    expect(PAGE).toContain("persistKey: 'list:production-program:selection'");
    // Без маркера корня клик по таблице гасит выделение.
    expect(PAGE).toContain('data-list-root="true"');
    expect(PAGE).toContain('ListContextMenu');
    // Подписи печати и копии — общие, из кита: страница берёт готовое объявление.
    expect(PAGE).toContain('listPrintAction');
    expect(PAGE).toContain('listCopyAction');
    expect(LIST_ACTIONS).toContain('Распечатать выделенные');
    expect(LIST_ACTIONS).toContain('Скопировать выделенные');
    // Почта — объявляемое действие самой страницы (в ките своего шаблона нет).
    expect(PAGE).toContain('Отправить почтой');
  });

  it('строка без шапки группы на сервер не уходит — она ждёт в блоке', () => {
    // Сервер отвергает весь набор строк, если шапка группы пустая (замена набора
    // полная) — значит, пустая подпись уехать не должна никогда.
    expect(ADD_BY_NUMBERS).toContain('PRODUCTION_PROGRAM_NO_CONTRACT_NUMBER_NOTE');
    expect(ADD_BY_NUMBERS).toContain('contractLabelOf');
    // Подпись группы — от страницы: её снимок в модалке отставал от страницы.
    expect(PAGE).toContain('contractLabelOf={(engine) => contractLabelById.get(String(engine.contractId ?? \'\')) ?? \'\'}');
  });

  it('состав плана меняется только по праву ведения плана', () => {
    expect(PAGE).toContain('Убрать из программы');
    expect(PAGE).toContain('props.canEdit ? 10 : 9');
  });
});

/**
 * Меню ПП — по общему киту, из объявления действий (промт КАРМАНА #67, D-247).
 *
 * ПП была последним списком программы, чьё меню собиралось руками: свои подписи,
 * свои счётчики и «Открыть карточку», которое у строки без двигателя гасилось
 * серым. Заказ владельца — «меню = ровно то, что список умеет»: недоступного
 * пункта не должно быть вовсе, а новое действие списка обязано попадать в меню
 * само. Правило одно на всю программу ⇒ меню ПП собирает общий сборщик.
 */
describe('меню ПП — из объявления действий кита', () => {
  it('меню собирает общий сборщик кита, а не страница руками', () => {
    expect(PAGE, 'меню ПП обязано собираться общим сборщиком кита').toContain('buildListContextMenuItems');
    expect(PAGE, 'своя сборка пунктов в странице = разъезд с китом').not.toContain(
      'const items: ListContextMenuItem[] = []',
    );
    // Старые ручные пункты — их больше нет.
    expect(PAGE).not.toContain("'pp-print-selected'");
    expect(PAGE).not.toContain("'pp-print-row'");
    expect(PAGE).not.toContain("'pp-copy-row'");
    expect(PAGE).not.toContain("'pp-remove-row'");
    expect(PAGE).not.toContain("'pp-clear-selection'");
  });

  it('недоступный пункт ОТСУТСТВУЕТ, а не гасится серым', () => {
    // У строки без двигателя карточки нет — пункта «Открыть карточку» быть не
    // должно, а не «серая кнопка, которая ничего не делает».
    expect(PAGE, 'гасящий серым пункт — враньё списка о самом себе').not.toContain('disabled: !engineId');
    expect(PAGE, 'доступность действия объявляется, а не гасится').toContain(
      'available: Boolean(menuRows[0]?.engine?.id)',
    );
  });

  it('«почта» и «убрать из программы» — объявляемые действия', () => {
    expect(PAGE).toContain("id: 'pp-mail'");
    expect(PAGE).toContain('Отправить почтой');
    // Убрать из программы — по праву ведения плана: нет права ⇒ нет пункта.
    expect(PAGE).toContain('available: canEdit');
    expect(PAGE).toContain('danger: true');
  });

  it('«выделить» и «снять выделение» — из кита, а не своими пунктами', () => {
    expect(PAGE).toContain('onSelect: selection.toggleSelect');
    expect(PAGE).toContain('onClearSelection: selection.clearSelection');
    expect(PAGE).toContain('hasSelection: selection.selectedCount > 0');
  });

  it('печать и копия — общие объявления кита, свои подписи у страницы нет', () => {
    expect(PAGE).toContain('listPrintAction');
    expect(PAGE).toContain('listCopyAction');
    // Счётчик пачки и слово «выделенные» — из кита, у страницы их быть не должно.
    expect(PAGE, 'счётчик выделенных — общее правило кита').not.toContain('выделенные (${count})');
  });
});
