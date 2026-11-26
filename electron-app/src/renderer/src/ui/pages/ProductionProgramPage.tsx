import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_REPAIR_STAGE_TEMPLATES,
  PRODUCTION_PROGRAM_PERIOD_LABELS,
  PRODUCTION_PROGRAM_STATES,
  PRODUCTION_PROGRAM_STATE_LABELS,
  buildProductionProgramPeriod,
  formatProductionProgramPeriod,
  looksLikeIdentifier,
  parseContractSections,
  parseProductionProgramSignatureSlots,
  productionProgramContractLabel,
  productionProgramEngineHint,
  productionProgramEngineIndex,
  productionProgramEngineStage,
  productionProgramExecutionSummary,
  productionProgramMergeRows,
  productionProgramOrganizationLabel,
  productionProgramPendingCandidates,
  productionProgramPeriodKind,
  productionProgramGroupKey,
  productionProgramMoveGroup,
  productionProgramMoveRowWithinGroup,
  productionProgramNumberingPlan,
  productionProgramResolvePendingRows,
  productionProgramRowFromEngine,
  productionProgramRowTone,
  productionProgramSignatureTemplateSlots,
  productionProgramStageOptions,
  resolveProductionProgramSignatureSlots,
  serializePrintSignatureSlots,
  type EngineListItem,
  type PrintSignatureSlot,
  type ProductionProgramDto,
  type ProductionProgramSignatureTemplate,
  type ProductionProgramDropSide,
  type ProductionProgramExecutionSummary,
  type ProductionProgramLineDraftDto,
  type ProductionProgramLineDto,
  type ProductionProgramPeriodKind,
  type ProductionProgramPrintInput,
  type RepairStageTemplate,
  type WorkOrderSignatureEmployee,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { ListContextMenu, type ListContextMenuItem } from '../components/ListContextMenu.js';
import { ListLassoLayer } from '../components/ListLassoLayer.js';
import { ListRowHandle } from '../components/ListRowHandle.js';
import { MailSendButton } from '../components/MailSendButton.js';
import { MailComposeDialog } from '../components/MailComposeDialog.js';
import { PageToolbar } from '../components/PageToolbar.js';
import {
  ProductionProgramAddEnginesByNumbersDialog,
  type ProductionProgramAddByNumbersResult,
} from '../components/ProductionProgramAddEnginesByNumbersDialog.js';
import {
  ProductionProgramStageDialog,
  type ProductionProgramStageSubmitArgs,
  type ProductionProgramStageSubmitResult,
} from '../components/ProductionProgramStageDialog.js';
import { ProductionProgramPrintPreview } from '../components/ProductionProgramPrintPreview.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';
import { UnifiedDateInput } from '../components/UnifiedDateInput.js';
import { useListBehaviorSettings } from '../hooks/useListBehaviorSettings.js';
import { useListDrag } from '../hooks/useListDrag.js';
import { useListKeyboardMove } from '../hooks/useListKeyboardMove.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { LIST_DROP_INDICATOR_COLOR, listDragRowStyle, type ListDropTarget } from '../utils/listDragVisual.js';
import type { ListMoveGrouping } from '../utils/listKeyboardMove.js';
import { listToText } from '../utils/mailText.js';
import { handleScrapStageResult } from '../utils/scrapStageGate.js';
import {
  buildListContextMenuItems,
  buildRowsText,
  copyRowsToClipboard,
  listCopyAction,
  listPrintAction,
  printRowsPreview,
  type ListActionDeclaration,
  type ListContextColumn,
} from '../utils/listContextActions.js';
import {
  buildProductionProgramClipboardText,
  buildProductionProgramExportSpec,
} from '../utils/productionProgramExport.js';

/**
 * Производственная программа (ПП) — страница модуля.
 *
 * План читается из локальной реплики (сервер ведёт, клиент только читает — план
 * доступен и без сети), а ведётся серверной дверью: кнопки «Сохранить» и «Новый
 * план» бьют в REST `/production-program`, а изменения приезжают обратно pull'ом.
 *
 * Экран — две части (владелец 10.11.2026):
 *  · слева — плашки производственных программ (название, период, цех, статус);
 *  · справа — настройка открытой программы: шапка (название → цех → период →
 *    статус), добор двигателей по договору и строки плана, сгруппированные по
 *    договорам.
 *
 * Что показывает экран:
 *  · шапку: название, цех, период (вид + две даты), статус (черновик/утверждён);
 *  · строки плана: организация и договор, двигатель, состояние, плановая
 *    отгрузка, факторы, примечание;
 *  · добор двигателей по договору с подсказкой по состоянию («на заводе — можно
 *    брать», «ещё не приехал», «уже отгружен», «утиль»).
 *
 * Данные двигателя (заказчик, договор, номер) берутся из карточки ЖИВЫМИ: план
 * не живёт отдельной жизнью — правка карточки видна в плане сразу.
 */

type Props = {
  /** Каталог двигателей — источник подсказок и данных для печати. */
  engines: EngineListItem[];
  /** Право вести план (`production_program.edit`). */
  canEdit: boolean;
  /**
   * Право записывать этапы ремонта (`work_sheets.edit`).
   *
   * Отдельное право не для красоты: этап — это запись в ИСТОРИИ РЕМОНТА двигателя,
   * и ведение плана не даёт права её переписывать. Без этого права колонка «Этап»
   * читается, но не меняется.
   */
  canEditStages: boolean;
  /**
   * Право вести общий шаблон подписей ПП
   * (`production_program.signature_templates.edit`).
   *
   * Отдельное право от ведения плана: шаблон подставляется в новые программы
   * всего завода, то есть правит его не тот, кто ведёт план.
   */
  canEditSignatureTemplates?: boolean;
  /**
   * Открыть карточку двигателя из строки плана (промт КАРМАНА #64).
   *
   * Без этой двери номер двигателя в плане — просто текст: оператор должен был
   * искать карточку в списке двигателей вручную.
   */
  onOpenEngine?: (engineId: string) => void;
};

/**
 * Строка плана на экране: снимок строки + живые данные карточки двигателя.
 *
 * `operatorNote` — ручная отметка оператора («особое внимание»). Она НЕ входит
 * в набор записи (замена набора строк её не трогает — своя дверь), но живёт в
 * строке на экране: её показываем и по ней ждём зеркало.
 */
type DraftRow = ProductionProgramLineDraftDto & { id: string; operatorNote: string | null };

/** Поля шапки программы, которые оператор правит на экране. */
type ProgramHeaderFields = {
  title: string;
  /** Снимок имени цеха (на печать и в выгрузку). */
  shop: string;
  /** Цех из справочника `directory_workshops` — связь по id; null — legacy-текст. */
  workshopId: string | null;
  periodStart: number;
  periodEnd: number;
  status: string;
  signatureSlots: string | null;
  /** Шаблон подписей, из которого взят состав; null — шаблон не применялся. */
  signatureTemplateId: string | null;
};

/**
 * Ключи полей шапки.
 *
 * По ним ведётся учёт «что оператор правил сам»: в PATCH уходят ТОЛЬКО эти
 * поля. Раньше в PATCH сваливался весь снимок шапки из реплики, а реплика
 * отстаёт на минуту — правка названия уезжала с подписями `null`, и сервер
 * трактовал это как «очистить подписи» (жалоба владельца 24.11.2026:
 * «подписи то появляются, то исчезают»).
 */
type ProgramHeaderField = keyof ProgramHeaderFields;

/**
 * Значение поля шапки в оверрайде — то, что мы сейчас показываем на экране.
 *
 * Сверяем с тем, что ушло на сервер: если оператор успел изменить поле ещё
 * раз, пока правка летела, поле остаётся «правленым» и уедет следующим
 * автосохранением.
 */
function headerOverrideValue(
  fields: Partial<ProgramHeaderFields> | undefined,
  field: ProgramHeaderField,
): ProgramHeaderFields[ProgramHeaderField] | undefined {
  if (!fields) return undefined;
  return fields[field];
}

/**
 * Поля шапки, которые оператор правил в этом патче.
 *
 * Отдельная функция: оверрайд (что держим на экране) и «правленые поля»
 * (что уходит в PATCH) считаются по одному и тому же списку — иначе они
 * разойдутся, и правка уедет без своего поля.
 */
function changedHeaderFields(
  patch: Partial<ProgramHeaderFields>,
  header: ProgramHeaderFields,
): Partial<ProgramHeaderFields> {
  const out: Partial<ProgramHeaderFields> = {};
  if (patch.title !== undefined) out.title = header.title;
  if (patch.shop !== undefined) out.shop = header.shop;
  if (patch.workshopId !== undefined) out.workshopId = header.workshopId;
  if (patch.periodStart !== undefined) out.periodStart = header.periodStart;
  if (patch.periodEnd !== undefined) out.periodEnd = header.periodEnd;
  if (patch.status !== undefined) out.status = header.status;
  if (patch.signatureSlots !== undefined) out.signatureSlots = header.signatureSlots;
  if (patch.signatureTemplateId !== undefined) out.signatureTemplateId = header.signatureTemplateId;
  return out;
}

/**
 * Что уходит на сервер по программе. Часть = null — эту часть не трогаем:
 * шапка и строки шлются отдельно, чтобы правка шапки не переписывала строки
 * (замена набора — полная, и лишняя отправка строк сняла бы чужую строку).
 */
type PendingSave = {
  rows: DraftRow[] | null;
  header: ProgramHeaderFields | null;
};

/**
 * Слепок значимых полей строки: по нему видно, что зеркало догнало нашу правку.
 * Порядок (№ п/п) сюда не входит намеренно: чужое добавление двигателя сдвигает
 * номера у нас, и по номеру мы бы ждали зеркала вечно.
 *
 * Отметка оператора (operatorNote) входит: она ставится своей дверью, и без неё
 * в слепке живое обновление реплики сняло бы отметку с экрана через 15 секунд —
 * ровно тот класс, что «двигатель пропадал через несколько секунд».
 */
function rowContentSignature(row: {
  id?: string | null;
  groupLabel?: string | null;
  engineId?: string | null;
  state?: string | null;
  shippingPlanAt?: number | null;
  factors?: string | null;
  note?: string | null;
  operatorNote?: string | null;
}): string {
  return [
    String(row.id ?? ''),
    String(row.groupLabel ?? ''),
    String(row.engineId ?? ''),
    String(row.state ?? ''),
    String(row.shippingPlanAt ?? ''),
    String(row.factors ?? ''),
    String(row.note ?? ''),
    String(row.operatorNote ?? ''),
  ].join('\u0001');
}

/** Строка плана на экране: снимок строки + живые данные карточки двигателя. */
type ScreenRow = {
  row: DraftRow;
  engine: EngineListItem | null;
  /** Живая подпись «Организация»: заказчик + три цифры номера договора. */
  organization: string;
  /**
   * Сквозной «№ п/п» — по позиции показа, а не по карте по id.
   *
   * Карта нумерации по идентификатору строки слепа к двум бедам: строка без
   * идентификатора в неё не попадает (номер пустой), а две строки с одинаковым
   * идентификатором делят один номер (повтор и пропуск сквозного). Номер по
   * позиции показа от обеих бед свободен.
   */
  global: number;
  /** «№ п/п» внутри своего договора — с единицы в каждом договоре. */
  inContract: number;
};

/** Статус программы: подпись и цвет плашки. */
const PROGRAM_STATUS_LABELS: Record<string, string> = {
  draft: 'Черновик',
  approved: 'Утверждён',
};

/**
 * Цвета статуса (владелец 10.11.2026: «подбери сам»).
 * Черновик — бледный серый (не спорит с зелёным утверждения), утверждён — зелёный.
 */
const PROGRAM_STATUS_TONES: Record<string, { bg: string; border: string; text: string }> = {
  draft: { bg: '#f1f5f9', border: '#cbd5e1', text: '#475569' },
  approved: { bg: '#dcfce7', border: '#86efac', text: '#166534' },
};

/**
 * Префикс маркера строки-заголовка группы (`data-list-row-key`).
 *
 * Кит считает прямоугольники строк по этому маркеру, поэтому заголовок группы
 * отличается от строки движка префиксом: иначе «цель» перетаскивания нельзя
 * отличить от обычной строки.
 */
const GROUP_ROW_PREFIX = 'group:';

/**
 * Метка варианта «цех не из справочника» в поле «Цех».
 *
 * Программы, заведённые ДО появления связи (`workshopId`), хранят цех текстом.
 * Они должны остаться видимыми и сохраняемыми — поэтому такой цех показан
 * отдельным вариантом, а не пропадает молча.
 */
const LEGACY_SHOP_VALUE = '__legacy_shop__';

/**
 * Пауза перед повтором отправки после отказа (обрыв связи).
 *
 * Правка при этом не теряется: снимок лежит в очереди и уйдёт, как только
 * связь восстановится.
 */
const RETRY_DELAY_MS = 5000;

function isoDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIsoDate(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : null;
}

/** Подпись состояния строки плана (в печати, копии и письме — одна и та же). */
function programStateLabel(state: string | null | undefined): string {
  const key = String(state ?? '').trim();
  if (!key) return '';
  return PRODUCTION_PROGRAM_STATE_LABELS[key as keyof typeof PRODUCTION_PROGRAM_STATE_LABELS] ?? key;
}

export function ProductionProgramPage(props: Props) {
  const [programs, setPrograms] = useState<ProductionProgramDto[]>([]);
  const [lines, setLines] = useState<ProductionProgramLineDto[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [pickerContract, setPickerContract] = useState<string>('');
  const [pickerEngine, setPickerEngine] = useState<string>('');
  // Превью печати открыто? Данные для него — общая модель печати (`programPrintInput`),
  // из неё же собираются выгрузка в файл, письмо и буфер обмена.
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  /** Что собираем в файл прямо сейчас («В Word» / «В Excel»). */
  const [exportBusy, setExportBusy] = useState<'docx' | 'xlsx' | null>(null);
  // Вид периода: null — показываем вид, выведенный из самих дат.
  const [periodKindOverride, setPeriodKindOverride] = useState<ProductionProgramPeriodKind | null>(null);
  // Номер договора, подтянутый из строгой реплики: в строке двигателя его может не
  // быть (контракт создан мимо EAV), а подпись должна оставаться человеческой.
  const [resolvedContractNumbers, setResolvedContractNumbers] = useState<Record<string, string>>({});
  // Сотрудники — для подписей ПП: если по должности нашёлся сотрудник, печатаем ФИО из
  // его карточки; если нет — ФИО из документа-образца (вносить подписантов в кадровый
  // реестр нельзя: это засоряет реестр и попадает под гейт дублей).
  const [employees, setEmployees] = useState<WorkOrderSignatureEmployee[]>([]);
  // Реестр этапов ремонта (серверный справочник; без сервера — статика шага 1):
  // из него меню выбора этапа в колонке «Этап».
  const [stageTemplates, setStageTemplates] = useState<RepairStageTemplate[]>([...DEFAULT_REPAIR_STAGE_TEMPLATES]);
  /**
   * Шаблоны подписей ПП (промт КАРМАНА #120): общий для завода набор подписей,
   * который подставляется в новые программы.
   *
   * Живут на сервере (таблица вне sync-контракта), поэтому клиент держит свой
   * кэш: список перечитывается при открытии страницы и после правки шаблона,
   * а при недоступном сервере остаётся последний увиденный — окно печати
   * открывается и без сети.
   */
  const [signatureTemplates, setSignatureTemplates] = useState<ProductionProgramSignatureTemplate[]>([]);
  // Справочник цехов — поле «Цех» в модалке этапа.
  const [workshops, setWorkshops] = useState<Array<{ id: string; label: string }>>([]);
  /** Открытая модалка этапа: строка плана, двигатель и выбранный этап. */
  const [stageDialog, setStageDialog] = useState<{
    rowId: string;
    engineId: string;
    engineLabel: string;
    code: string;
  } | null>(null);
  /** Строка, которой сейчас пишется этап (её выборку нельзя дёргать повторно). */
  const [stageBusyRowId, setStageBusyRowId] = useState<string | null>(null);
  /** Модалка «Добавить двигатели списком» открыта? (промт КАРМАНА #64) */
  const [addByNumbersOpen, setAddByNumbersOpen] = useState(false);
  /** ПКМ-меню строк плана: где открыто и какие строки в выделении. */
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  /** Письмо по выделенным строкам — окно письма (контекстное меню, пункт «почта»). */
  const [mailSelection, setMailSelection] = useState<{ subject: string; summary: string[]; body: string } | null>(null);
  /** Вид договора по его id — кэш на сессию: перепроверка спрашивает его каждый проход. */
  const contractKindCacheRef = useRef<Map<string, 'military' | 'civil' | null>>(new Map());

  // ── Правка плана: грязный экран, автосохранение и защита от отстающего зеркала ──
  // Баг владельца 19.11.2026: двигатель, добавленный в производственную программу,
  // пропадал через несколько секунд. Причина клиентская: строки жили только в
  // памяти (автосохранения не было — писала только кнопка «Сохранить»), а живое
  // обновление реплики (15 с) перечитывало её целиком и затирало несохранённое.
  // Теперь: пока правка не уехала — реплика её не трогает, и она уезжает сама.
  // Тот же гейт, что в карточке контракта (канон #1240).
  /** Программы с несохранённой правкой — для явной пометки на экране. */
  const [unsavedProgramIds, setUnsavedProgramIds] = useState<string[]>([]);
  const unsavedRef = useRef<Set<string>>(new Set());
  /** Что ушли на сервер и какие строки сняли — по этому ждём зеркало. */
  const pendingSyncRef = useRef<Map<string, { sent: string[]; removedIds: string[] }>>(new Map());
  /**
   * Шапка, которую правят на экране: пока зеркало не догнало — держим свою.
   *
   * Держим ТОЛЬКО правленые поля: если держать здесь весь снимок из реплики,
   * то отставшее зеркало тянет на экран устаревшее значение (в том числе
   * подписи) — и правка «то появляется, то исчезает» возвращается (класс M118:
   * сравнение «тот же список» по полям, в которые забыли новое поле).
   */
  const headerOverrideRef = useRef<Map<string, Partial<ProgramHeaderFields>>>(new Map());
  /**
   * Поля шапки, которые оператор правил и которые сервер ещё не принял.
   *
   * По ним собирается PATCH: уходят только эти поля ⇒ правка названия
   * программы не затирает подписи, а сервер не получает «очистить подписи»
   * там, где оператор подписи не трогал.
   */
  const headerDirtyRef = useRef<Map<string, Set<ProgramHeaderField>>>(new Map());
  /** Строки на экране — снимок для автосохранения. */
  const rowsRef = useRef<DraftRow[]>([]);
  /** Строки, которые мы правили, — по программе: переключение программ не теряет правку. */
  const localRowsRef = useRef<Map<string, DraftRow[]>>(new Map());
  /** Последняя реплика — по ней дополняем набор перед записью (чужую строку не снимаем). */
  const linesRef = useRef<ProductionProgramLineDto[]>([]);
  /** Отложенное автосохранение: программа → снимок строк и шапки. */
  const pendingSaveRef = useRef<Map<string, PendingSave>>(new Map());
  const autosaveTimerRef = useRef<number | null>(null);
  /** Повтор отправки после отказа: правка не должна пропасть из-за обрыва связи. */
  const retryTimerRef = useRef<number | null>(null);
  /** Сброс очереди для повтора — чтобы не завязывать ссылки в цикл. */
  const flushRef = useRef<(() => void) | null>(null);

  /** Правка ещё не уехала на сервер — помечаем программу. */
  const markUnsaved = useCallback((programId: string) => {
    unsavedRef.current.add(programId);
    setUnsavedProgramIds((prev) => (prev.includes(programId) ? prev : [...prev, programId]));
  }, []);

  /** Правка уехала — пометку снимаем. */
  const markSaved = useCallback((programId: string) => {
    unsavedRef.current.delete(programId);
    setUnsavedProgramIds((prev) => prev.filter((id) => id !== programId));
  }, []);

  /**
   * Запись программы: шапка (PATCH) и строки (полная замена набора).
   * Единственная дверь записи строк — как чинили 10.11 (постоянные id строк,
   * номера п/п по позиции). Отказ сервера оставляем на экране: правка остаётся
   * «несохранённой», а ошибка называет виновную строку («строка 3: …»).
   */
  const persistRows = useCallback(
    async (programId: string, payload: PendingSave): Promise<boolean> => {
      if (payload.header) {
        const h = payload.header;
        // В PATCH уходят ТОЛЬКО те поля шапки, которые оператор правил сам.
        //
        // Раньше сюда сваливался весь снимок шапки из реплики, а реплика
        // отстаёт на минуту: правка названия уезжала с подписями `null`, и
        // сервер трактовал `null` как «очистить подписи» ⇒ подпись стиралась
        // на сервере (жалоба владельца 24.11.2026).
        const dirty = headerDirtyRef.current.get(programId) ?? new Set<ProgramHeaderField>();
        const sentFields: ProgramHeaderField[] = [];
        const args: {
          id: string;
          periodStart?: number;
          periodEnd?: number;
          shop?: string;
          workshopId?: string | null;
          title?: string;
          status?: string;
          signatureSlots?: string | null;
          signatureTemplateId?: string | null;
        } = { id: programId };
        if (dirty.has('title')) {
          args.title = h.title;
          sentFields.push('title');
        }
        if (dirty.has('shop')) {
          args.shop = h.shop;
          sentFields.push('shop');
        }
        if (dirty.has('workshopId')) {
          args.workshopId = h.workshopId;
          sentFields.push('workshopId');
        }
        if (dirty.has('periodStart')) {
          args.periodStart = h.periodStart;
          sentFields.push('periodStart');
        }
        if (dirty.has('periodEnd')) {
          args.periodEnd = h.periodEnd;
          sentFields.push('periodEnd');
        }
        if (dirty.has('status')) {
          args.status = h.status;
          sentFields.push('status');
        }
        if (dirty.has('signatureSlots')) {
          args.signatureSlots = h.signatureSlots;
          sentFields.push('signatureSlots');
        }
        if (dirty.has('signatureTemplateId')) {
          args.signatureTemplateId = h.signatureTemplateId;
          sentFields.push('signatureTemplateId');
        }
        if (sentFields.length > 0) {
          const res = await window.matrica.productionProgram.update(args);
          if (!res.ok) {
            setError(res.error);
            setStatus('');
            return false;
          }
          // Принятое сервером поле из «правленых» убираем — но только если
          // оператор не успел изменить его ещё раз, пока правка летела.
          const current = headerOverrideRef.current.get(programId);
          const dirtyNow = headerDirtyRef.current.get(programId);
          if (dirtyNow) {
            for (const field of sentFields) {
              if (headerOverrideValue(current, field) !== args[field]) continue;
              dirtyNow.delete(field);
            }
            if (dirtyNow.size === 0) headerDirtyRef.current.delete(programId);
          }
        }
      }
      if (!payload.rows) {
        // Правлена только шапка — строки не трогаем (замена набора — полная).
        setError('');
        markSaved(programId);
        setStatus('Сохранено на сервере. На остальные компьютеры придёт при синхронизации (до минуты).');
        return true;
      }
      // Замена набора — полная: сервер снимает строку, которой нет в наборе.
      // Значит в набор надо положить и те строки, которых мы не знали, но которые
      // уже есть в реплике (строку соседа с другого компьютера снимать нельзя).
      // Снятые НАМИ строки при этом исключены — иначе они воскреснут.
      const removed = pendingSyncRef.current.get(programId)?.removedIds ?? [];
      const known = new Set(payload.rows.map((r) => String(r.id)));
      const foreign = linesRef.current.filter(
        (l) => l.programId === programId && !known.has(String(l.id)) && !removed.includes(String(l.id)),
      );
      const sentRows = [
        ...payload.rows,
        ...foreign.map((l) => ({
          id: String(l.id),
          orderNo: 0,
          contractId: l.contractId,
          groupLabel: l.groupLabel,
          contractKind: l.contractKind,
          engineId: l.engineId,
          engineMark: l.engineMark,
          engineNumber: l.engineNumber,
          state: l.state,
          shippingPlanAt: l.shippingPlanAt,
          factors: l.factors,
          note: l.note,
        })),
      ];
      console.log('[PP-AUTOSAVE] persist program=', programId, 'sent=', sentRows.length, 'known=', known.size, 'foreign=', foreign.length);
      const res = await window.matrica.productionProgram.saveRows({
        id: programId,
        rows: sentRows.map((r, i) => ({
          id: r.id,
          orderNo: i + 1,
          contractId: r.contractId ?? null,
          groupLabel: r.groupLabel,
          contractKind: r.contractKind ?? null,
          engineId: r.engineId ?? null,
          engineMark: r.engineMark ?? '',
          engineNumber: r.engineNumber ?? '',
          state: r.state ?? null,
          shippingPlanAt: r.shippingPlanAt ?? null,
          factors: r.factors ?? '',
          note: r.note ?? '',
        })),
      });
      if (!res.ok) {
        setError(res.error);
        setStatus('');
        return false;
      }
      setError('');
      markSaved(programId);
      const pending = pendingSyncRef.current.get(programId) ?? { sent: [], removedIds: [] };
      pendingSyncRef.current.set(programId, {
        ...pending,
        sent: payload.rows.map((r) => rowContentSignature(r)),
      });
      setStatus('Сохранено на сервере. На остальные компьютеры придёт при синхронизации (до минуты).');
      return true;
    },
    [markSaved],
  );

  /** Повтор отправки после отказа — правка не должна ждать следующего клика. */
  const scheduleRetry = useCallback(() => {
    if (retryTimerRef.current != null) return;
    retryTimerRef.current = window.setTimeout(() => {
      retryTimerRef.current = null;
      flushRef.current?.();
    }, RETRY_DELAY_MS);
  }, []);

  /**
   * Отказ записи: снимок возвращается в очередь.
   *
   * Раньше снимок автосэйва снимался с очереди ДО записи, и при отказе
   * (обрыв связи) правка просто исчезала — оператор терял, например, состав
   * подписей. Теперь снимок ждёт в очереди и уходит, как только связь вернётся.
   */
  const requeueSave = useCallback(
    (programId: string, payload: PendingSave) => {
      const pending = pendingSaveRef.current.get(programId) ?? { rows: null, header: null };
      pendingSaveRef.current.set(programId, {
        rows: payload.rows ?? pending.rows,
        header: payload.header ?? pending.header,
      });
      markUnsaved(programId);
      setStatus('Правка не сохранена — осталась в очереди и уйдёт, как только связь восстановится.');
      scheduleRetry();
    },
    [markUnsaved, scheduleRetry],
  );

  /**
   * Обёртка записи: обрыв связи (сервер недоступен, сеть легла) — это тоже
   * нужно показать. Без неё исключение из моста глоталось, и оператор видел
   * «Правка не сохранена» без причины — молчание вместо ответа.
   */
  const persist = useCallback(
    async (programId: string, payload: PendingSave): Promise<boolean> => {
      try {
        const ok = await persistRows(programId, payload);
        if (!ok) requeueSave(programId, payload);
        return ok;
      } catch (e) {
        setError(`Не удалось записать: ${String(e instanceof Error ? e.message : e)}`);
        setStatus('');
        requeueSave(programId, payload);
        return false;
      }
    },
    [persistRows, requeueSave],
  );

  /**
   * Сброс отложенного сохранения: снимки уходят на сервер.
   *
   * Отдельная функция — ею пользуются и автосэйв, и повтор после отказа.
   */
  const flushPendingSaves = useCallback(() => {
    const pendingSaves = [...pendingSaveRef.current.entries()];
    pendingSaveRef.current.clear();
    for (const [pid, snapshot] of pendingSaves) void persist(pid, snapshot);
  }, [persist]);

  // Сброс зовёт запись, а запись при отказе — сброс: без ссылки цикл ссылок
  // не завязать (правило react-hooks/exhaustive-deps).
  useEffect(() => {
    flushRef.current = flushPendingSaves;
  }, [flushPendingSaves]);

  /**
   * Автосохранение: ушедшая правка не должна зависеть от кнопки «Сохранить» —
   * «забыл нажать» больше не значит «потерял». Снимок берём на момент правки,
   * поэтому переключение программы не съедает правку предыдущей.
   */
  const scheduleAutosave = useCallback(
    (programId: string, payload: PendingSave) => {
      if (!props.canEdit) return;
      // Правки складываются: правка шапки не должна отменять ушедшие строки.
      const pending = pendingSaveRef.current.get(programId) ?? { rows: null, header: null };
      pendingSaveRef.current.set(programId, {
        rows: payload.rows ?? pending.rows,
        header: payload.header ?? pending.header,
      });
      if (autosaveTimerRef.current != null) window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = window.setTimeout(() => {
        autosaveTimerRef.current = null;
        flushPendingSaves();
      }, 1200);
    },
    [props.canEdit, flushPendingSaves],
  );

  /**
   * Правка строк на экране: обновляем снимок, помечаем программу и ставим
   * автосохранение. Снимок для отправки — из текущего состояния строк.
   */
  const applyRows = useCallback(
    (updater: (prev: DraftRow[]) => DraftRow[], programId: string | null) => {
      if (!programId) return;
      const next = updater(rowsRef.current);
      rowsRef.current = next;
      localRowsRef.current.set(programId, next);
      setRows(next);
      markUnsaved(programId);
      scheduleAutosave(programId, { rows: next, header: null });
    },
    [markUnsaved, scheduleAutosave],
  );

  // ── Этап двигателя: запись из плана в историю ремонта ──
  // Заказ владельца 20.11.2026: этап меняется прямо из производственной программы,
  // и заносится он ПОЛНОСТЬЮ — как строка истории ремонта (с датой, цехом,
  // примечанием), а не как «статус в плане».
  //
  // Поэтому пишем тем же путём, что и карточка: `workSheets:stages:save` →
  // `saveRepairStageRow`. Все гейты (субординация дат, дубль за день, возврат
  // назад) — те же самые, иначе из плана можно было бы сломать историю.

  /** Открыть модалку этапа для строки плана. */
  const openStageDialog = useCallback(
    (rowId: string, engineId: string, engineLabel: string, code: string) => {
      if (!props.canEdit || !props.canEditStages) return;
      setStageBusyRowId(rowId);
      setStageDialog({ rowId, engineId, engineLabel, code });
    },
    [props.canEdit, props.canEditStages],
  );

  /**
   * Запись этапа из модалки.
   *
   * Две записи, два хранилища, и они НЕОДНОРОДНЫ:
   *  · этап — в историю ремонта двигателя (`operations`), тем же путём, что карточка;
   *  · «Срок по плану» — в строку плана (`shippingPlanAt`), тем же путём, что любая
   *    правка строки (автосохранение).
   * Сначала пишем этап: он главный. Срок не записываем, если этап не записался —
   * иначе оператор увидит «срок есть», а этап не встанет.
   */
  const submitStage = useCallback(
    async (args: ProductionProgramStageSubmitArgs): Promise<ProductionProgramStageSubmitResult> => {
      const dialog = stageDialog;
      if (!dialog) return { ok: false, error: 'Этап не выбран' };
      const programId = selectedId;
      const atMs = parseIsoDate(args.date);
      if (atMs == null) return { ok: false, error: 'Укажите дату, когда этап был завершён' };
      const wsLabel = workshops.find((w) => w.id === args.workshopId)?.label ?? '';
      try {
        const res = await window.matrica.workSheets.stages.save({
          id: crypto.randomUUID(),
          engineId: dialog.engineId,
          code: args.code,
          atMs,
          ...(args.note.trim() ? { note: args.note.trim() } : {}),
          ...(args.workshopId ? { workshopId: args.workshopId } : {}),
          ...(wsLabel ? { workshopName: wsLabel } : {}),
          ...(args.repeatPass ? { repeatPass: args.repeatPass } : {}),
          ...(args.confirmDefectDate ? { confirmDefectDate: true } : {}),
        });
        // Гейт утиля (промт КАРМАНА #170): этап у утильного двигателя не заводится — окно
        // спрашивает, отремонтирована ли деталь, и после «да» повторяет запись.
        if (handleScrapStageResult({ result: res, engineId: dialog.engineId, retry: (warning) => void submitStageRef.current?.(args).then(() => { if (warning) setStatus(warning); }) })) {
          return { ok: false, error: res.ok ? '' : res.error };
        }
        if (!res.ok) {
          // Вопросы гейтов (дубль за день, смена даты дефектовки) решает модалка.
          return {
            ok: false,
            error: res.error,
            ...(res.duplicate
              ? { duplicate: { nextPass: res.duplicate.nextPass, typeName: res.duplicate.typeName, atMs: res.duplicate.atMs } }
              : {}),
            ...(res.defectDateChange ? { defectDateChange: res.defectDateChange } : {}),
          };
        }
        // Этап записан — список двигателей перечитать, иначе колонка «Этап»
        // покажет прежнее состояние до следующего живого обновления.
        window.dispatchEvent(new Event('matrica:engines-changed'));
        // Срок по плану — в строку плана (счётчики «В срок / Просрочено»).
        const deadline = args.planDeadline ? parseIsoDate(args.planDeadline) : null;
        if (programId) {
          const current = rowsRef.current.find((r) => r.id === dialog.rowId)?.shippingPlanAt ?? null;
          if (deadline !== current) {
            applyRows(
              (prev) => prev.map((x) => (x.id === dialog.rowId ? { ...x, shippingPlanAt: deadline } : x)),
              programId,
            );
          }
        }
        setError('');
        setStatus(
          res.scrapHint
            ? `Этап записан в историю ремонта двигателя. ${res.scrapHint}`
            : 'Этап записан в историю ремонта двигателя. На остальные компьютеры придёт при синхронизации.',
        );
        return { ok: true };
      } catch (e) {
        return { ok: false, error: `Не удалось записать этап: ${String(e instanceof Error ? e.message : e)}` };
      }
    },
    [applyRows, selectedId, stageDialog, workshops],
  );

  /**
   * Последняя версия `submitStage` — для повтора записи этапа после снятия утиля
   * (промт КАРМАНА #170). Через ref, а не напрямую: иначе `useCallback` ссылался бы
   * сам на себя в своём же инициализаторе.
   */
  const submitStageRef = useRef<((args: ProductionProgramStageSubmitArgs) => Promise<ProductionProgramStageSubmitResult>) | null>(null);
  submitStageRef.current = submitStage;

  /** Закрыть модалку этапа. */
  const closeStageDialog = useCallback(() => {
    setStageDialog(null);
    setStageBusyRowId(null);
  }, []);

  const reload = useCallback(async () => {
    const res = await window.matrica.productionProgram.list();
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setError('');
    // Шапку, которую правят на экране, реплика не затирает: зеркало отстаёт на
    // минуту, и без этого правка «Название/Цех/Период/Статус» исчезала бы сама.
    setPrograms(
      res.rows.map((p) => {
        const override = headerOverrideRef.current.get(p.id);
        if (!override) return p;
        // Зеркало догоняет правку ПО ПОЛЯМ: как только оно показало наше поле,
        // поле отпускается и дальше ведёт сама реплика.
        //
        // Раньше сравнение перечисляло поля поимённо и подписей в списке не
        // было: как только остальные поля совпали, оверрайд снимался целиком,
        // и правка подписей пропадала с экрана до прихода зеркала — «подписи то
        // появляются, то исчезают» (класс M118: сравнение «тот же список» по
        // полям, в которые забыли добавить новое).
        const pending: Partial<ProgramHeaderFields> = {};
        if (override.title !== undefined && p.title !== override.title) pending.title = override.title;
        if (override.shop !== undefined && p.shop !== override.shop) pending.shop = override.shop;
        if (override.workshopId !== undefined && (p.workshopId ?? null) !== override.workshopId) {
          pending.workshopId = override.workshopId;
        }
        if (override.periodStart !== undefined && p.periodStart !== override.periodStart) {
          pending.periodStart = override.periodStart;
        }
        if (override.periodEnd !== undefined && p.periodEnd !== override.periodEnd) {
          pending.periodEnd = override.periodEnd;
        }
        if (override.status !== undefined && p.status !== override.status) pending.status = override.status;
        if (override.signatureSlots !== undefined && (p.signatureSlots ?? null) !== override.signatureSlots) {
          pending.signatureSlots = override.signatureSlots;
        }
        if (
          override.signatureTemplateId !== undefined &&
          (p.signatureTemplateId ?? null) !== override.signatureTemplateId
        ) {
          pending.signatureTemplateId = override.signatureTemplateId;
        }
        if (Object.keys(pending).length === 0) {
          // Зеркало показало нашу шапку — дальше реплика ведёт сама.
          headerOverrideRef.current.delete(p.id);
          return p;
        }
        headerOverrideRef.current.set(p.id, pending);
        return { ...p, ...pending };
      }),
    );
    setLines(res.lines);
    linesRef.current = res.lines;
    setSelectedId((prev) => prev ?? (res.rows[0]?.id ?? null));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Шаблоны подписей — перечитываем с сервера (клиентский кэш).
   *
   * Ошибку НЕ выносим в общую полосу ошибок: шаблоны — справочник, а без него
   * программа живёт как раньше. При недоступном сервере остаётся последний
   * увиденный список — окно печати открывается и без сети.
   */
  const reloadSignatureTemplates = useCallback(async () => {
    try {
      const res = await window.matrica.productionProgram.listSignatureTemplates();
      if (!res.ok) return;
      setSignatureTemplates(res.rows ?? []);
    } catch {
      // Сервер недоступен — держим прежний кэш.
    }
  }, []);

  useEffect(() => {
    void reloadSignatureTemplates();
  }, [reloadSignatureTemplates]);

  /**
   * «Применить шаблон»: подставляем состав шаблона в программу.
   *
   * Через `setHeader` — иначе потерялся бы автосейв: правка осталась бы на
   * экране, но не уехала бы на сервер.
   */
  const applySignatureTemplate = (templateId: string) => {
    const tpl = signatureTemplates.find((t) => t.id === templateId);
    if (!tpl) return;
    const slots = productionProgramSignatureTemplateSlots(tpl);
    setHeader({
      signatureSlots: serializePrintSignatureSlots(slots),
      signatureTemplateId: tpl.id,
    });
    setStatus(`Шаблон «${tpl.name}» применён`);
  };

  /**
   * «Сохранить как шаблон по умолчанию»: текущий состав программы — в шаблон.
   *
   * Имя спрашивает вызывающий (окно печати): без названия шаблон не найти.
   */
  const saveSignatureTemplateAsDefault = async (name: string) => {
    if (!selected) return;
    // Состав программы: сохранённый — как есть; null («не трогал») — роли по
    // умолчанию, иначе в шаблон ушёл бы ПУСТОЙ набор.
    const saved = selected.signatureSlots
      ? parseProductionProgramSignatureSlots(selected.signatureSlots)
      : null;
    const slots = resolveProductionProgramSignatureSlots(saved);
    if (slots.length === 0) {
      setError('В программе нет подписей — сохранять нечего');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.productionProgram.saveSignatureTemplate({
        name,
        slots: serializePrintSignatureSlots(slots),
        isDefault: true,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStatus('Шаблон сохранён');
      await reloadSignatureTemplates();
    } finally {
      setBusy(false);
    }
  };

  // План ведёт сервер, клиент читает реплику: только что созданный план приедет
  // публикацией зеркала и pull'ом — страница перечитывает список по этому событию.
  useLiveDataRefresh(
    async () => {
      await reload();
    },
    { domains: ['productionProgram'] },
  );

  useEffect(() => {
    void (async () => {
      try {
        const list = await window.matrica.employees.list();
        setEmployees(Array.isArray(list) ? (list as WorkOrderSignatureEmployee[]) : []);
      } catch {
        setEmployees([]);
      }
    })();
  }, []);

  // Реестр этапов и справочник цехов — для колонки «Этап» и её модалки.
  // Реестр: серверный справочник, а без сервера — статика шага 1 (та же
  // философа, что в карточке двигателя: без справочника экран честно говорит,
  // что работает на запасном списке). Цеха — по справочнику, как в карточке.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await window.matrica.workSheets.stages.templates.list();
        if (alive && res.ok && Array.isArray(res.templates) && res.templates.length > 0) {
          setStageTemplates(res.templates);
        }
      } catch {
        /* остаётся статика */
      }
      try {
        const res = await window.matrica.workshops.list({ activeOnly: true });
        if (alive && res.ok) {
          setWorkshops(res.rows.map((w) => ({ id: String(w.id), label: String(w.name || w.code) })));
        }
      } catch {
        /* цех остаётся пустым — этап запишется без цеха */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Номер договора подтягиваем из строгой реплики там, где в строке двигателя его нет
  // (контракт создан мимо EAV). Без этого подпись группы стала бы пустой или технической.
  useEffect(() => {
    const missing = new Set<string>();
    for (const e of props.engines) {
      const id = String(e.contractId ?? '');
      if (!id) continue;
      const number = String(e.contractName ?? '').trim();
      if (!number || looksLikeIdentifier(number)) missing.add(id);
    }
    if (missing.size === 0) return;
    let alive = true;
    void (async () => {
      for (const id of missing) {
        try {
          const res = await window.matrica.contracts.contract.get(id);
          const number = res.ok && res.row ? String(res.row.number ?? '').trim() : '';
          if (!alive) return;
          if (number && !looksLikeIdentifier(number)) {
            setResolvedContractNumbers((prev) => (prev[id] === number ? prev : { ...prev, [id]: number }));
          }
        } catch {
          // Договора нет в реплике — подпись останется без номера, но без идентификатора.
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.engines]);

  const selected = useMemo(() => programs.find((p) => p.id === selectedId) ?? null, [programs, selectedId]);

  // Строки выбранного плана — локальная копия для правки; сохранение уходит на сервер.
  useEffect(() => {
    if (!selectedId) {
      setRows([]);
      rowsRef.current = [];
      unsavedRef.current.clear();
      setUnsavedProgramIds([]);
      pendingSyncRef.current.clear();
      return;
    }
    const replicaRows = lines.filter((l) => l.programId === selectedId);
    const local = localRowsRef.current.get(selectedId);
    // Правка не уехала на сервер — реплика её не трогает (канон #1240).
    // Без этого гейта добавленный двигатель пропадал через 15 секунд.
    if (unsavedRef.current.has(selectedId) && local) {
      rowsRef.current = local;
      setRows(local);
      return;
    }
    // Зеркало программ публикуется раз в 60 с, а живое обновление приходит через
    // 15 с: между сохранением и публикацией реплика отдаёт СТАРУЮ версию строк.
    // Пока зеркало не догнало нашу правку — на экране держим свою.
    const pending = pendingSyncRef.current.get(selectedId);
    if (pending && local) {
      const replicaIds = new Set(replicaRows.map((l) => String(l.id)));
      // Зеркало догнало нашу правку — когда в реплике те же строки с теми же
      // значениями (а не просто те же id: правку ячейки зеркало ещё не показало).
      const mirrorCaughtUp = pending.sent.every((sig) => {
        const id = sig.split('\u0001')[0] ?? '';
        const row = replicaRows.find((l) => String(l.id) === id);
        return !!row && rowContentSignature(row) === sig;
      });
      const removedStillInMirror = pending.removedIds.some((id) => replicaIds.has(id));
      if (!mirrorCaughtUp || removedStillInMirror) {
        rowsRef.current = local;
        setRows(local);
        return;
      }
      pendingSyncRef.current.delete(selectedId);
    }
    const next = replicaRows.map((l) => ({
      id: l.id,
      orderNo: l.orderNo,
      contractId: l.contractId,
      groupLabel: l.groupLabel,
      contractKind: l.contractKind,
      engineId: l.engineId,
      engineMark: l.engineMark,
      engineNumber: l.engineNumber,
      state: l.state,
      shippingPlanAt: l.shippingPlanAt,
      factors: l.factors,
      note: l.note,
      operatorNote: l.operatorNote ?? null,
    }));
    rowsRef.current = next;
    localRowsRef.current.set(selectedId, next);
    setRows(next);
  }, [lines, selectedId]);

  // Уход со страницы не должен терять правку: отложенное автосохранение уходит
  // сразу, а не ждёт таймер на размонтированной странице.
  useEffect(() => {
    // Ссылки берём здесь: между постановкой эффекта и размонтированием
    // значение ref могло смениться (правило react-hooks/exhaustive-deps).
    const pendingSaves = pendingSaveRef;
    const timer = autosaveTimerRef;
    return () => {
      if (timer.current != null) window.clearTimeout(timer.current);
      const pendingSavesNow = [...pendingSaves.current.entries()];
      pendingSaves.current.clear();
      for (const [pid, snapshot] of pendingSavesNow) void persist(pid, snapshot);
    };
  }, [persist]);

  const engineById = useMemo(() => new Map(props.engines.map((e) => [String(e.id), e])), [props.engines]);

  /**
   * Меню этапов — один раз на набор шаблонов (список общий для всех строк).
   * «Сейчас» помечается в ячейке сравнением с этапом двигателя: иначе на каждый
   * ряд пришлось бы собирать свой список — на каждый ввод в «Примечании».
   */
  const stageMenuOptions = useMemo(() => productionProgramStageOptions(stageTemplates, null), [stageTemplates]);

  /**
   * Цех по умолчанию для этапа: цех программы, если он есть в справочнике цехов.
   *
   * Цех программы — теперь связь по id (`workshopId`, владелец 24.11.2026), а этап
   * пишет цех по справочнику (id + снимок имени) — так что связь переносится напрямую.
   * У программ, заведённых до связи, id нет: остаётся сверка по названию, а если и
   * цеха в справочнике нет — поле пустое.
   */
  const defaultWorkshopId = useMemo(() => {
    const linkedId = String(selected?.workshopId ?? '').trim();
    if (linkedId) return linkedId;
    const shop = String(selected?.shop ?? '').trim().toLowerCase();
    if (!shop) return '';
    const match = workshops.find((w) => w.label.trim().toLowerCase() === shop);
    return match?.id ?? '';
  }, [selected?.shop, selected?.workshopId, workshops]);

  /**
   * Варианты цеха в шапке: справочник + сохранённая связь.
   *
   * Если цех программы отключили (soft-delete), он не попадёт в активные — но
   * программа на него ссылается, и молча подменить её цех другим нельзя: связь
   * показываем отдельной строкой.
   */
  const shopOptions = useMemo(() => {
    const opts = workshops.map((w) => ({ id: w.id, label: w.label, missing: false }));
    const currentId = String(selected?.workshopId ?? '').trim();
    if (currentId && !opts.some((o) => o.id === currentId)) {
      opts.push({
        id: currentId,
        label: String(selected?.shop ?? '').trim() || 'цех из справочника',
        missing: true,
      });
    }
    return opts;
  }, [workshops, selected?.shop, selected?.workshopId]);

  /** Цех программы, заведённой до появления связи: текст без id. */
  const legacyShopText = useMemo(() => {
    if (!selected) return '';
    if (String(selected.workshopId ?? '').trim()) return '';
    return String(selected.shop ?? '').trim();
  }, [selected]);

  /** Что выбрано в поле «Цех»: id цеха, либо метка legacy-текста, либо пусто. */
  const shopChoice =
    String(selected?.workshopId ?? '').trim() || (legacyShopText ? LEGACY_SHOP_VALUE : '');

  /** Номер договора по его id: из карточки двигателя, иначе — из строгой реплики. */
  const contractNumberById = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of props.engines) {
      const id = String(e.contractId ?? '');
      if (!id) continue;
      const number = String(e.contractName ?? '').trim();
      if (number && !looksLikeIdentifier(number) && !map.has(id)) map.set(id, number);
    }
    for (const [id, number] of Object.entries(resolvedContractNumbers)) map.set(id, number);
    return map;
  }, [props.engines, resolvedContractNumbers]);

  /** Живой номер договора для конкретного двигателя (с подстановкой из реплики). */
  const contractNumberOf = useCallback(
    (engine: EngineListItem | null | undefined): string => {
      if (!engine) return '';
      const raw = String(engine.contractName ?? '').trim();
      if (raw && !looksLikeIdentifier(raw)) return raw;
      const id = String(engine.contractId ?? '').trim();
      return id ? String(contractNumberById.get(id) ?? '') : '';
    },
    [contractNumberById],
  );

  /** Договоры для выпадашки: подпись — заказчик и номер (поиск идёт по обоим). */
  const contracts = useMemo(() => {
    const organizationById = new Map<string, string>();
    for (const e of props.engines) {
      const id = String(e.contractId ?? '');
      if (!id) continue;
      if (!organizationById.has(id)) organizationById.set(id, String(e.customerName ?? '').trim());
    }
    return [...organizationById.keys()].map((id) => ({
      id,
      label:
        productionProgramContractLabel({
          organization: organizationById.get(id),
          contractNumber: contractNumberById.get(id),
        }) || 'Договор без номера',
    }));
  }, [props.engines, contractNumberById]);

  const contractOptions = useMemo(() => contracts.map((c) => ({ id: c.id, label: c.label })), [contracts]);

  /**
   * Двигатели для выпадашки: все, если договор не выбран, иначе — его двигатели.
   * Выбор двигателя подтягивает договор из карточки (поиски взаимозаменяемы).
   */
  const engineOptions = useMemo(() => {
    const list = pickerContract ? props.engines.filter((e) => String(e.contractId ?? '') === pickerContract) : props.engines;
    return list.map((e) => ({
      id: String(e.id),
      label: [e.engineBrand, e.engineNumber].filter(Boolean).join(' ') || String(e.id),
    }));
  }, [props.engines, pickerContract]);

  /** Живая подпись договора (шапка группы): заказчик и полный номер. */
  const contractLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contracts) map.set(c.id, c.label);
    return map;
  }, [contracts]);

  /**
   * Две нумерации строк: общая по программе и своя внутри договора. Считаются
   * по позиции **показа** — после перетаскивания сохранённые номера разъезжаются,
   * и цифры на экране перестают быть правдой.
   *
   * План нумерации доменный (`productionProgramNumberingPlan`): в нём и порядок
   * показа, и оба номера. Экран, печатный лист и файл выгрузки берут его же —
   * одна считалка на три места, иначе цифры разъезжаются.
   */
  const numberingPlan = useMemo(() => productionProgramNumberingPlan(rows), [rows]);

  /**
   * Строка плана на экране — сгруппирована по договору (владелец 10.11.2026).
   *
   * Порядок групп — **как в печати**: по порядку строк (порядок первого
   * появления), а не по названию договора. Иначе экран и печать показывают
   * разный порядок, и перетащить группу некуда. Раньше тут стояла сортировка по
   * названию — её убрали 20.11.2026 (план нити «порядок»).
   *
   * Строки идут в **порядке показа** из домена (`productionProgramNumberingPlan`):
   * группы собраны вместе, а сквозной номер посчитан по этому порядку. Номер по
   * позиции в плоском массиве на экране прыгал: строки одного договора в массиве
   * разбросаны, и показ их переставлял.
   */
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; items: ScreenRow[] }>();
    for (const index of numberingPlan.displayOrder) {
      const row = rows[index]!;
      const engine = engineById.get(String(row.engineId ?? '')) ?? null;
      const contractId = String(row.contractId ?? '');
      const organization =
        productionProgramOrganizationLabel({
          customerName: engine?.customerName ?? null,
          contractNumber: contractNumberOf(engine),
        }) || String(row.groupLabel ?? '');
      const label = contractLabelById.get(contractId) || String(row.groupLabel ?? '') || 'Без договора';
      // Ключ группы — доменный (`productionProgramGroupKey`): он же у печати, у
      // выгрузки и у перетаскивания. Свой ключ на экране (только договор) делил
      // строки по группам иначе, чем лист, — и цифры разъезжались.
      const key = productionProgramGroupKey(row);
      let group = byKey.get(key);
      if (!group) {
        group = { key, label, items: [] };
        byKey.set(key, group);
      }
      group.items.push({
        row,
        engine,
        organization,
        global: numberingPlan.global[index] ?? 0,
        inContract: numberingPlan.inContract[index] ?? 0,
      });
    }
    return [...byKey.values()];
  }, [rows, numberingPlan, engineById, contractLabelById, contractNumberOf]);

  /**
   * Перетаскивание строк плана — **общий слой кита** (промт КАРМАНА #67, шов с ПП).
   *
   * Состояние перетаскивания больше не живёт в странице: его держит `useListDrag`.
   * Раньше здесь был свой `useState`, и отменённое перетаскивание (Esc или drop мимо
   * строки) оставляло страницу «залипшей» — состояние гасло только при следующем drop.
   *
   * Смысл перестановки — прежний и доменный: двигатель едет **в пределах своего
   * договора**, группа (договор со своим блоком) — целиком. Кит считает механику
   * (место вставки, подсветку, сброс), домен — куда именно встать.
   */
  const listBehavior = useListBehaviorSettings();
  const dragLayer = useListDrag({ enabled: props.canEdit });

  /**
   * Доменный ключ группы (договор + подпись) — по строкам и по группам экрана.
   *
   * Перестановка в ПП групповая: двигатель едет внутри своего договора, а договор
   * уезжает со своим блоком. Киту это знать не нужно — он считает место вставки,
   * а «свой или чужой договор» решает домен.
   */
  const groupKeys = useMemo(() => {
    const byRowId = new Map<string, string>();
    const lastRowIdByGroup = new Map<string, string>();
    const rowIds = new Set<string>();
    for (const group of groups) {
      // Ключ группы — доменный: он уже в ключе самой группы (общий с печатью).
      const domainKey = group.key;
      for (const item of group.items) {
        const rowId = String(item.row.id);
        byRowId.set(rowId, domainKey);
        lastRowIdByGroup.set(domainKey, rowId);
        rowIds.add(rowId);
      }
    }
    return { byRowId, lastRowIdByGroup, rowIds };
  }, [groups]);

  /** Порядок строк не изменился — перестановку незачем сохранять. */
  const sameRowOrder = useCallback(
    (a: readonly DraftRow[], b: readonly DraftRow[]) =>
      a.length === b.length && a.every((row, idx) => String(row.id) === String(b[idx]?.id ?? '')),
    [],
  );

  /** Двигатель встал на место: перед целевой строкой или после неё. */
  const dropRow = (sourceRowId: string, targetRowId: string, side: ProductionProgramDropSide) => {
    const current = rowsRef.current;
    const next = productionProgramMoveRowWithinGroup(current, sourceRowId, targetRowId, side);
    if (sameRowOrder(current, next)) return;
    applyRows(() => next, selectedId);
  };

  /** Группа (договор со своим блоком) встала на место целиком. */
  const dropGroup = (sourceGroupKey: string, targetGroupKey: string, side: ProductionProgramDropSide) => {
    const current = rowsRef.current;
    const next = productionProgramMoveGroup(current, sourceGroupKey, targetGroupKey, side);
    if (sameRowOrder(current, next)) return;
    applyRows(() => next, selectedId);
  };

  /**
   * Клавиатурное перемещение по ручке — общий кит в **групповом** режиме.
   *
   * Хвост шва с ПП: китовый `useListKeyboardMove` считал движение по плоскому списку,
   * а в ПП порядок групповой — двигатель едет внутри своего договора, договор — со
   * своим блоком. Кит получил групповой режим (`grouping`), и границы те же, что и
   * у мыши: те же доменные ключи групп (`productionProgramGroupKey`).
   */
  const moveGrouping = useMemo(() => {
    const groupKeyList: string[] = [];
    const rowKeysOf = new Map<string, string[]>();
    const groupOfRow = new Map<string, string>();
    for (const group of groups) {
      // Ключ группы — доменный: он уже в ключе самой группы (общий с печатью).
      const domainKey = group.key;
      const rowKeys = group.items.map((item) => String(item.row.id));
      groupKeyList.push(domainKey);
      rowKeysOf.set(domainKey, rowKeys);
      for (const rowKey of rowKeys) groupOfRow.set(rowKey, domainKey);
    }
    const grouping: ListMoveGrouping = {
      groupKeys: groupKeyList,
      rowKeysOf: (groupKey) => rowKeysOf.get(groupKey) ?? [],
      groupOfRow: (rowKey) => groupOfRow.get(rowKey) ?? null,
      isGroupHeader: (key) => rowKeysOf.has(key),
    };
    // Плоский порядок кита — блоки групп подряд: заголовок, затем его строки.
    const orderedIds = groupKeyList.flatMap((groupKey) => [groupKey, ...(rowKeysOf.get(groupKey) ?? [])]);
    return { grouping, orderedIds };
  }, [groups]);

  /** Новый порядок строк по порядку кита: заголовки групп — не строки, их пропускаем. */
  const applyProgramMove = useCallback(
    (order: string[]) => {
      const current = rowsRef.current;
      const byId = new Map(current.map((row) => [String(row.id), row]));
      const next: DraftRow[] = [];
      for (const key of order) {
        const row = byId.get(key);
        if (row) next.push(row);
      }
      // Строка, о которой новый порядок не сказал, не теряется молча.
      for (const row of current) if (!next.includes(row)) next.push(row);
      if (sameRowOrder(current, next)) return;
      applyRows(() => next, selectedId);
    },
    [applyRows, selectedId, sameRowOrder],
  );

  const programMove = useListKeyboardMove({
    enabled: props.canEdit && listBehavior.keyboardMove,
    orderedIds: moveGrouping.orderedIds,
    grouping: moveGrouping.grouping,
    onMove: applyProgramMove,
  });

  /**
   * Куда встанет перетаскиваемая группа.
   *
   * Внутри группы границы нет: блок двигается **между договорами**, а не внутри
   * чужого договора. Поэтому над заголовком — «перед этой группой», а над её
   * строками — по половине строки (верхняя: перед, нижняя: за блоком).
   */
  const groupDropTarget = useCallback(
    (targetKey: string, side: ProductionProgramDropSide) => {
      const isHeader = targetKey.startsWith(GROUP_ROW_PREFIX);
      const groupKey = isHeader ? targetKey.slice(GROUP_ROW_PREFIX.length) : groupKeys.byRowId.get(targetKey);
      if (!groupKey) return null;
      return { groupKey, side: isHeader ? ('before' as const) : side };
    },
    [groupKeys],
  );

  /**
   * Сброс перетаскивания: состояние гасит сам кит (по `dragend`/`drop` на уровне
   * документа), а источник мы читаем из `dataTransfer` — кит кладёт туда ключ
   * того, что тянут. Своего состояния про перетаскивание у страницы больше нет.
   */
  const handleDrop = (event: React.DragEvent<HTMLTableSectionElement>) => {
    const sourceKey = event.dataTransfer.getData('text/plain');
    dragLayer.drop(event, (target: ListDropTarget) => {
      if (!sourceKey) return;
      const targetKey = target.key ?? '';
      const side: ProductionProgramDropSide = target.position === 'after' ? 'after' : 'before';
      // Тянут строку — целью может быть только строка (заголовок группы — не цель).
      if (groupKeys.rowIds.has(sourceKey)) {
        if (!targetKey || targetKey.startsWith(GROUP_ROW_PREFIX)) return;
        dropRow(sourceKey, targetKey, side);
        return;
      }
      // Тянут группу — целью может быть и заголовок группы, и строка внутри неё.
      const groupTarget = groupDropTarget(targetKey, side);
      if (!groupTarget) return;
      dropGroup(sourceKey, groupTarget.groupKey, groupTarget.side);
    });
  };

  /**
   * Место вставки — одно, и оператор должен видеть его до отпускания мыши.
   *
   * Считает кит (общий слой), показывает страница: линия стоит там, куда встанет
   * перетаскиваемое, а там, куда встать нельзя, линии нет.
   */
  const dropMarker = useMemo(() => {
    const drag = dragLayer.drag;
    const target = dragLayer.dropTarget;
    if (!drag || !target || !listBehavior.dragVisual) return null;
    const side: ProductionProgramDropSide = target.position === 'after' ? 'after' : 'before';
    const targetKey = target.key ?? '';
    if (groupKeys.rowIds.has(drag.key)) {
      // Тянут строку: место вставки — у целевой строки и только внутри своего договора.
      if (!targetKey || targetKey.startsWith(GROUP_ROW_PREFIX) || targetKey === drag.key) return null;
      const from = groupKeys.byRowId.get(drag.key);
      const to = groupKeys.byRowId.get(targetKey);
      if (!from || !to || from !== to) return null;
      return { key: targetKey, edge: side === 'before' ? ('top' as const) : ('bottom' as const) };
    }
    // Тянут группу: место вставки — между группами.
    const groupTarget = groupDropTarget(targetKey, side);
    if (!groupTarget || groupTarget.groupKey === drag.key) return null;
    if (groupTarget.side === 'before') {
      return { key: `${GROUP_ROW_PREFIX}${groupTarget.groupKey}`, edge: 'top' as const };
    }
    const lastRowId = groupKeys.lastRowIdByGroup.get(groupTarget.groupKey);
    return lastRowId
      ? { key: lastRowId, edge: 'bottom' as const }
      : { key: `${GROUP_ROW_PREFIX}${groupTarget.groupKey}`, edge: 'bottom' as const };
  }, [dragLayer.drag, dragLayer.dropTarget, listBehavior.dragVisual, groupKeys, groupDropTarget]);

  /** Подсветка перетаскиваемого — стиль кита (приглушение + красная рамка). */
  const dragHighlight = useMemo(() => {
    const drag = dragLayer.drag;
    if (!drag || !listBehavior.dragVisual) return null;
    return listDragRowStyle(drag.key, drag.key);
  }, [dragLayer.drag, listBehavior.dragVisual]);

  /** Стиль строки плана: подсветка перетаскивания и линия места вставки. */
  const rowDragStyle = (rowId: string): React.CSSProperties => {
    const style: React.CSSProperties = {};
    const drag = dragLayer.drag;
    if (drag && listBehavior.dragVisual) {
      if (drag.key === rowId) {
        Object.assign(style, dragHighlight ?? {});
      } else if (
        !groupKeys.rowIds.has(drag.key) &&
        groupKeys.byRowId.get(drag.key) === groupKeys.byRowId.get(rowId) &&
        dragHighlight?.opacity !== undefined
      ) {
        // Тянут группу — её строки гаснут вместе с блоком.
        style.opacity = dragHighlight.opacity;
      }
    }
    if (dropMarker && dropMarker.key === rowId) {
      style.boxShadow = `inset 0 ${dropMarker.edge === 'top' ? '2px' : '-2px'} 0 ${LIST_DROP_INDICATOR_COLOR}`;
    }
    return style;
  };

  /** Стиль заголовка группы: подсветка перетаскиваемой группы и линия места вставки. */
  const groupHeaderStyle = (groupKey: string): React.CSSProperties => {
    const style: React.CSSProperties = {};
    const drag = dragLayer.drag;
    if (drag && listBehavior.dragVisual && drag.key === groupKey) {
      Object.assign(style, dragHighlight ?? {});
    }
    if (dropMarker && dropMarker.key === `${GROUP_ROW_PREFIX}${groupKey}`) {
      style.boxShadow = `inset 0 ${dropMarker.edge === 'top' ? '2px' : '-2px'} 0 ${LIST_DROP_INDICATOR_COLOR}`;
    }
    return style;
  };

  /**
   * Автоскролл у края списка — это прокрутка контейнера, поэтому кит должен знать
   * прокручиваемый элемент. У таблицы плана своего скролла нет (она едет в
   * прокрутке бокса карточки) — берём ближайшего прокручиваемого предка.
   */
  const listRootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = listRootRef.current;
    if (!root) return;
    let el: HTMLElement | null = root.parentElement;
    while (el) {
      const style = window.getComputedStyle(el);
      if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflow}`)) {
        dragLayer.scrollRef.current = el;
        return;
      }
      el = el.parentElement;
    }
    dragLayer.scrollRef.current = root;
  }, [dragLayer.scrollRef]);

  /**
   * Сводка выполнения по каждой программе — то, что показывается на плашке
   * («сколько двигателей ещё не собраны, невыполнены, сколько выполнено»).
   *
   * Считается по ЖИВОЙ карточке двигателя: ОТК пройден — «готов к отгрузке»,
   * отгружен — «выполнено»; срок — плановая отгрузка строки.
   */
  const summaryByProgram = useMemo(() => {
    const map = new Map<string, ProductionProgramExecutionSummary>();
    for (const p of programs) {
      map.set(
        p.id,
        productionProgramExecutionSummary({
          rows: lines.filter((l) => l.programId === p.id),
          engines: props.engines,
        }),
      );
    }
    return map;
  }, [programs, lines, props.engines]);

  /**
   * Правка шапки программы. Как и строки, шапка не должна пропадать сама:
   * реплика отстаёт на минуту, поэтому своё значение держим до того, как
   * зеркало его покажет (см. reload), и уходит оно само, без кнопки.
   */
  const setHeader = (patch: Partial<ProgramHeaderFields>) => {
    if (!selectedId || !selected) return;
    setPrograms((prev) => prev.map((p) => (p.id === selectedId ? { ...p, ...patch } : p)));
    const next = { ...selected, ...patch };
    const header: ProgramHeaderFields = {
      title: String(next.title ?? ''),
      shop: String(next.shop ?? ''),
      workshopId: next.workshopId == null ? null : String(next.workshopId),
      periodStart: Number(next.periodStart ?? 0),
      periodEnd: Number(next.periodEnd ?? 0),
      status: String(next.status ?? 'draft'),
      signatureSlots: next.signatureSlots ?? null,
      signatureTemplateId: next.signatureTemplateId ?? null,
    };
    // Оверрайд хранит ТОЛЬКО правленые поля: он держит на экране нашу правку,
    // пока зеркало её не показало. Если держать там весь снимок из реплики,
    // отставшее зеркало тянет на экран устаревшее значение (в том числе
    // подписи) — и правка «то появляется, то исчезает» вернулась бы.
    const changed = changedHeaderFields(patch, header);
    const override = headerOverrideRef.current.get(selectedId) ?? {};
    headerOverrideRef.current.set(selectedId, { ...override, ...changed });
    // Правленые поля — отдельно: в PATCH уходят только они (см. persistRows),
    // иначе правка названия затирала бы подписи на сервере.
    const dirty = headerDirtyRef.current.get(selectedId) ?? new Set<ProgramHeaderField>();
    for (const field of Object.keys(changed) as ProgramHeaderField[]) dirty.add(field);
    headerDirtyRef.current.set(selectedId, dirty);
    markUnsaved(selectedId);
    scheduleAutosave(selectedId, { rows: null, header });
  };

  /**
   * Выбор цеха в шапке: связь по id справочника + снимок имени для печати.
   *
   * Сервер — единственный авторитет: имя цеха он возьмёт из справочника сам, а
   * `shop` мы шлём снимком, чтобы печать и выгрузка не ждали сервер.
   */
  const applyWorkshopChoice = (value: string) => {
    if (value === LEGACY_SHOP_VALUE) {
      setHeader({ workshopId: null, shop: legacyShopText });
      return;
    }
    const chosen = shopOptions.find((o) => o.id === value);
    if (!chosen) return;
    setHeader({ workshopId: chosen.id, shop: chosen.label });
  };

  /** Смена программы: вид периода — по её датам. */
  const selectProgram = (id: string) => {
    setSelectedId(id);
    setPeriodKindOverride(null);
    setPickerContract('');
    setPickerEngine('');
    // Строки прежней программы не показываем под шапкой новой — сначала пусто,
    // потом приедет содержимое выбранной программы (своё или из реплики).
    setRows([]);
    rowsRef.current = [];
  };

  const inferredPeriodKind = useMemo<ProductionProgramPeriodKind>(
    () => (selected ? productionProgramPeriodKind({ start: selected.periodStart, end: selected.periodEnd }) : 'two_weeks'),
    [selected],
  );
  const periodKind = periodKindOverride ?? inferredPeriodKind;

  /** Смена вида периода — сразу пересчитываем даты (вид = «две недели/месяц/свои»). */
  const applyPeriodKind = (kind: ProductionProgramPeriodKind) => {
    setPeriodKindOverride(kind);
    if (!selected) return;
    const base = selected.periodStart || Date.now();
    const period = buildProductionProgramPeriod(kind, base, { start: selected.periodStart, end: selected.periodEnd });
    setHeader({ periodStart: period.start, periodEnd: period.end });
  };

  /** Правка одной даты периода: вид дальше выводится из дат. */
  const applyPeriodDate = (which: 'start' | 'end', value: string) => {
    if (!selected) return;
    const next = parseIsoDate(value);
    if (next == null) return;
    const start = which === 'start' ? next : selected.periodStart;
    const end = which === 'end' ? next : selected.periodEnd;
    setPeriodKindOverride(null);
    setHeader({ periodStart: Math.min(start, end), periodEnd: Math.max(start, end) });
  };

  async function createProgram() {
    setBusy(true);
    setError('');
    try {
      const now = Date.now();
      const periodStart = new Date(now);
      periodStart.setHours(12, 0, 0, 0);
      const periodEnd = new Date(periodStart);
      periodEnd.setDate(periodEnd.getDate() + 13);
      // Цех нового плана — из справочника (владелец 24.11.2026). Берём первый
      // активный цех, а оператор сразу переставит его в шапке. Справочник пуст —
      // legacy-текст, чтобы создание не падало (сервер требует непустой цех).
      const firstWorkshop = workshops[0] ?? null;
      const res = await window.matrica.productionProgram.create({
        periodStart: periodStart.getTime(),
        periodEnd: periodEnd.getTime(),
        shop: firstWorkshop ? firstWorkshop.label : 'Цех № 1',
        workshopId: firstWorkshop ? firstWorkshop.id : null,
        title: `Производственная программа ${formatProductionProgramPeriod({ start: periodStart.getTime(), end: periodEnd.getTime() })}`,
        status: 'draft',
        signatureSlots: null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setStatus('План создан');
      await reload();
      setSelectedId(res.id);
      setPeriodKindOverride(null);
    } finally {
      setBusy(false);
    }
  }

  async function saveProgram() {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      // Кнопка «Сохранить» — то же самое, что автосохранение, только сразу:
      // шапка и строки уходят одной записью.
      await persist(selected.id, {
        rows: rowsRef.current,
        header: {
          title: String(selected.title ?? ''),
          shop: String(selected.shop ?? ''),
          workshopId: selected.workshopId ?? null,
          periodStart: Number(selected.periodStart ?? 0),
          periodEnd: Number(selected.periodEnd ?? 0),
          status: String(selected.status ?? 'draft'),
          signatureSlots: selected.signatureSlots ?? null,
          signatureTemplateId: selected.signatureTemplateId ?? null,
        },
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeProgram() {
    if (!selected) return;
    const programId = selected.id;
    setBusy(true);
    try {
      const res = await window.matrica.productionProgram.remove(programId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Убираем программу из списка сразу: снятие приходит на клиент с задержкой
      // (публикатор зеркала + pull), а до неё программа ещё жила в реплике — и
      // повторный клик «Удалить» отвечал «программа не найдена».
      setPrograms((prev) => prev.filter((p) => p.id !== programId));
      setLines((prev) => prev.filter((l) => l.programId !== programId));
      setSelectedId((prev) => (prev === programId ? null : prev));
      // Снятая программа — её несохранённая правка больше не нужна.
      unsavedRef.current.delete(programId);
      setUnsavedProgramIds((prev) => prev.filter((id) => id !== programId));
      pendingSyncRef.current.delete(programId);
      headerOverrideRef.current.delete(programId);
      headerDirtyRef.current.delete(programId);
      localRowsRef.current.delete(programId);
      setStatus('Программа снята. Правка дойдёт до остальных компьютеров при синхронизации.');
    } finally {
      setBusy(false);
    }
  }

  /** Вид договора (военный/гражданский) — из его секций; нужен для подсказки состояния. */
  const contractKindOf = useCallback(async (contractId: string): Promise<'military' | 'civil' | null> => {
    try {
      const res = await window.matrica.contracts.contract.get(contractId);
      if (!res.ok || !res.row) return null;
      // Секции договора в строгой реплике лежат JSON-строкой (`sections_json`),
      // а домен ждёт объект секций — разбираем строку и отдаём домену то, что он понимает.
      const raw = res.row.sections_json;
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      const sections = parseContractSections({ contract_sections: parsed });
      return sections?.primary?.kind ?? null;
    } catch {
      return null;
    }
  }, []);

  async function addEngine() {
    if (!pickerEngine) return;
    const engine = engineById.get(pickerEngine);
    if (!engine) return;
    const contractId = String(engine.contractId ?? '');
    const kind = contractId ? await contractKindOf(contractId) : null;
    // Шапка группы — человеческое наименование договора (организация и номер).
    // Идентификатор в неё не идёт: в отчёте это «номер вместо наименования».
    // Наименования нет — строку не берём: без группы строки план не складывается.
    const groupLabel = contractLabelById.get(contractId) ?? '';
    if (!groupLabel || groupLabel === 'Договор без номера') {
      setError(
        'У двигателя нет наименования договора — строка плана без него не имеет группы. Заведите договор (наименование и номер) и повторите.',
      );
      return;
    }
    // Строка уходит на сервер сама (автосохранение) и до этого не пропадает:
    // живое обновление реплики не трогает несохранённое (баг 19.11.2026).
    // Строка собирается общим доменным правилом — тем же, что и при добавлении
    // из списка двигателей.
    const newRow: DraftRow = {
      ...productionProgramRowFromEngine({ id: crypto.randomUUID(), engine, groupLabel, contractKind: kind }),
      orderNo: rowsRef.current.length + 1,
      // Отметки у новой строки нет: её ставит оператор, руками.
      operatorNote: null,
    };
    applyRows((prev) => [...prev, newRow], selectedId);
    setPickerEngine('');
  }

  /**
   * Перепроверка блока «Требует данных» (промт КАРМАНА #64, ответы владельца #66).
   *
   * Строки без договора ищут свою карточку и, когда у карточки появился договор с
   * контрагентом, уезжают в группу своего договора: меняются `contractId` и
   * `groupLabel`, а ключ группы считается из них — строка меняет группу сама.
   *
   * Проход ОДИН и тот же для кнопки «Перепроверить» и для автопроверки при
   * открытии программы. Запись — только при РЕАЛЬНОМ изменении: иначе каждое
   * открытие писало бы в сервер и могло перебить правку оператора (канон #1240).
   */
  const recheckPending = useCallback(
    async (opts?: { manual?: boolean }) => {
      const programId = selectedId;
      if (!programId || !props.canEdit) return;
      const current = rowsRef.current;
      if (current.length === 0) return;
      const index = productionProgramEngineIndex(props.engines);
      const candidates = productionProgramPendingCandidates(current, index);
      if (candidates.length === 0) {
        if (opts?.manual) setStatus('Перепроверка: строк, требующих данных, нет.');
        return;
      }
      // Вид договора нужен для переезда — он лежит в строгой реплике, а не в карточке.
      const kinds = new Map<string, 'military' | 'civil' | null>();
      const contractIds = [
        ...new Set(candidates.map((c) => String(c.engine?.contractId ?? '')).filter(Boolean)),
      ];
      for (const id of contractIds) {
        if (!contractKindCacheRef.current.has(id)) {
          contractKindCacheRef.current.set(id, await contractKindOf(id));
        }
        kinds.set(id, contractKindCacheRef.current.get(id) ?? null);
      }
      const result = productionProgramResolvePendingRows({
        rows: current,
        index,
        contractLabelOf: (engine) => contractLabelById.get(String(engine.contractId ?? '')) ?? '',
        contractKindOf: (contractId) => kinds.get(contractId) ?? null,
      });
      if (!result.changed) {
        if (opts?.manual) setStatus('Перепроверка: все строки на своих местах.');
        return;
      }
      applyRows(() => result.rows, programId);
      setStatus(
        result.moved > 0
          ? `Перепроверка: ${result.moved} строк перешло в свои договоры, ${result.unresolved} ждут данных.`
          : `Перепроверка: обновлено строк, ${result.unresolved} ждут данных.`,
      );
    },
    [applyRows, contractKindOf, contractLabelById, props.canEdit, props.engines, selectedId],
  );

  /**
   * Автоперепроверка при открытии программы (и при обновлении каталога двигателей):
   * карточка могла получить договор уже после того, как программу открыли.
   *
   * Пока правка не уехала — не трогаем (иначе перепроверка затирала бы правку
   * оператора, ровно тот класс, что «двигатель пропадал через 15 секунд»).
   */
  useEffect(() => {
    if (!selectedId) return;
    if (unsavedRef.current.has(selectedId)) return;
    void recheckPending();
  }, [selectedId, lines, props.engines, recheckPending]);

  /**
   * Добавление двигателей списком (промт КАРМАНА #64).
   *
   * Строки от модалки ложатся поверх СЕРВЕРНЫХ строк плана: реплика отстаёт на
   * минуту, а набор заменяется целиком — без чтения с сервера запись снесла бы
   * строку, добавленную другим оператором. Своя правка при этом главнее.
   */
  const addRowsByNumbers = useCallback(
    (result: ProductionProgramAddByNumbersResult) => {
      const programId = selectedId;
      if (!programId) return;
      const serverDrafts: DraftRow[] = result.serverRows.map((l) => ({
        id: String(l.id),
        orderNo: Number(l.orderNo),
        contractId: l.contractId ?? null,
        groupLabel: l.groupLabel,
        contractKind: l.contractKind ?? null,
        engineId: l.engineId ?? null,
        engineMark: l.engineMark ?? '',
        engineNumber: l.engineNumber ?? '',
        state: l.state ?? null,
        shippingPlanAt: l.shippingPlanAt ?? null,
        factors: l.factors ?? '',
        note: l.note ?? '',
        operatorNote: l.operatorNote ?? null,
      }));
      const added: DraftRow[] = result.rows.map((r) => ({
        ...r,
        id: String(r.id),
        operatorNote: null,
      }));
      applyRows(
        (prev) => [...productionProgramMergeRows({ server: serverDrafts, local: prev }), ...added],
        programId,
      );
      const skipped =
        result.skipped.length > 0
          ? ` Пропущено: ${result.skipped.map((s) => `${s.label} — ${s.reason}`).join('; ')}.`
          : '';
      setStatus(`Добавлено двигателей: ${result.added}.${skipped}`);
    },
    [applyRows, selectedId],
  );

  /**
   * Убрать строки из плана.
   *
   * Снятые НАМИ строки запоминаются: пока зеркало их не отпустило, оно считается
   * старым и не перетирает наш вид (иначе снятая строка воскресла бы).
   */
  const removeRows = useCallback(
    (ids: string[]) => {
      const programId = selectedId;
      if (!programId || ids.length === 0) return;
      const pending = pendingSyncRef.current.get(programId) ?? { sent: [], removedIds: [] };
      pendingSyncRef.current.set(programId, {
        ...pending,
        removedIds: [...new Set([...pending.removedIds, ...ids])],
      });
      applyRows((prev) => prev.filter((x) => !ids.includes(String(x.id))), programId);
      setStatus(`Убрано строк из программы: ${ids.length}.`);
    },
    [applyRows, selectedId],
  );

  /**
   * Выделение строк плана: свой набор (не путать с выделением в списке двигателей) —
   * ключ свой, иначе выделение пережило бы переход между списками.
   */
  const selection = useListSelection(
    rows.map((r) => String(r.id)),
    { persistKey: 'list:production-program:selection' },
  );

  /** Отметка всех строк плана: снять, если отмечены уже все. */
  const allRowsSelected = rows.length > 0 && rows.every((r) => selection.isSelected(String(r.id)));
  const someRowsSelected = rows.some((r) => selection.isSelected(String(r.id)));
  const toggleAllRows = () => {
    if (allRowsSelected) {
      selection.clearSelection();
      return;
    }
    for (const r of rows) {
      if (!selection.isSelected(String(r.id))) selection.toggleSelect(String(r.id));
    }
  };

  /** Строки плана по id — для меню и печати выделения. */
  const screenRowById = useMemo(() => {
    const map = new Map<string, ScreenRow>();
    for (const group of groups) {
      for (const item of group.items) map.set(String(item.row.id), item);
    }
    return map;
  }, [groups]);

  /** Колонки для печати и копии ВЫДЕЛЕННЫХ строк — те же, что в печатной форме плана. */
  const selectionColumns = useMemo<ListContextColumn<ScreenRow>[]>(
    () => [
      // Номер — тот же, что на экране (позиция показа), а не из карты по id.
      { title: '№ п/п', value: (r) => String(r.global) },
      { title: 'Организация, договор', value: (r) => r.organization || '—' },
      {
        title: 'Двигатель',
        value: (r) =>
          [r.engine?.engineBrand || r.row.engineMark, r.engine?.engineNumber || r.row.engineNumber]
            .filter(Boolean)
            .join(' '),
      },
      { title: 'Этап', value: (r) => productionProgramEngineStage(r.engine)?.label ?? '' },
      { title: 'Состояние', value: (r) => programStateLabel(r.row.state) },
      { title: 'Примечание', value: (r) => r.row.note ?? '' },
    ],
    [],
  );

  const printSelectedRows = useCallback(
    (items: ScreenRow[]) => {
      printRowsPreview({
        title: selected?.title ?? 'Производственная программа',
        sectionTitle: 'Строки производственной программы',
        rows: items,
        columns: selectionColumns,
      });
    },
    [selected?.title, selectionColumns],
  );

  const copySelectedRows = useCallback(
    async (items: ScreenRow[]) => {
      try {
        await copyRowsToClipboard(items, selectionColumns);
        setError('');
        setStatus(`Скопировано строк: ${items.length}`);
      } catch {
        setStatus('');
        setError('Не удалось скопировать в буфер обмена');
      }
    },
    [selectionColumns],
  );

  /** Письмо по выделенным строкам: текст письма — те же колонки, что печать и копия. */
  const mailSelectedRows = useCallback(
    (items: ScreenRow[]) => {
      setMailSelection({
        subject: `${selected?.title ?? 'Производственная программа'} — выделенные строки`,
        summary: [
          selected?.title ?? '',
          selected
            ? formatProductionProgramPeriod({ start: selected.periodStart, end: selected.periodEnd })
            : '',
          `строк: ${items.length}`,
          selected?.shop ?? '',
        ].filter(Boolean),
        body: buildRowsText(items, selectionColumns),
      });
    },
    [selected, selectionColumns],
  );

  const menuRows = useMemo<ScreenRow[]>(
    () =>
      menu
        ? menu.targetIds
            .map((id) => screenRowById.get(String(id)))
            .filter((row): row is ScreenRow => Boolean(row))
        : [],
    [menu, screenRowById],
  );

  /**
   * Меню строк плана (ПКМ) — по общему киту: список ОБЪЯВЛЯЕТ свои действия, а меню
   * собирается из объявления (промт КАРМАНА #67, D-247). Правило одно на всю
   * программу: недоступного пункта в меню НЕТ ВОВСЕ, а не гасится серым.
   * Поэтому «Открыть карточку» есть только у строки с двигателем (в группе
   * «требует данных» двигателя нет), а «Убрать из программы» — только по праву
   * ведения плана.
   */
  const canEdit = props.canEdit;
  const onOpenEngine = props.onOpenEngine;
  const menuItems = useMemo<ListContextMenuItem[]>(() => {
    if (!menu || menuRows.length === 0) return [];
    const actions: ListActionDeclaration<ScreenRow>[] = [
      {
        id: 'pp-open-engine',
        label: 'Открыть карточку',
        available: Boolean(menuRows[0]?.engine?.id),
        scope: 'single',
        run: (rows) => {
          const engineId = String(rows[0]?.engine?.id ?? '');
          if (engineId) onOpenEngine?.(engineId);
        },
      },
      listPrintAction({ available: true, print: (rows) => printSelectedRows(rows) }),
      listCopyAction({ available: true, copy: (rows) => void copySelectedRows(rows) }),
      // Почта — объявляемое действие списка, как «бирки» у двигателей: своего
      // шаблона в ките нет, и это нормально — меню собирается из объявления.
      {
        id: 'pp-mail',
        label: 'Отправить почтой',
        bulkLabel: 'Отправить почтой выделенные',
        available: true,
        scope: 'both',
        run: (rows) => mailSelectedRows(rows),
      },
      {
        id: 'pp-remove',
        label: 'Убрать из программы',
        bulkLabel: 'Убрать из программы',
        available: canEdit,
        scope: 'both',
        danger: true,
        run: (rows) => removeRows(rows.map((r) => String(r.row.id))),
      },
    ];
    return buildListContextMenuItems({
      rows: menuRows,
      bulk: menu.bulk,
      getId: (r) => String(r.row.id),
      onSelect: selection.toggleSelect,
      onClearSelection: selection.clearSelection,
      hasSelection: selection.selectedCount > 0,
      actions,
    });
  }, [
    canEdit,
    copySelectedRows,
    mailSelectedRows,
    menu,
    menuRows,
    onOpenEngine,
    printSelectedRows,
    removeRows,
    selection,
  ]);

  /**
   * Модель печати плана: строки, карточки двигателей и подписи.
   *
   * Из неё собираются и печатный лист, и выгрузка в Word/Excel, и письмо, и буфер
   * обмена. Одна модель — одна правда: файл, который разошёлся бы с листом,
   * пришлось бы чинить дважды.
   */
  const programPrintInput = useMemo<ProductionProgramPrintInput | null>(() => {
    if (!selected) return null;
    return {
      title: selected.title,
      shop: selected.shop,
      period: { start: selected.periodStart, end: selected.periodEnd },
      rows: rows.map((r) => ({
        id: r.id,
        contractId: r.contractId ?? null,
        groupLabel: r.groupLabel,
        contractKind: r.contractKind ?? null,
        engineId: r.engineId ?? null,
        engineMark: r.engineMark ?? '',
        engineNumber: r.engineNumber ?? '',
        state: r.state ?? null,
        note: r.note ?? '',
      })),
      engines: props.engines,
      employees,
      // Состав подписей — сохранённый оператором. `null` (не задан) — печатаются роли
      // по умолчанию; сохранённый набор заменяет их целиком.
      signatureSlots: selected.signatureSlots ? parseProductionProgramSignatureSlots(selected.signatureSlots) : null,
    };
  }, [selected, rows, props.engines, employees]);

  /**
   * Кнопка «Печать» открывает ПРЕВЬЮ, а не принтер (владелец 10.11.2026):
   * раньше сразу выскакивало системное окно принтера, и форму печати нельзя было
   * ни посмотреть, ни поправить (закрытие окна принтера закрывало и форму).
   * Превью — промежуточный этап: галочки подписей, кегли разделов и кнопка печати.
   */
  function openPrintPreview() {
    if (!selected) return;
    setPrintPreviewOpen(true);
  }

  /**
   * Выгрузка плана в Word/Excel — общий экспортёр (`exports:list`): свой сборщик
   * в модуле означал бы второй файл, который разъедется с общим.
   */
  const exportBundle = useMemo(
    () => (programPrintInput ? buildProductionProgramExportSpec(programPrintInput) : null),
    [programPrintInput],
  );

  async function exportProgram(format: 'docx' | 'xlsx') {
    if (!exportBundle) return;
    setExportBusy(format);
    try {
      const res = await window.matrica.exports.list({ format, spec: exportBundle.spec });
      if (res.ok) {
        setError('');
        setStatus(`Файл сохранён: ${res.name}`);
      } else if (!res.cancelled) {
        setStatus('');
        setError(`Не удалось выгрузить план: ${res.error}`);
      }
    } finally {
      setExportBusy(null);
    }
  }

  /**
   * План в буфер обмена: таблица с табуляцией — вставляется в Excel и в Word
   * одним движением (в отличие от «Колонка: значение», который разбирают руками).
   */
  async function copyProgramToClipboard() {
    if (!programPrintInput) return;
    try {
      await navigator.clipboard.writeText(buildProductionProgramClipboardText(programPrintInput));
      setError('');
      setStatus(`Скопировано строк: ${rows.length}`);
    } catch {
      setStatus('');
      setError('Не удалось скопировать в буфер обмена');
    }
  }

  const hint = pickerEngine ? productionProgramEngineHint(engineById.get(pickerEngine) ?? null) : null;

  // Подпись — одна строка: подписи одинаковой высоты ⇒ поля стоят на одной линии.
  // Обёртка — грид: подпись и контрол в одной ячейке (два узла в ячейку класть нельзя).
  const fieldLabel = (label: string, control: React.ReactNode, style?: React.CSSProperties) => (
    <label style={{ display: 'grid', gap: 4, fontSize: 12, minWidth: 0, ...style }}>
      <span style={{ color: 'var(--subtle)', whiteSpace: 'nowrap' }}>{label}</span>
      {control}
    </label>
  );

  return (
    <div
      className="production-program-page"
      style={{
        display: 'grid',
        gap: 12,
        gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)',
        width: '100%',
        minWidth: 0,
        alignItems: 'start',
      }}
    >
      {/* ЛЕВАЯ ЧАСТЬ — плашки производственных программ */}
      <SectionCard
        title="Производственные программы"
        actions={
          props.canEdit ? (
            <Button onClick={() => void createProgram()} disabled={busy}>
              Новый план
            </Button>
          ) : null
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          {programs.length === 0 ? (
            <div className="ui-muted" style={{ fontSize: 12 }}>
              Планов пока нет
            </div>
          ) : null}
          {programs.map((p) => {
            const tone = PROGRAM_STATUS_TONES[p.status] ?? PROGRAM_STATUS_TONES.draft!;
            const count = lines.filter((l) => l.programId === p.id).length;
            const active = p.id === selectedId;
            const summary = summaryByProgram.get(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectProgram(p.id)}
                style={{
                  textAlign: 'left',
                  display: 'grid',
                  gap: 4,
                  padding: '8px 10px',
                  borderRadius: 8,
                  border: `1px solid ${active ? tone.border : 'var(--border)'}`,
                  background: active ? tone.bg : 'transparent',
                  cursor: 'pointer',
                  minWidth: 0,
                }}
              >
                <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</div>
                <div className="ui-muted" style={{ fontSize: 12 }}>
                  {formatProductionProgramPeriod({ start: p.periodStart, end: p.periodEnd })}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: '1px 6px',
                      borderRadius: 999,
                      border: `1px solid ${tone.border}`,
                      background: tone.bg,
                      color: tone.text,
                    }}
                  >
                    {PROGRAM_STATUS_LABELS[p.status] ?? p.status}
                  </span>
                  <span className="ui-muted" style={{ fontSize: 12 }}>
                    {p.shop} · {count} двиг.
                  </span>
                </div>
                {/* Выполнение плана — по живой карточке двигателя (владелец 10.11.2026):
                    сколько собрано, сколько в срок, сколько выпало из сроков. */}
                {summary && summary.total > 0 ? (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
                    <span style={{ color: '#166534' }}>Собрано {summary.done} из {summary.total}</span>
                    <span className="ui-muted">В срок {summary.onTime}</span>
                    {summary.overdue > 0 ? (
                      <span style={{ color: 'var(--danger)' }}>Просрочено {summary.overdue}</span>
                    ) : null}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
      </SectionCard>

      {/* ПРАВАЯ ЧАСТЬ — настройка открытой программы */}
      <div style={{ display: 'grid', gap: 12, minWidth: 0 }}>
        {error ? (
          <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div>
        ) : null}
        {status ? (
          <div style={{ color: 'var(--subtle)', fontSize: 12 }}>{status}</div>
        ) : null}
        {/* Правка, которая ещё не уехала, видна оператору: молчание здесь — это
            потеря работы (баг 19.11.2026 — двигатель пропадал из плана). */}
        {selectedId && unsavedProgramIds.includes(selectedId) ? (
          <div style={{ color: 'var(--danger)', fontSize: 12 }}>
            Правка не сохранена — уходит на сервер сама. Если не уходит — смотрите ошибку выше.
          </div>
        ) : null}
        {!selected ? (
          <SectionCard title="Программа">
            <div className="ui-muted">Выберите программу слева или создайте новую.</div>
          </SectionCard>
        ) : (
          <>
            <SectionCard title="Программа">
              {/* Ряд управляющих кнопок модуля (промты КАРМАНА #50/#51): сохранить, печать,
                  Word, Excel, почта, буфер. Тот же ряд, что в списках: что не поместилось —
                  уезжает в меню «⋯». Права не расширяем: печать и выгрузка доступны всем,
                  кто видит модуль, — как и раньше. */}
              <div style={{ marginBottom: 10 }}>
                <PageToolbar>
                <Button onClick={() => void saveProgram()} disabled={busy || !props.canEdit} data-pp-action="save">
                  Сохранить
                </Button>
                {/* Перепроверка блока «Требует данных»: строки без договора ищут
                    свою карточку и уезжают в свой договор, когда он появился
                    (промт КАРМАНА #64, ответы владельца #66). */}
                <Button
                  variant="ghost"
                  onClick={() => void recheckPending({ manual: true })}
                  disabled={!props.canEdit || rows.length === 0}
                  title="Перепроверить строки, ждущие данных: они уедут в свои договоры"
                  data-pp-action="recheck"
                >
                  Перепроверить
                </Button>
                <Button variant="ghost" onClick={openPrintPreview} data-pp-action="print">
                  Печать
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void exportProgram('docx')}
                  disabled={!exportBundle || exportBusy !== null}
                  title="Выгрузить план в Word"
                  data-pp-action="word"
                >
                  {exportBusy === 'docx' ? 'Готовим…' : 'В Word'}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void exportProgram('xlsx')}
                  disabled={!exportBundle || exportBusy !== null}
                  title="Выгрузить план в Excel"
                  data-pp-action="excel"
                >
                  {exportBusy === 'xlsx' ? 'Готовим…' : 'В Excel'}
                </Button>
                {exportBundle ? (
                  <MailSendButton
                    subject={`${selected.title} — производственная программа`}
                    summary={[
                      selected.title,
                      formatProductionProgramPeriod({ start: selected.periodStart, end: selected.periodEnd }),
                      `${exportBundle.rows.length} двиг.`,
                      selected.shop,
                    ]}
                    body={() => listToText(exportBundle.fields, exportBundle.rows)}
                    attachment={() => ({ kind: 'list', format: 'docx', spec: exportBundle.spec })}
                    label="Почта"
                    dataAttr="pp"
                  />
                ) : null}
                <Button
                  variant="ghost"
                  onClick={() => void copyProgramToClipboard()}
                  disabled={rows.length === 0}
                  title="Скопировать план в буфер обмена — вставится таблицей"
                  data-pp-action="copy"
                >
                  Скопировать
                </Button>
                {props.canEdit ? (
                  <Button variant="ghost" onClick={() => void removeProgram()} disabled={busy} data-pp-action="delete">
                    Удалить
                  </Button>
                ) : null}
                </PageToolbar>
              </div>
              {/* Шапка программы. Раньше поля стояли в одной сетке `auto-fit` без `min-width: 0`
                  у контролов: у грид-элемента `min-width: auto` = собственная min-content ширина,
                  а у инпута в планшетных токенах (16px) она шире трека ⇒ поле вылезало из своего
                  трека на соседнее (промт владельца #80). Теперь ряд — flex с переносом, ширины
                  заданы явно, у контролов `minWidth: 0`. */}
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 10,
                  alignItems: 'flex-start',
                }}
              >
                {fieldLabel(
                  'Название программы',
                  <input
                    value={selected.title}
                    disabled={!props.canEdit}
                    onChange={(e) => setHeader({ title: e.target.value })}
                    style={{ padding: '4px 6px', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                  />,
                  { flex: '2 1 260px' },
                )}
                {fieldLabel(
                  'Цех',
                  // Цех — ВЫБОР из справочника `directory_workshops`, а не свободный
                  // текст (владелец 24.11.2026): связь по id нужна, чтобы искать,
                  // фильтровать и считать статистику по цехам.
                  <select
                    value={shopChoice}
                    disabled={!props.canEdit}
                    onChange={(e) => applyWorkshopChoice(e.target.value)}
                    style={{ padding: '4px 6px', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                    data-pp-field="workshop"
                  >
                    {shopChoice === '' ? <option value="">— выберите цех —</option> : null}
                    {legacyShopText ? (
                      <option value={LEGACY_SHOP_VALUE}>{legacyShopText} (не из справочника)</option>
                    ) : null}
                    {shopOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                        {o.missing ? ' (нет в справочнике)' : ''}
                      </option>
                    ))}
                  </select>,
                  { flex: '1 1 170px' },
                )}
                {fieldLabel(
                  'Период',
                  <select
                    value={periodKind}
                    disabled={!props.canEdit}
                    onChange={(e) => applyPeriodKind(e.target.value as ProductionProgramPeriodKind)}
                    style={{ padding: '4px 6px', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                  >
                    {(['two_weeks', 'month', 'custom'] as ProductionProgramPeriodKind[]).map((kind) => (
                      <option key={kind} value={kind}>
                        {PRODUCTION_PROGRAM_PERIOD_LABELS[kind]}
                      </option>
                    ))}
                  </select>,
                  { flex: '1 1 170px' },
                )}
                {fieldLabel(
                  'Период с',
                  <UnifiedDateInput
                    type="date"
                    value={isoDate(selected.periodStart)}
                    disabled={!props.canEdit}
                    onChange={(e) => applyPeriodDate('start', String(e.target.value ?? ''))}
                    style={{ minWidth: 0, boxSizing: 'border-box' }}
                  />,
                  { flex: '1 1 150px' },
                )}
                {fieldLabel(
                  'Период по',
                  <UnifiedDateInput
                    type="date"
                    value={isoDate(selected.periodEnd)}
                    disabled={!props.canEdit}
                    onChange={(e) => applyPeriodDate('end', String(e.target.value ?? ''))}
                    style={{ minWidth: 0, boxSizing: 'border-box' }}
                  />,
                  { flex: '1 1 150px' },
                )}
                {fieldLabel(
                  'Статус программы',
                  <select
                    value={selected.status}
                    disabled={!props.canEdit}
                    onChange={(e) => setHeader({ status: e.target.value })}
                    style={{ padding: '4px 6px', width: '100%', minWidth: 0, boxSizing: 'border-box' }}
                  >
                    <option value="draft">Черновик</option>
                    <option value="approved">Утверждён</option>
                  </select>,
                  { flex: '1 1 180px' },
                )}
              </div>

              {props.canEdit ? (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                    alignItems: 'flex-end',
                    marginTop: 12,
                  }}
                >
                  {fieldLabel(
                    'Договор',
                    <SearchSelect
                      value={pickerContract || null}
                      options={contractOptions}
                      placeholder="— выберите договор —"
                      emptyQueryLimit={40}
                      onChange={(next) => {
                        setPickerContract(next ?? '');
                        // Договор сменился — выбранный двигатель может быть чужим.
                        setPickerEngine('');
                      }}
                    />,
                    { flex: '1 1 220px' },
                  )}
                  {fieldLabel(
                    'Двигатель',
                    <SearchSelect
                      value={pickerEngine || null}
                      options={engineOptions}
                      placeholder="— найдите двигатель по номеру —"
                      emptyQueryLimit={40}
                      onChange={(next) => {
                        setPickerEngine(next ?? '');
                        // Поиски взаимозаменяемы: двигатель подтягивает свой договор.
                        const engine = next ? engineById.get(next) : null;
                        const contractId = String(engine?.contractId ?? '');
                        if (contractId) setPickerContract(contractId);
                      }}
                    />,
                    { flex: '1 1 240px' },
                  )}
                  <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
                    <Button onClick={() => void addEngine()} disabled={!pickerEngine}>
                      Добавить в план
                    </Button>
                    {/* Вариант «списком»: оператор вставляет номера и видит по
                        каждому, что с ним (промт КАРМАНА #64). */}
                    <Button
                      variant="ghost"
                      onClick={() => setAddByNumbersOpen(true)}
                      data-pp-action="add-by-numbers"
                      title="Добавить двигатели списком номеров — по каждому видна проблема"
                    >
                      Добавить списком
                    </Button>
                  </div>
                  {hint ? (
                    <div style={{ fontSize: 12, color: 'var(--subtle)', flex: '1 1 100%' }}>{hint.text}</div>
                  ) : null}
                </div>
              ) : null}
            </SectionCard>

            <SectionCard title="Строки плана">
              {/* Без своей горизонтальной прокрутки: вложенный скролл-контейнер
                  перехватывает sticky-шапку, и она уезжает вместе с таблицей. Широкая
                  таблица доезжает прокруткой бокса карточки. */}
              <div style={{ overflow: 'visible' }} data-list-root="true" ref={listRootRef}>
                <table className="list-table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      {/* Отметка строк: множественный выбор и контекстное меню по
                          выделению (печать, копия, почта). */}
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          checked={allRowsSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = !allRowsSelected && someRowsSelected;
                          }}
                          onChange={() => toggleAllRows()}
                          aria-label="Выделить все строки плана"
                          title={allRowsSelected ? 'Снять выделение со всех' : 'Выделить все'}
                          style={{ cursor: 'pointer', margin: 0 }}
                        />
                      </th>
                      <th />
                      <th title="Сквозной номер по программе">№ п/п</th>
                      <th title="Номер двигателя внутри своего договора">№ в договоре</th>
                      <th>Организация, договор</th>
                      <th>Двигатель</th>
                      {/* Этап заменил «Выполнение», «Отгрузку» и «Отметку» (владелец
                          20.11.2026): движение двигателя видно по одному столбцу, а
                          отгрузка — это теперь этап единого списка. */}
                      <th title="На каком этапе сейчас двигатель — из истории ремонта">Этап</th>
                      <th>Состояние</th>
                      <th>Примечание</th>
                      {props.canEdit ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody
                    // Место вставки и подсветку считает общий слой кита: страница
                    // только показывает результат и говорит, куда встать.
                    onDragOver={(e) => {
                      dragLayer.overRow(e);
                    }}
                    onDrop={handleDrop}
                  >
                    {groups.length === 0 ? (
                      <tr>
                        <td colSpan={props.canEdit ? 10 : 9} className="ui-muted">
                          Строк в плане нет
                        </td>
                      </tr>
                    ) : null}
                    {groups.map((group) => {
                      const groupKey = group.key;
                      return (
                        <React.Fragment key={group.key}>
                          <tr
                            // Маркер строки-заголовка: кит по нему считает границы групп.
                            data-list-row="true"
                            data-list-row-key={`${GROUP_ROW_PREFIX}${groupKey}`}
                            style={{ background: '#f3f4f6', ...groupHeaderStyle(groupKey), ...programMove.moveRowStyle(groupKey) }}
                          >
                            <td
                              colSpan={props.canEdit ? 10 : 9}
                              style={{ fontWeight: 700, padding: '4px 6px', whiteSpace: 'normal' }}
                            >
                              {/* Ручка группы — общая ручка кита: перетаскивание мышью и
                                  перемещение стрелками (групповой режим кита: группа едет
                                  целиком среди других групп). */}
                              <ListRowHandle
                                rowKey={groupKey}
                                draggable={props.canEdit}
                                onHandleClick={programMove.onHandleClick}
                                active={programMove.moveKeys.includes(groupKey)}
                                blockCount={programMove.moveKeys.length}
                                onDragStart={(e) => dragLayer.startDrag(e, { kind: 'group', key: groupKey })}
                                label={group.label}
                              />
                              {' '}
                              {group.label}
                            </td>
                          </tr>
                          {group.items.map((item) => {
                            const r = item.row;
                            const engine = item.engine;
                            // Этап — по живой карточке двигателя (последний этап истории
                            // ремонта). Колонка «Выполнение» убрана (владелец 20.11.2026):
                            // движение видно по этапу.
                            const stage = productionProgramEngineStage(engine);
                            // Тон строки — по факту из карточки (тот же домен, что и печать),
                            // а ручная отметка оператора сильнее факта.
                            const tone = productionProgramRowTone(engine, r.operatorNote);
                            const isSelected = selection.isSelected(String(r.id));
                            // Марка и номер — по тому же правилу, что печать и выгрузка
                            // (живая карточка, снимок строки — запасной вариант).
                            const engineCellLabel = [
                              engine?.engineBrand || r.engineMark,
                              engine?.engineNumber || r.engineNumber,
                            ]
                              .filter(Boolean)
                              .join(' ');
                            return (
                              <tr
                                key={r.id}
                                // Маркер строки: кит по нему считает место вставки —
                                // правило одно на программу (промт КАРМАНА #67).
                                data-list-row="true"
                                data-list-row-key={String(r.id)}
                                onClick={(e) => {
                                  // Shift+клик — переключить отметку строки (как в списках),
                                  // обычный клик — только курсор выделения.
                                  if (e.shiftKey) {
                                    e.preventDefault();
                                    selection.toggleSelect(String(r.id));
                                    return;
                                  }
                                  selection.onRowPrimaryAction(String(r.id));
                                }}
                                onContextMenu={(e) => {
                                  const result = selection.onRowContextMenu(e, String(r.id));
                                  if (!result.openMenu) return;
                                  setMenu({
                                    x: e.clientX,
                                    y: e.clientY,
                                    targetIds: result.targetIds,
                                    bulk: result.bulk,
                                  });
                                }}
                                {...(isSelected ? { 'data-list-selected': 'true' as const } : {})}
                                style={{
                                  ...(tone.background ? { background: tone.background } : {}),
                                  // Синий выбор накладывается ПОСЛЕ тона строки — так же,
                                  // как в остальных списках программы.
                                  ...(isSelected ? { background: 'rgba(37, 99, 235, 0.14)' } : {}),
                                  // Подсветка перетаскивания и линия места вставки — по киту.
                                  ...rowDragStyle(String(r.id)),
                                  // Красная рамка режима перемещения стрелками — по киту.
                                  ...programMove.moveRowStyle(String(r.id)),
                                }}
                                title={tone.label || undefined}
                              >
                                <td
                                  style={{ width: 32, textAlign: 'center' }}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => selection.toggleSelect(String(r.id))}
                                    aria-label={`Выделить строку ${r.engineNumber || r.id}`}
                                    style={{ cursor: 'pointer', margin: 0 }}
                                  />
                                </td>
                                <td>
                                  {/* Ручка строки — общая ручка кита: перетаскивание мышью и
                                      перемещение стрелками (двигатель едет внутри своего
                                      договора — групповой режим кита). */}
                                  <ListRowHandle
                                    rowKey={String(r.id)}
                                    draggable={props.canEdit}
                                    onHandleClick={programMove.onHandleClick}
                                    active={programMove.moveKeys.includes(String(r.id))}
                                    blockCount={programMove.moveKeys.length}
                                    onDragStart={(e) => dragLayer.startDrag(e, { kind: 'row', key: String(r.id) })}
                                    label={engineCellLabel || `строка ${r.id}`}
                                  />
                                </td>
                                {/* Номер — по позиции показа (доменный план нумерации),
                                    а не по карте по идентификатору: карта слепа к строке
                                    без идентификатора и к двум строкам с одинаковым. */}
                                <td>{item.global}</td>
                                <td>{item.inContract}</td>
                              <td title={item.organization}>{item.organization || '—'}</td>
                              <td>
                                {/* Номер двигателя — ссылка в карточку (промт КАРМАНА #64):
                                    до этого оператор искал карточку в списке двигателей
                                    вручную. Клик — по номеру, а не по строке: иначе он
                                    спорил бы с выделением строк. */}
                                {engine && props.onOpenEngine ? (
                                  <button
                                    type="button"
                                    data-pp-open-engine={String(engine.id)}
                                    title="Открыть карточку двигателя"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      props.onOpenEngine?.(String(engine.id));
                                    }}
                                    style={{
                                      background: 'none',
                                      border: 'none',
                                      padding: 0,
                                      margin: 0,
                                      color: 'inherit',
                                      font: 'inherit',
                                      textDecoration: 'underline',
                                      cursor: 'pointer',
                                    }}
                                  >
                                    {engineCellLabel}
                                  </button>
                                ) : (
                                  engineCellLabel
                                )}
                              </td>
                              <td>
                                {/* Этап: меню выбора в ячейке + дата этапа. Выбор этапа
                                    открывает модалку — этап пишется в историю ремонта
                                    целиком, а не «меняет статус в плане». */}
                                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                  <select
                                    value={stage?.code ?? ''}
                                    disabled={!props.canEdit || !props.canEditStages || stageBusyRowId === r.id}
                                    data-pp-stage-select={r.id}
                                    onChange={(e) => {
                                      const code = e.target.value;
                                      if (!code || code === stage?.code) return;
                                      openStageDialog(
                                        r.id,
                                        String(engine?.id ?? r.engineId ?? ''),
                                        [engine?.engineBrand || r.engineMark, engine?.engineNumber || r.engineNumber]
                                          .filter(Boolean)
                                          .join(' '),
                                        code,
                                      );
                                    }}
                                    title={
                                      props.canEditStages
                                        ? 'Выберите этап — откроется окно с датой, цехом и примечанием'
                                        : 'Нет права править этапы ремонта'
                                    }
                                    style={{ padding: '2px 4px', maxWidth: 220 }}
                                  >
                                    <option value="">— этап не задан —</option>
                                    {stageMenuOptions.map((o) => (
                                      <option key={o.code} value={o.code}>
                                        {o.name}
                                        {o.code === stage?.code ? ' (сейчас)' : ''}
                                      </option>
                                    ))}
                                  </select>
                                  {stage?.at ? (
                                    <span className="ui-muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                                      {stage.dateLabel}
                                    </span>
                                  ) : null}
                                </div>
                              </td>
                              <td>
                                <select
                                  value={r.state ?? ''}
                                  disabled={!props.canEdit}
                                  onChange={(e) =>
                                    applyRows(
                                      (prev) =>
                                        prev.map((x) => (x.id === r.id ? { ...x, state: e.target.value || null } : x)),
                                      selectedId,
                                    )
                                  }
                                  style={{ padding: '2px 4px' }}
                                >
                                  <option value="">—</option>
                                  {PRODUCTION_PROGRAM_STATES.map((s) => (
                                    <option key={s} value={s}>
                                      {PRODUCTION_PROGRAM_STATE_LABELS[s]}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  value={r.note ?? ''}
                                  disabled={!props.canEdit}
                                  onChange={(e) =>
                                    applyRows(
                                      (prev) => prev.map((x) => (x.id === r.id ? { ...x, note: e.target.value } : x)),
                                      selectedId,
                                    )
                                  }
                                  style={{ padding: '2px 4px', width: 160 }}
                                />
                              </td>
                              {props.canEdit ? (
                                <td>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      // Снятая строка: пока зеркало её не отпустило,
                                      // зеркало считается старым и не перетирает наш вид.
                                      if (selectedId) {
                                        const pending = pendingSyncRef.current.get(selectedId) ?? {
                                          sent: [],
                                          removedIds: [],
                                        };
                                        pendingSyncRef.current.set(selectedId, {
                                          ...pending,
                                          removedIds: [...pending.removedIds, r.id],
                                        });
                                      }
                                      applyRows((prev) => prev.filter((x) => x.id !== r.id), selectedId);
                                    }}
                                    title="Убрать строку из плана"
                                    style={{
                                      border: 'none',
                                      background: 'transparent',
                                      color: 'var(--danger)',
                                      cursor: 'pointer',
                                    }}
                                  >
                                    ✕
                                  </button>
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          </>
        )}
      </div>

      {/* Превью печатной формы — промежуточный этап между «Печать» и принтером. */}
      {printPreviewOpen && programPrintInput ? (
        <ProductionProgramPrintPreview
          input={programPrintInput}
          onClose={() => setPrintPreviewOpen(false)}
          onSignatureSlotsChange={(slots: readonly PrintSignatureSlot[]) => {
            // Состав подписей — данные программы, а не вид печати: правка уходит в
            // документ, иначе добавленная подпись не печаталась бы в следующий раз.
            setHeader({ signatureSlots: serializePrintSignatureSlots(slots) });
          }}
          signatureTemplates={signatureTemplates}
          signatureTemplateId={selected?.signatureTemplateId ?? null}
          canEditTemplates={!!props.canEditSignatureTemplates}
          onApplyTemplate={(id) => applySignatureTemplate(id)}
          onSaveAsTemplate={(name) => void saveSignatureTemplateAsDefault(name)}
        />
      ) : null}

      {/* Модалка этапа: этап пишется в историю ремонта двигателя целиком. */}
      {stageDialog ? (
        <ProductionProgramStageDialog
          engineLabel={stageDialog.engineLabel}
          currentStage={productionProgramEngineStage(engineById.get(stageDialog.engineId) ?? null)}
          templates={stageTemplates}
          workshops={workshops}
          initialCode={stageDialog.code}
          planDeadline={isoDate(rowsRef.current.find((r) => r.id === stageDialog.rowId)?.shippingPlanAt ?? null)}
          defaultWorkshopId={defaultWorkshopId}
          onClose={closeStageDialog}
          onSubmit={submitStage}
        />
      ) : null}

      {/* Добавление двигателей списком номеров (промт КАРМАНА #64). */}
      {addByNumbersOpen && selected ? (
        <ProductionProgramAddEnginesByNumbersDialog
          open={addByNumbersOpen}
          engines={props.engines}
          contractLabelOf={(engine) => contractLabelById.get(String(engine.contractId ?? '')) ?? ''}
          programId={selected.id}
          programTitle={selected.title}
          onClose={() => setAddByNumbersOpen(false)}
          onDone={addRowsByNumbers}
        />
      ) : null}

      {/* ПКМ-меню строк плана: печать, копия, почта — по выделению. */}
      {menu && menuItems.length > 0 ? (
        <ListContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}

      {/* Выделение контуром (Ctrl + рамка) — слой кита, как в остальных списках программы
          (промт КАРМАНА #67). Заголовки групп строкой плана НЕ считаются: в выделении
          участвуют только строки двигателей — иначе в набор попали бы ключи групп. */}
      <ListLassoLayer
        enabled={listBehavior.lasso}
        onSelect={(keys) => selection.selectMany(keys.filter((key) => !key.startsWith(GROUP_ROW_PREFIX)))}
      />

      {/* Письмо по выделенным строкам. */}
      {mailSelection ? (
        <MailComposeDialog
          subject={mailSelection.subject}
          summary={mailSelection.summary}
          body={mailSelection.body}
          onClose={() => setMailSelection(null)}
        />
      ) : null}
    </div>
  );
}
