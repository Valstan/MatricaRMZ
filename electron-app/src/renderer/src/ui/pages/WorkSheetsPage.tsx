import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  HUMAN_LABEL_DASH,
  HUMAN_LABEL_NO_NUMBER,
  applyFacets,
  mergeWorkSheetColumns,
  workSheetFacets,
  workSheetFieldsSummary,
  type EngineListItem,
  type FacetDescriptor,
  type FacetSelection,
  type WorkSheetColumn,
  type WorkSheetRow,
  type WorkSheetType,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { ColumnToggleButton } from '../components/ColumnToggleButton.js';
import { EntityReferenceField } from '../components/EntityReferenceField.js';
import { FacetFilter, FacetToggleButton } from '../components/FacetFilter.js';
import { Input } from '../components/Input.js';
import { UnifiedDateInput } from '../components/UnifiedDateInput.js';
import { WorkSheetFieldEditor, fromWorkSheetDateInput, toWorkSheetDateInput } from '../components/WorkSheetFieldEditor.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { formatEngineGateLabel } from '../utils/assemblyDuplicateGate.js';
import { askWorkSheetDuplicate } from '../utils/workSheetDuplicateGate.js';
import { ListCount } from '../components/ListCount.js';
import { ListPrintDialog } from '../components/ListPrintDialog.js';
import { PageToolbar, ToolbarPin } from '../components/PageToolbar.js';
import { RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { SearchModeToggle, searchModeOf } from '../components/SearchModeToggle.js';
import { VirtualTable, type VirtualTableRowProps } from '../components/VirtualTable.js';
import { WorkSheetTypeEditorDialog, type WorkshopOption } from '../components/WorkSheetTypeEditorDialog.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { useListDeepFilter } from '../hooks/useListDeepFilter.js';
import { useListUiState } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { listCellKindProps, listHeaderKindProps, type ListColumnKind } from '../utils/listColumnKinds.js';
import { buildListPrintColumns } from '../utils/listPrintColumns.js';
import { buildEngineSearchOptions } from '../utils/selectOptions.js';
import { loadWorkSheetTypes, type WorkSheetTypesSource } from '../utils/workSheetTypesCache.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { isAndroidPlatform } from '../platform.js';

/**
 * Этапы работ — ОДИН список, как двигатели и контракты (владелец 15.09.2026).
 *
 * Вкладок по видам работ больше нет: они разрезали экран на копии одного и того же списка,
 * каждая со своим тулбаром, своими ступенями и своей раскладкой колонок, — а отобрать одно
 * значение умеет обычная ступень фильтра. Вид работы стал колонкой и ступенью.
 *
 * «Вид работ» — то, что раньше называлось узлом: укладка вала в картер, сборка, обкатка.
 * Слово сменилось по слову владельца: узлом в программе зовётся сборочная единица
 * (`warehouse.ts`, «№ узла сборки» в дефектовке), и два значения одного слова путали.
 *
 * Строки живут записями истории ремонта (`operations`, см. `workSheetService`), справочник
 * видов работ — серверный REST.
 *
 * Этап работ заводится И правится ПРЯМО В СПИСКЕ (владелец 15.09.2026 и 16.09.2026):
 * «Добавить» вставляет строку сверху, щелчок по записанной строке превращает её саму в
 * редакторы — двигатель, вид работ, дата, цех, поля вида, примечание, — а ПОД ней
 * раздвигается полка с «Сохранить» / «Отмена» по центру. Отдельное окно с вертикальной
 * формой «иногда не совсем удобно».
 *
 * Редактор — ряды той же виртуальной таблицы, а не вторая таблица сверху: ширины колонок
 * меряются по одной таблице (`useAdaptiveListTables`), две разъехались бы. Полка — ОТДЕЛЬНЫЙ
 * ряд, а не второй `<tr>` внутри одного индекса: `VirtualTable` рисует ровно один `<tr>` на
 * индекс, и чужой ряд не измерят и не отспейсерят — высоты поедут.
 *
 * Карточка-вкладка осталась и достижима кнопкой «Карточка ↗» из полки: только там живут
 * удаление строки с откатом «Отремонтирован», сторож несохранённого, переход «↗ Двигатель»,
 * восстановление вкладки после перезапуска и переход по ссылке приложения.
 */

type SheetEditor = {
  /** `null` — новый этап работ; иначе строка, из которой открыли редактор, и `id` равен её id. */
  base: WorkSheetRow | null;
  id: string;
  typeCode: string;
  engineId: string | null;
  date: string;
  workshopId: string;
  values: Record<string, unknown>;
  note: string;
  busy: boolean;
  error: string;
  /** Есть несохранённое: взводится любым изменением данных, гасит живое обновление списка. */
  dirty: boolean;
  /** Первый Esc с несохранённым только предупреждает; второй выбрасывает. */
  escArmed: boolean;
  /** Колонка, по которой щёлкнули: в неё и встанет курсор. */
  focusColId: string | null;
};

/** Поля редактора, которые считаются данными: их правка взводит `dirty`. */
const EDITOR_DATA_KEYS = ['typeCode', 'engineId', 'date', 'workshopId', 'values', 'note'] as const;

/**
 * Ряд списка. Редактор занимает ДВА соседних ряда — сам редактор и полка с кнопками, —
 * поэтому «где строка» больше не считается индексной арифметикой: до C2 допущение «служебный
 * ряд один и он сверху» было записано пятью выражениями подряд, и третий вид ряда ронял
 * `getRowKey` на `undefined.id`.
 */
type SheetItem =
  | { kind: 'row'; row: WorkSheetRow; number: number }
  | { kind: 'editor'; number: number | null }
  | { kind: 'actions' };

/**
 * Ряды списка = сортированные строки + пара рядов редактора. Служебные ряды строятся ПОВЕРХ
 * `sorted` и в него не попадают: счётчик «Всего · Показано» и печать берут те же данные и
 * остаются честными.
 */
export function buildWorkSheetListItems(sorted: readonly WorkSheetRow[], editor: SheetEditor | null): SheetItem[] {
  const items: SheetItem[] = [];
  let n = 0;
  let placed = false;
  for (const row of sorted) {
    // `!placed` — чтобы дубль id в выборке не породил вторую пару рядов редактора.
    if (!placed && editor?.base && editor.id === row.id) {
      placed = true;
      items.push({ kind: 'editor', number: ++n }, { kind: 'actions' });
      continue;
    }
    items.push({ kind: 'row', row, number: ++n });
  }
  // Новый — сверху. Туда же уезжает правка, если строка выпала из выборки (сменился период или
  // фильтр, её удалили на другом устройстве): иначе набранное исчезло бы молча. `unshift` идёт
  // ПОСЛЕ нумерации — номера настоящих строк остаются 1..N без дыр в обеих ветках.
  if (editor && !placed) items.unshift({ kind: 'editor', number: null }, { kind: 'actions' });
  return items;
}

type Column = ColumnDescriptor & {
  kind?: ListColumnKind;
  render: (r: WorkSheetRow) => React.ReactNode;
  sortValue?: (r: WorkSheetRow) => string | number;
  printValue?: (r: WorkSheetRow) => string;
};

type ListUiState = {
  query: string;
  searchSimilar: boolean;
  facets: FacetSelection;
  facetFields: string[];
  facetsOpen: boolean;
  sortKey: string;
  sortDir: 'asc' | 'desc';
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Ступень вида работ: по ней же берётся предвыбор для нового этапа работ. */
const TYPE_FACET_ID = 'type';

// Огрызок uuid здесь стоял как «хоть как-то опознать строку» — ровно то, что запрещает
// `humanLabels`: идентификатор не заменяет подпись, а притворяется ею. Двигатель без номера
// называется так же, как в отчётах.
function engineLabel(r: WorkSheetRow): string {
  return r.engineNumber || HUMAN_LABEL_NO_NUMBER;
}

/**
 * Подпись вида работ в списке. Осознанный возврат подписывается прямо здесь: две одинаковые
 * строки за один день законны ТОЛЬКО когда вторая — повторный проход, и это должно быть видно
 * глазом в списке. Иначе отличие, ради которого заведён гейт дублей, существует лишь в базе.
 */
function typeCellLabel(r: WorkSheetRow): string {
  return r.repeatPass >= 2 ? `${r.typeName} · проход ${r.repeatPass}` : r.typeName;
}

/**
 * Имя цеха: справочник → снимок в строке → прочерк. Справочник спрашивается первым (там имя
 * свежее), снимок выручает, когда справочника нет — прав `masterdata.view` не выдали, клиент
 * офлайн, цех деактивирован (`activeOnly: true` не отдаёт его и онлайн). Uuid не показывается
 * никогда: строку он не опознаёт, а читается как испорченные данные.
 */
function workshopLabel(r: WorkSheetRow, fromDirectory: (id: string) => string): string {
  if (!r.workshopId) return '';
  return fromDirectory(r.workshopId) || r.workshopName || HUMAN_LABEL_DASH;
}

export function WorkSheetsPage(props: {
  canEdit: boolean;
  canManageTypes: boolean;
  /** Каталог двигателей приложения — для выбора двигателя в черновой строке и его справки. */
  engines: EngineListItem[];
  onOpenEngine: (id: string) => void;
  /** Открыть карточку этапа работ. Новый заводится тем же путём: id генерирует список. */
  onOpenSheet: (id: string, opts?: { isNew?: boolean; typeCode?: string | null; title?: string }) => void;
  /** Справочник цехов нужен и карточке — грузим один раз здесь и отдаём наверх. */
  onWorkshopsLoaded?: (rows: WorkshopOption[]) => void;
}) {
  const [types, setTypes] = useState<WorkSheetType[]>([]);
  const [typesSource, setTypesSource] = useState<WorkSheetTypesSource>('server');
  const [rows, setRows] = useState<WorkSheetRow[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState('');
  const [allTime, setAllTime] = useState(false);
  const [workshops, setWorkshops] = useState<WorkshopOption[]>([]);
  const [typeEditorOpen, setTypeEditorOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [editor, setEditor] = useState<SheetEditor | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  /** Фокус наводится один раз на каждый открытый редактор, иначе он воюет с набором. */
  const focusedEditorRef = useRef<string | null>(null);
  /** Куда вернуть фокус после сохранения правки — на саму строку, а не в начало списка. */
  const pendingFocusRowRef = useRef<string | null>(null);

  const { state: ui, patchState } = useListUiState<ListUiState>('list:workSheets:ui', {
    query: '',
    searchSimilar: false,
    facets: {},
    facetFields: [],
    facetsOpen: false,
    sortKey: 'at',
    sortDir: 'desc',
  });

  const refreshTypes = useCallback(async () => {
    const res = await loadWorkSheetTypes();
    setTypes(res.rows);
    setTypesSource(res.source);
  }, []);

  const refreshRows = useCallback(async () => {
    try {
      const res = await window.matrica.workSheets.rows.list({ sinceMs: allTime ? null : Date.now() - YEAR_MS });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setRows(res.rows);
      setTruncated(res.truncated === true);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [allTime]);

  const refresh = useCallback(async () => {
    await Promise.all([refreshTypes(), refreshRows()]);
  }, [refreshTypes, refreshRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Открытый, но пустой редактор списку не мешает — список остаётся живым. Как только набрали
  // хоть символ, обновление замирает до «Сохранить»/«Отмены»: `skipWhenInteracting` смотрит
  // только на поля ввода, а после Tab фокус стоит на кнопке «Сохранить» — и `rows` переписался
  // бы под рукой. Глушить на всё время открытия тоже нельзя: редактор, оставленный на обед,
  // сделал бы список устаревшим на час.
  useLiveDataRefresh(refreshRows, { enabled: editor === null || !editor.dirty });

  // Цеха — подписи для колонки и карточки; прав на справочник может не быть — тогда снимок строки.
  const onWorkshopsLoaded = props.onWorkshopsLoaded;
  useEffect(() => {
    void (async () => {
      try {
        const r = await window.matrica.workshops.list({ activeOnly: true });
        if (r.ok) {
          const rows = r.rows.map((w) => ({ id: String(w.id), label: String(w.name || w.code) }));
          setWorkshops(rows);
          onWorkshopsLoaded?.(rows);
        }
      } catch {
        /* без справочника цехов возьмём снимок имени из самой строки */
      }
    })();
  }, [onWorkshopsLoaded]);

  const workshopFromDirectory = useCallback((id: string) => workshops.find((w) => w.id === id)?.label ?? '', [workshops]);

  /**
   * Вид работ для НОВОГО этапа: тот, что выбран в фильтре. Мастер отобрал обкатку и жмёт
   * «Добавить» — он заводит обкатку, а не то, что стоит первым в справочнике. Выбрано
   * несколько — берём первый отобранный; не выбрано ничего — решает диалог (первый вид).
   */
  const initialTypeCode = useMemo(() => {
    const selected = ui.facets?.[TYPE_FACET_ID];
    const first = Array.isArray(selected) ? selected.map((v) => String(v)).find(Boolean) : null;
    return first && types.some((t) => t.code === first) ? first : null;
  }, [ui.facets, types]);

  // id нового этапа работ генерирует список; запись появляется только по «Сохранить» —
  // пустых этапов работ в истории ремонта не остаётся. Редактор один: второй «Добавить»
  // при открытом кнопка не даёт.
  const openNewRow = () => {
    const typeCode = initialTypeCode ?? types[0]?.code ?? '';
    const type = types.find((t) => t.code === typeCode) ?? null;
    // Поля вида — обязательные среди них — живут в колонке «Поля»; скрытую придётся показать,
    // иначе оператор не увидит, чего от него ждут.
    if ((type?.columns.length ?? 0) > 0 && !columnLayout.isVisible('fields')) columnLayout.setVisible('fields', true);
    setEditor({
      base: null,
      id: crypto.randomUUID(),
      typeCode,
      engineId: null,
      date: toWorkSheetDateInput(Date.now()),
      workshopId: type?.workshopId ?? '',
      values: {},
      note: '',
      busy: false,
      error: '',
      dirty: false,
      escArmed: false,
      focusColId: 'engine',
    });
  };
  const openRow = (row: WorkSheetRow) =>
    props.onOpenSheet(row.id, { title: `${row.typeName}${row.engineNumber ? ` · ${row.engineNumber}` : ''}` });

  /** Правка записанной строки: тот же id — сохранение идёт upsert'ом, а не второй записью. */
  const editorFromRow = (row: WorkSheetRow, colId: string | null): SheetEditor => ({
    base: row,
    id: row.id,
    typeCode: row.typeCode,
    engineId: row.engineId,
    date: toWorkSheetDateInput(row.at),
    workshopId: row.workshopId,
    // Значения берутся из самой строки, а не из справочника: она самоописываема и правится
    // даже без связи с сервером.
    values: Object.fromEntries(row.fields.map((f) => [f.code, f.value])),
    note: row.note,
    busy: false,
    error: '',
    dirty: false,
    escArmed: false,
    focusColId: colId,
  });

  const colIdFromEvent = (e: React.MouseEvent<HTMLTableRowElement>): string | null =>
    (e.target as HTMLElement | null)?.closest('td')?.dataset.colId ?? null;

  /**
   * Единственная дверь в правку. Чистый редактор просто переезжает на другую строку — мастер
   * правит подряд, и заставлять его жать «Отмена» незачем; грязный не теряется ни при каком
   * щелчке (ни confirm, ни автосохранения — набранное остаётся на экране).
   */
  const beginEdit = (row: WorkSheetRow, colId: string | null) => {
    if (!props.canEdit) return void openRow(row);
    if (editor && editor.dirty) {
      patchEditor({ error: 'Сначала сохраните (Enter) или отмените (Esc) — тогда откроется другая строка' });
      return;
    }
    if (row.fields.length > 0 && !columnLayout.isVisible('fields')) columnLayout.setVisible('fields', true);
    setEditor(editorFromRow(row, colId));
  };

  const { pickChoice } = useConfirm();
  const liveType = useMemo(() => (editor ? types.find((t) => t.code === editor.typeCode) ?? null : null), [editor, types]);
  const draftEngine = useMemo(
    () => (editor && !editor.base && editor.engineId ? props.engines.find((e) => e.id === editor.engineId) ?? null : null),
    [editor, props.engines],
  );
  /**
   * Колонки правки: живой справочник плюс коды, которых в виде уже нет, — иначе правка
   * примечания стёрла бы значения удалённых колонок. Один и тот же массив идёт и в отрисовку
   * ячейки «Поля», и в payload: два разных набора разъехались бы на первой же правке.
   */
  const editorColumns = useMemo<WorkSheetColumn[]>(
    () => (editor?.base ? mergeWorkSheetColumns(liveType?.columns ?? [], editor.base.fields) : liveType?.columns ?? []),
    [editor?.base, liveType],
  );
  const engineOptions = useMemo(() => buildEngineSearchOptions(props.engines), [props.engines]);
  const patchEditor = (patch: Partial<SheetEditor>) =>
    setEditor((ed) =>
      ed
        ? {
            ...ed,
            ...patch,
            error: patch.error ?? '',
            escArmed: false,
            dirty: ed.dirty || EDITOR_DATA_KEYS.some((k) => k in patch),
          }
        : ed,
    );
  // Смена вида работ подставляет его цех и сбрасывает поля чужого вида — как в карточке.
  // У записанной строки вид заморожен, и сюда не приходят вовсе.
  const setEditorType = (typeCode: string) => {
    const type = types.find((t) => t.code === typeCode) ?? null;
    // Колонку «Поля» показываем и здесь, а не только при открытии: у выбранного вида работ
    // может быть обязательная колонка, и при скрытых «Полях» вводить её было бы негде —
    // сохранение упиралось бы в «Заполните: …» без единой подсказки, где.
    if ((type?.columns.length ?? 0) > 0 && !columnLayout.isVisible('fields')) columnLayout.setVisible('fields', true);
    patchEditor({ typeCode, workshopId: type?.workshopId ?? '', values: {} });
  };

  const saveEditor = async () => {
    const ed = editor;
    if (!ed || ed.busy) return;
    const base = ed.base;
    // Вид работ и двигатель у записанной строки заморожены — эти две проверки только для нового:
    // у правки они взяты из самой строки и пустыми быть не могут.
    if (!base && !liveType) return patchEditor({ error: 'Выберите вид работ' });
    const engineId = base ? base.engineId : ed.engineId;
    if (!engineId) return patchEditor({ error: 'Выберите двигатель' });
    const atMs = fromWorkSheetDateInput(ed.date);
    if (!atMs) return patchEditor({ error: 'Укажите дату' });
    patchEditor({ busy: true });
    try {
      // Тот же payload и тот же main-сервис, что у карточки: проверка обязательных полей и
      // «Отремонтирован» по completesRepair остаются в одном месте. Payload собирается из
      // СОСТОЯНИЯ, а не из видимых ячеек: скрытые колонки «Цех»/«Поля»/«Примечание» иначе
      // обнулили бы свои значения.
      const payload = {
        id: ed.id,
        engineId,
        type: base
          ? {
              id: base.typeId,
              code: base.typeCode,
              name: base.typeName,
              // Как в карточке: статус ставится только при создании строки. Правка не может
              // ни поставить «Отремонтирован», ни снять его.
              completesRepair: false,
              columns: editorColumns,
              // null, чтобы выбранное оператором «—» не подменялось цехом вида работ.
              workshopId: null,
            }
          : {
              id: liveType!.id,
              code: liveType!.code,
              name: liveType!.name,
              completesRepair: liveType!.completesRepair,
              columns: liveType!.columns,
              workshopId: liveType!.workshopId,
            },
        atMs,
        workshopId: ed.workshopId || null,
        // Без справочника цехов имя берётся из снимка самой строки — иначе правка примечания
        // стирала бы название цеха у того, кому не выдали `masterdata.view`.
        workshopName:
          workshops.find((w) => w.id === ed.workshopId)?.label ??
          (base && ed.workshopId === base.workshopId ? base.workshopName || null : null),
        note: ed.note.trim() || null,
        values: ed.values,
      };
      // Путь записи ОДИН на всё: создание, правку и повтор после гейта дублей. Второй вызов
      // разъехался бы с первым — и по payload, и по оповещению об изменении двигателя.
      const writeRow = (repeatPass?: number) =>
        window.matrica.workSheets.rows.save({ ...payload, ...(repeatPass ? { repeatPass } : {}) });

      let r = await writeRow();
      // Совпадение с уже внесённой строкой — вопрос к оператору, а не ошибка: двигатель может
      // и правда вернуться на тот же этап. Спрашиваем и при «это возврат» пишем повторно с
      // номером прохода; при отказе строка редактора остаётся на экране, чтобы её было видно.
      if (!r.ok && r.duplicate) {
        const decision = await askWorkSheetDuplicate({
          duplicate: r.duplicate,
          engineLabel: formatEngineGateLabel(props.engines.find((e) => e.id === engineId) ?? {}),
          pickChoice,
        });
        if (decision.action !== 'repeat') {
          patchEditor({ busy: false, error: 'Такой этап за этот день уже есть — строка не сохранена' });
          return;
        }
        r = await writeRow(decision.pass);
      }
      if (!r.ok) {
        patchEditor({ busy: false, error: `Ошибка: ${r.error}` });
        return;
      }
      const typeName = base ? base.typeName : liveType!.name;
      if (base) pendingFocusRowRef.current = ed.id;
      setEditor(null);
      window.dispatchEvent(new Event('matrica:engines-changed'));
      // Сначала перечитать список, потом сказать словами: `refreshRows` в конце чистит статус,
      // и написанное до него исчезало через десятки миллисекунд (поймано живьём 15.09).
      await refreshRows();
      setStatus(
        base
          ? `Этап работ «${typeName}» изменён`
          : r.repair?.applied
            ? `Этап работ «${typeName}» сохранён; двигателю поставлен «Отремонтирован» датой этапа работ`
            : `Этап работ «${typeName}» сохранён`,
      );
      if (!base) addButtonRef.current?.focus();
    } catch (e) {
      patchEditor({ busy: false, error: `Ошибка: ${String(e)}` });
    }
  };
  const cancelEditor = () => {
    if (editor?.base) pendingFocusRowRef.current = editor.id;
    else addButtonRef.current?.focus();
    setEditor(null);
  };

  const columns = useMemo<Column[]>(
    () => [
      { id: 'at', label: 'Дата', kind: 'date', render: (r) => formatMoscowDate(new Date(r.at)), sortValue: (r) => r.at, alwaysVisible: true },
      { id: 'type', label: 'Вид работ', kind: 'name', render: typeCellLabel, sortValue: (r) => r.typeName, alwaysVisible: true },
      { id: 'engine', label: 'Двигатель', kind: 'name', render: (r) => engineLabel(r), sortValue: (r) => engineLabel(r), alwaysVisible: true },
      { id: 'brand', label: 'Марка', kind: 'name', render: (r) => r.engineBrand, sortValue: (r) => r.engineBrand },
      { id: 'internal', label: 'Внутр. №', kind: 'num', render: (r) => r.internalNumber, sortValue: (r) => r.internalNumber },
      {
        id: 'customer',
        label: 'Заказчик',
        kind: 'name',
        render: (r) => (r.customerName ? <span title={r.customerFullName || r.customerName}>{r.customerName}</span> : ''),
        sortValue: (r) => r.customerName,
        printValue: (r) => r.customerName,
      },
      {
        id: 'contract',
        label: 'Договор',
        kind: 'name',
        render: (r) => (r.contractShortLabel ? <span title={r.contractNumber}>{r.contractShortLabel}</span> : ''),
        sortValue: (r) => r.contractShortLabel,
        printValue: (r) => r.contractShortLabel,
      },
      { id: 'workshop', label: 'Цех', kind: 'name', render: (r) => workshopLabel(r, workshopFromDirectory), sortValue: (r) => workshopLabel(r, workshopFromDirectory) },
      // Поля вида работ — одной сводной колонкой: у каждого вида свой набор, и разворачивать
      // их в общем списке значило бы плодить пустые колонки. Сами поля — в строке этапа работ.
      { id: 'fields', label: 'Поля', kind: 'text', render: (r) => workSheetFieldsSummary(r.fields) },
      { id: 'performedBy', label: 'Кто', kind: 'name', render: (r) => r.performedBy, sortValue: (r) => r.performedBy },
      { id: 'note', label: 'Примечание', kind: 'text', render: (r) => r.note },
    ],
    [workshopFromDirectory],
  );

  const columnLayout = useColumnLayout('list:workSheets:columns', columns.map((c) => c.id));
  const columnsById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);
  const visibleColumns = useMemo(
    () => columnLayout.order.map((id) => columnsById.get(id)).filter((c): c is Column => Boolean(c) && columnLayout.isVisible(c!.id)),
    [columnLayout, columnsById],
  );

  // Ступени — общие для всего списка: полей вида работ здесь нет (у каждого вида свои),
  // зато есть сам вид работ, заказчик, договор, цех, исполнитель и дата.
  const facets = useMemo(() => workSheetFacets([]) as FacetDescriptor<WorkSheetRow>[], []);

  const deep = useListDeepFilter(
    rows,
    (r) => r.id,
    (r) =>
      [engineLabel(r), r.engineBrand, r.internalNumber, r.typeName, r.customerName, r.contractNumber, r.note, r.performedBy, workSheetFieldsSummary(r.fields)].join(' '),
    ui.query,
    { entityBacked: false, mode: searchModeOf(ui.searchSimilar) },
  );
  const faceted = useMemo(() => applyFacets(facets, deep.filtered, ui.facets), [facets, deep.filtered, ui.facets]);
  const sorted = useMemo(() => {
    const col = columnsById.get(ui.sortKey) ?? columnsById.get('at')!;
    const sv = col.sortValue ?? ((r: WorkSheetRow) => r.at);
    const dir = ui.sortDir === 'asc' ? 1 : -1;
    return [...faceted].sort((a, b) => {
      const x = sv(a);
      const y = sv(b);
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ru');
      return cmp * dir || b.at - a.at;
    });
  }, [faceted, columnsById, ui.sortKey, ui.sortDir]);

  const toggleSort = (id: string) =>
    patchState(ui.sortKey === id ? { sortDir: ui.sortDir === 'asc' ? 'desc' : 'asc' } : { sortKey: id, sortDir: id === 'at' ? 'desc' : 'asc' });

  const thStyle: React.CSSProperties = { textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 8, position: 'sticky', top: 0, zIndex: 2 };
  const header = (
    <thead>
      <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
        <RowNumberHeaderCell style={thStyle} />
        {visibleColumns.map((col) => (
          <th
            key={col.id}
            {...listHeaderKindProps(col.kind, col.label)}
            style={{ ...thStyle, cursor: col.sortValue ? 'pointer' : 'default' }}
            onClick={col.sortValue ? () => toggleSort(col.id) : undefined}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <span>{col.label}</span>
              <ColumnToggleButton colId={col.id} visible alwaysVisible={col.alwaysVisible} onToggle={() => columnLayout.setVisible(col.id, false)} />
            </span>
            {ui.sortKey === col.id ? (ui.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </th>
        ))}
        <th className="list-col-filler" aria-hidden="true" />
      </tr>
    </thead>
  );

  const cells = (r: WorkSheetRow) => (
    <>
      {visibleColumns.map((col) => (
        // `data-col-id` — чтобы щелчок по ячейке ставил курсор в ту же колонку в редакторе.
        <td key={col.id} data-col-id={col.id} {...listCellKindProps(col.kind)} style={{ borderBottom: '1px solid #f3f4f6', padding: 8 }}>
          {col.render(r)}
        </td>
      ))}
      <td className="list-col-filler" aria-hidden="true" style={{ borderBottom: '1px solid #f3f4f6' }} />
    </>
  );
  const rowProps = (r: WorkSheetRow): VirtualTableRowProps =>
    props.canEdit
      ? {
          onClick: (e) => beginEdit(r, colIdFromEvent(e)),
          title: 'Править этап работ прямо в строке',
          style: { cursor: 'pointer' },
          // Фокус после сохранения возвращается на саму строку — для этого она фокусируемая.
          tabIndex: -1,
          'data-work-sheet-row': r.id,
        }
      : {
          onClick: () => void openRow(r),
          title: 'Открыть карточку этапа работ',
          style: { cursor: 'pointer' },
          'data-work-sheet-row': r.id,
        };

  // Редактор: поля прямо в ячейках видимых колонок. У НОВОГО этапа реквизиты двигателя —
  // справкой из каталога, как в карточке; у записанной строки они берутся из неё самой:
  // заказчика и договора в каталоге двигателей нет вовсе.
  const editorCellStyle: React.CSSProperties = { borderBottom: 'none', padding: 6, verticalAlign: 'top' };
  const editorCellFor = (col: Column, ed: SheetEditor): React.ReactNode => {
    const base = ed.base;
    switch (col.id) {
      case 'at':
        return <UnifiedDateInput type="date" value={ed.date} disabled={ed.busy} onChange={(e) => patchEditor({ date: e.target.value })} data-work-sheet-editor-date />;
      case 'type':
        // Вид работ у записанной строки заморожен: поля пересобираются строго по присланным
        // колонкам, и смена вида молча превратила бы строку в другой этап с пустыми полями.
        return base ? (
          base.typeName
        ) : (
          <select value={ed.typeCode} disabled={ed.busy} onChange={(e) => setEditorType(e.target.value)} data-work-sheet-editor-type>
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
        );
      case 'engine':
        // Двигатель заморожен: сервис отказывает явным текстом «Строку нельзя перевесить…»,
        // и дать набрать, чтобы отказать после «Сохранить», хуже, чем не дать набрать.
        return base ? (
          engineLabel(base)
        ) : (
          <div style={{ minWidth: 220 }} data-work-sheet-editor-engine>
            <EntityReferenceField
              target="engine"
              targetLabel="Двигатель"
              value={ed.engineId}
              options={engineOptions}
              optionsReady={props.engines.length > 0}
              disabled={ed.busy}
              placeholder="Номер двигателя или внутренний №…"
              onChange={(next) => patchEditor({ engineId: next })}
              onOpen={props.onOpenEngine}
            />
          </div>
        );
      case 'brand':
        return base ? base.engineBrand : draftEngine?.engineBrand ?? '';
      case 'internal':
        return base ? base.internalNumber : draftEngine?.internalNumberFull ?? '';
      case 'customer':
        return base ? base.customerName : draftEngine?.customerName ?? '';
      case 'contract':
        return base ? base.contractShortLabel : draftEngine?.contractName ?? '';
      case 'workshop':
        return (
          <select value={ed.workshopId} disabled={ed.busy} onChange={(e) => patchEditor({ workshopId: e.target.value })} data-work-sheet-editor-workshop>
            <option value="">—</option>
            {workshops.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        );
      case 'fields':
        return (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center' }} data-work-sheet-editor-fields>
            {editorColumns.map((c) => (
              <label key={c.code} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <span className="ui-muted" style={{ whiteSpace: 'nowrap' }}>
                  {c.label}
                  {c.required ? ' *' : ''}
                </span>
                <WorkSheetFieldEditor column={c} value={ed.values[c.code]} disabled={ed.busy} compact onChange={(v) => patchEditor({ values: { ...ed.values, [c.code]: v } })} />
              </label>
            ))}
            {/* Обещание «Отремонтирован» — только у нового этапа: правка статус не трогает. */}
            {!base && liveType?.completesRepair ? (
              <span className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-completes-hint>
                Завершает ремонт: двигателю встанет «Отремонтирован» датой этапа работ
              </span>
            ) : null}
          </div>
        );
      case 'performedBy':
        // Не редактируется, но показывается — иначе ячейка выглядит опустевшей. Сервер всё
        // равно перепишет «Кто» на того, кто правит.
        return base ? base.performedBy : '';
      case 'note':
        return <Input value={ed.note} disabled={ed.busy} placeholder="Примечание" onChange={(e) => patchEditor({ note: e.target.value })} data-work-sheet-editor-note />;
      default:
        return '';
    }
  };
  const editorCells = (ed: SheetEditor) => (
    <>
      {visibleColumns.map((col) => (
        <td key={col.id} {...listCellKindProps(col.kind)} style={editorCellStyle}>
          {editorCellFor(col, ed)}
        </td>
      ))}
      {/* Хвостовая ячейка пустеет: кнопки уехали в полку. `nowrap` здесь ставить нельзя —
          в полноширинном ряду длинный текст стал бы min-content и раздвинул таблицу. */}
      <td className="list-col-filler" aria-hidden="true" style={editorCellStyle} />
    </>
  );

  /** Подсказка полки: почему строка прыгнула наверх или что будет с несохранённым. */
  const editorHint = (ed: SheetEditor): string => {
    if (ed.dirty && ed.escArmed) return 'Есть несохранённое. Esc ещё раз — выбросить';
    if (!ed.base) return '';
    if (!rows.some((r) => r.id === ed.id)) return 'Строку удалили на другом устройстве. «Сохранить» вернёт её в список';
    if (!sorted.some((r) => r.id === ed.id)) return 'Строка не попадает в текущий фильтр — правка продолжается';
    return '';
  };

  // Полка — полноширинная ячейка под редактором. `colSpan` считается по видимым колонкам плюс
  // филлер: ячейку «№» VirtualTable рисует отдельно, и в colSpan она не входит. Всё содержимое —
  // во внутреннем div: паддинг у `td` списка задан в global.css с !important, и inline-стилями
  // ячейки центрировать нельзя.
  const editorActionsCell = (ed: SheetEditor) => {
    const hint = editorHint(ed);
    return (
      <td colSpan={Math.max(1, visibleColumns.length) + 1} style={{ borderBottom: '1px solid #f3f4f6' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px' }}>
          {/* Сетка держит две кнопки ровно по центру таблицы независимо от «Карточка ↗». */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto minmax(0,1fr)', alignItems: 'center', gap: 8 }}>
            <span />
            <span style={{ display: 'inline-flex', gap: 8 }}>
              <Button
                size="sm"
                disabled={ed.busy}
                onClick={() => void saveEditor()}
                title={ed.base ? 'Сохранить правку (Enter); в колонке «Кто» встанете вы' : 'Сохранить этап работ (Enter)'}
                data-work-sheet-editor-save
              >
                {ed.busy ? 'Сохраняю…' : 'Сохранить'}
              </Button>
              <Button size="sm" variant="ghost" disabled={ed.busy} onClick={cancelEditor} title="Закрыть редактор (Esc)" data-work-sheet-editor-cancel>
                Отмена
              </Button>
            </span>
            <span style={{ justifySelf: 'start' }}>
              {ed.base ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={ed.busy}
                  onClick={() => openRow(ed.base!)}
                  title="Карточка этапа работ: удаление и откат «Отремонтирован»"
                  data-work-sheet-open-card
                >
                  Карточка ↗
                </Button>
              ) : null}
            </span>
          </div>
          {ed.error ? (
            <div data-work-sheet-editor-error style={{ color: 'var(--danger)', fontSize: 12, textAlign: 'center', whiteSpace: 'normal' }}>
              {ed.error}
            </div>
          ) : null}
          {hint ? (
            <div data-work-sheet-editor-hint className="ui-muted" style={{ fontSize: 12, textAlign: 'center', whiteSpace: 'normal' }}>
              {hint}
            </div>
          ) : null}
        </div>
      </td>
    );
  };

  // Один обработчик на ОБА ряда: общей обёртки у двух `<tr>` не бывает, а повесить только на
  // редактор — значит потерять Esc/Enter, когда фокус ушёл на кнопки полки.
  const editorKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>) => {
    const ed = editor;
    if (!ed) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // Двухступенчатый Esc вместо модального вопроса: окно — ровно то, от чего уходим.
      if (!ed.dirty || ed.escArmed) cancelEditor();
      else setEditor({ ...ed, escArmed: true, error: '' });
      return;
    }
    // Enter сохраняет строку, но не из открытого списка двигателей (там он выбирает и
    // гасится через preventDefault) и не из select'а (там он раскрывает варианты).
    if (e.key === 'Enter' && !e.defaultPrevented && !(e.target instanceof HTMLSelectElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      void saveEditor();
    }
  };

  // Фон бьёт и зебру, и hover. `onClick` у рядов редактора нет вовсе: он ловил бы всплытие из
  // ячеек, и каждый щелчок по полю перезапускал бы правку.
  const EDITOR_ROW_STYLE: React.CSSProperties = { background: 'rgba(29, 78, 216, 0.06)' };
  const editorRowProps = (ed: SheetEditor): VirtualTableRowProps => ({
    'data-work-sheet-editor-row': ed.id,
    'data-work-sheet-editor-mode': ed.base ? 'edit' : 'new',
    'data-work-sheet-editor-dirty': ed.dirty ? '1' : undefined,
    style: EDITOR_ROW_STYLE,
    onKeyDown: editorKeyDown,
  });
  const editorActionsRowProps = (ed: SheetEditor): VirtualTableRowProps => ({
    'data-work-sheet-editor-actions': ed.id,
    style: EDITOR_ROW_STYLE,
    onKeyDown: editorKeyDown,
  });

  const items = useMemo(() => buildWorkSheetListItems(sorted, editor), [sorted, editor]);
  // Промах на единицу даёт пустую строку, а не исключение в рендере всего списка.
  const itemAt = (i: number): SheetItem | undefined => items[i];

  /**
   * Курсор встаёт в ту колонку, по которой щёлкнули, — один раз на каждый открытый редактор.
   * `autoFocus` в ячейках не годится: VirtualTable перемонтирует ряды при прокрутке, и он
   * начал бы воровать фокус. Запрос скоупится контейнером — на «2 рядом» иначе поймаем чужой.
   */
  const editorId = editor?.id ?? null;
  const editorIsNew = editor !== null && editor.base === null;
  const editorFocusColId = editor?.focusColId ?? null;
  useEffect(() => {
    if (!editorId) {
      focusedEditorRef.current = null;
      return;
    }
    if (focusedEditorRef.current === editorId) return;
    const attrOf: Record<string, string> = { at: 'date', type: 'type', engine: 'engine', workshop: 'workshop', fields: 'fields', note: 'note' };
    const editable = editorIsNew ? ['at', 'type', 'engine', 'workshop', 'fields', 'note'] : ['at', 'workshop', 'fields', 'note'];
    const colId = editorFocusColId && editable.includes(editorFocusColId) ? editorFocusColId : editorIsNew ? 'engine' : 'at';
    const tryFocus = (): boolean => {
      const host = containerRef.current?.querySelector<HTMLElement>(`[data-work-sheet-editor-${attrOf[colId] ?? 'date'}]`) ?? null;
      const target =
        host instanceof HTMLInputElement || host instanceof HTMLSelectElement
          ? host
          : host?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select') ?? null;
      if (!target) return false;
      target.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement && target.type === 'text') target.select();
      return true;
    };
    // Пробуем СРАЗУ: к моменту эффекта ряд-редактор уже в DOM, а кадр анимации в неактивном
    // окне может не прийти вовсе — на этом курсор и не вставал никуда (поймано смоуком).
    // Кадр остаётся запасным на случай, когда ряда ещё нет (список прокручен от начала).
    if (tryFocus()) {
      focusedEditorRef.current = editorId;
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (tryFocus()) focusedEditorRef.current = editorId;
    });
    return () => cancelAnimationFrame(frame);
  }, [editorId, editorIsNew, editorFocusColId]);

  /** После сохранения правки фокус возвращается на саму строку, а не улетает в начало списка. */
  useEffect(() => {
    const id = pendingFocusRowRef.current;
    if (!id) return;
    pendingFocusRowRef.current = null;
    const tr = containerRef.current?.querySelector<HTMLElement>(`tr[data-work-sheet-row="${id}"]`) ?? null;
    if (!tr) return;
    tr.focus({ preventScroll: true });
    tr.scrollIntoView({ block: 'nearest' });
    // Зависимость от `editorId` обязательна: при «Отмене» список не меняется, и по одному
    // только `rows` эффект бы не сработал — метка осталась бы висеть до следующего обновления
    // и увела бы фокус посреди чужой работы.
  }, [rows, editorId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }} data-work-sheets-page>
      <PageToolbar>
        {props.canEdit && (
          <Button ref={addButtonRef} onClick={() => void openNewRow()} disabled={editor !== null || types.length === 0} data-work-sheet-add-row>
            Добавить этап работ
          </Button>
        )}
        <ToolbarPin>
          <Input value={ui.query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по этапам работ…" />
        </ToolbarPin>
        <ToolbarPin>
          <SearchModeToggle similar={ui.searchSimilar} onToggle={() => patchState({ searchSimilar: !ui.searchSimilar })} />
        </ToolbarPin>
        <ToolbarPin>
          <FacetToggleButton<WorkSheetRow> facets={facets} selection={ui.facets} open={ui.facetsOpen} onToggle={() => patchState({ facetsOpen: !ui.facetsOpen })} />
        </ToolbarPin>
        <ColumnSettingsButton
          label="Колонки списка"
          columns={columns}
          order={columnLayout.order}
          isVisible={columnLayout.isVisible}
          onToggleVisible={columnLayout.setVisible}
          onMove={columnLayout.moveColumn}
          onReset={columnLayout.resetToDefault}
        />
        {props.canManageTypes && (
          <Button variant="ghost" onClick={() => setTypeEditorOpen(true)} title="Виды работ: названия, цеха, колонки" data-work-sheet-edit-types>
            Виды работ
          </Button>
        )}
        <Button variant="ghost" onClick={() => setAllTime((v) => !v)} title="По умолчанию показаны этапы работ с датой за последний год">
          {allTime ? 'За год' : 'За всё время'}
        </Button>
        {!isAndroidPlatform() && (
          <Button variant="ghost" onClick={() => setPrintOpen(true)} title="Печать текущего списка (по фильтру) с выбором полей">
            Печать списка
          </Button>
        )}
        <Button variant="ghost" onClick={() => void refresh()}>
          Обновить
        </Button>
      </PageToolbar>

      {truncated ? (
        <div className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-truncated>
          Показаны не все этапы работ: выборка упёрлась в потолок. Счётчик «Всего» считает загруженное, а не всё, что есть, —
          сузьте период кнопкой «За год».
        </div>
      ) : null}
      {typesSource === 'cache' ? (
        <div className="ui-muted" style={{ fontSize: 12 }}>Список видов работ взят из кэша — сервер недоступен, набор может быть устаревшим.</div>
      ) : null}
      {typesSource === 'none' ? (
        <div className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-types-unavailable>
          Справочник видов работ недоступен: сервер не ответил, а на этом устройстве он ещё ни разу не загружался. Этапы работ ниже
          читаются как есть — они несут свои поля с собой; завести новый этап работ можно будет, когда появится связь.
        </div>
      ) : null}
      {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

      <div style={{ marginTop: 8, flex: '0 0 auto' }}>
        <FacetFilter<WorkSheetRow>
          facets={facets}
          rows={deep.filtered}
          selection={ui.facets}
          fields={ui.facetFields}
          open={ui.facetsOpen}
          onChangeSelection={(next) => patchState({ facets: next })}
          onChangeFields={(next) => patchState({ facetFields: next })}
          onReset={() => patchState({ facets: {}, facetFields: [] })}
        />
      </div>

      <ListCount total={rows.length} shown={sorted.length} style={{ marginTop: 6 }} />
      <div ref={containerRef} style={{ marginTop: 2, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <VirtualTable
          scrollElementRef={containerRef}
          count={items.length}
          header={header}
          renderCells={(i) => {
            const it = itemAt(i);
            if (!it) return null;
            if (it.kind === 'row') return cells(it.row);
            if (!editor) return null;
            return it.kind === 'editor' ? editorCells(editor) : editorActionsCell(editor);
          }}
          // Префиксы обязательны: без них ключ ряда-редактора совпал бы с ключом самой строки,
          // React переиспользовал бы DOM, и поле теряло бы фокус на каждом символе.
          getRowKey={(i) => {
            const it = itemAt(i);
            if (!it) return `gap:${i}`;
            return it.kind === 'row' ? it.row.id : `${it.kind === 'editor' ? 'ed' : 'act'}:${editor?.id ?? ''}`;
          }}
          getRowProps={(i) => {
            const it = itemAt(i);
            if (!it) return {};
            if (it.kind === 'row') return rowProps(it.row);
            if (!editor) return {};
            return it.kind === 'editor' ? editorRowProps(editor) : editorActionsRowProps(editor);
          }}
          // Номер несёт сам ряд: у правки — свой (иначе нумерация ниже прыгала бы при каждом
          // открытии), у нового этапа и у полки — пусто.
          rowNumberOf={(i) => {
            const it = itemAt(i);
            return !it || it.kind === 'actions' ? null : it.number;
          }}
          colCount={Math.max(1, visibleColumns.length) + 1}
          rowNumbers
          estimateSize={40}
          emptyState={rows.length === 0 ? 'Этапов работ пока нет' : 'Ничего не найдено'}
        />
      </div>

      {/* Диалоги — ВНЕ тулбара: внутри они уехали бы в меню переполнения вместе с кнопкой. */}
      {printOpen ? (
        <ListPrintDialog
          title="Этапы работ"
          unitLabel="Этапов работ"
          columns={buildListPrintColumns(columns)}
          visibleColumnIds={visibleColumns.map((c) => c.id)}
          rows={sorted}
          selectedRows={[]}
          storageKey="list:workSheets:printFields"
          onClose={() => setPrintOpen(false)}
        />
      ) : null}

      {typeEditorOpen ? (
        <WorkSheetTypeEditorDialog
          types={types}
          initialTypeCode={initialTypeCode}
          workshops={workshops}
          onClose={() => setTypeEditorOpen(false)}
          onChanged={async () => {
            await refreshTypes();
          }}
        />
      ) : null}
    </div>
  );
}
