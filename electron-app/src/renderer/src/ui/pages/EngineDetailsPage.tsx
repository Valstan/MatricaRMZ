import React, { useEffect, useRef, useState } from 'react';

import type { EngineDetails, EngineDuplicateMatches, FileRef, SupplyRequestItem } from '@matricarmz/shared';
import { parseContractSections, buildContractSectionOptions, STATUS_CODES, STATUS_LABELS, statusDateCode, type ContractSectionOption, type StatusCode } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { SectionCard } from '../components/SectionCard.js';
import { RepairChecklistPanel } from '../components/RepairChecklistPanel.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { EnginePhotoGallery } from '../components/EnginePhotoGallery.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { mapEntityRowsToSearchOptions } from '../utils/selectOptions.js';
import { AssemblyReturnDialog } from '../components/AssemblyReturnDialog.js';
import { EngineDismantlePreviewDialog } from '../components/EngineDismantlePreviewDialog.js';

// Заморожено 2026-05-26: «Разборка двигателя» отключена, поскольку бизнес отказался
// от потока «разборка → repair_fund → Repair-наряд» (списки деталей по маркам не актуальны,
// призраки на repair_fund накапливаются). Ремонты теперь приходуют детали как новые через
// production_release. Backend engine_dismantling сохранён для разморозки в будущем.
// См. docs/plans/workshop-template-fixes.md.
const FEATURE_ENGINE_DISMANTLE = false;

type LinkOpt = SearchSelectOption;

/** Вкладки карточки двигателя (реорганизация «полотенца», план reclamation-mvp-2026-07). */
export type EngineCardTab = 'main' | 'details' | 'files' | 'reclamation';

const ENGINE_CARD_TABS: { key: EngineCardTab; label: string }[] = [
  { key: 'main', label: 'Основное' },
  { key: 'details', label: 'Детали и акты' },
  { key: 'files', label: 'Фото и документы' },
  { key: 'reclamation', label: 'Рекламация' },
];

function normalizeForMatch(s: string) {
  return String(s ?? '').trim().toLowerCase();
}

function getStatusLabel(code: StatusCode) {
  return code === 'status_customer_sent' ? 'Дата отгрузки' : STATUS_LABELS[code];
}

/** Proactive «похожий двигатель уже есть» hint under the engine_number field (#317). */
function EngineDuplicateHint(props: { matches: EngineDuplicateMatches; showSimilar?: boolean; onOpenEngine?: (engineId: string) => void }) {
  const { exact, similar } = props.matches;
  const isExact = exact.length > 0;
  // Exact (red) is a hard duplicate guard — always shown. Similar (amber «возможно,
  // похожий») is advisory and only meaningful while CREATING a new engine, so it is
  // gated behind showSimilar.
  const list = isExact ? exact : props.showSimilar ? similar : [];
  if (list.length === 0) return null;
  const tone = isExact
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c', icon: '⛔' }
    : { bg: '#fffbeb', border: '#fde68a', fg: '#b45309', icon: '⚠️' };
  const title = isExact
    ? `Двигатель с таким номером уже есть (${exact.length})`
    : `Возможно, похожий двигатель уже есть (${similar.length})`;
  return (
    <div
      style={{
        marginTop: 6,
        maxWidth: '48ch',
        padding: '8px 10px',
        background: tone.bg,
        border: `1px solid ${tone.border}`,
        borderRadius: 8,
        fontSize: 12,
        color: tone.fg,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {tone.icon} {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {list.map((c) => (
          <div key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontWeight: 600 }}>{c.engineNumber}</span>
            {c.engineBrand ? <span style={{ color: 'var(--subtle)' }}>{c.engineBrand}</span> : null}
            {props.onOpenEngine ? (
              <button
                type="button"
                onClick={() => props.onOpenEngine?.(c.id)}
                style={{
                  marginLeft: 'auto',
                  background: 'none',
                  border: 'none',
                  color: '#2563eb',
                  cursor: 'pointer',
                  fontSize: 12,
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Открыть
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// D-#9: ручная галка «Забракован» (status_rejected) убрана из карточки — брак теперь
// авто-определяется по детали-картеру в утиле (см. listEngines). Сам статус остаётся в
// STATUS_CODES (shared): сохраняется/читается/идёт в отчёты и прогресс контракта как раньше,
// просто больше не редактируется вручную здесь.
const STATUS_DISPLAY_ORDER: StatusCode[] = [
  'status_rework_sent',
  'status_storage_received',
  'status_repair_started',
  'status_repaired',
  'status_customer_sent',
  'status_customer_accepted',
];

function toInputDate(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizeDateInput(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatDateLabel(v: string): string {
  const ms = fromInputDate(v);
  if (!ms) return '';
  return formatMoscowDate(ms);
}

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function statusPrintValue(flag: boolean, dateMs: number | null | undefined): string {
  const yn = flag ? 'Да' : 'Нет';
  const dateLabel = toInputDate(dateMs);
  if (!flag || !dateLabel) return yn;
  return `${yn} ${formatDateLabel(dateLabel)}`;
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list)
    ? list.filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string')
    : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items
    .map((f) => {
      const entry = f as { name: string; isObsolete?: boolean };
      const obsoleteBadge =
        entry.isObsolete === true
          ? ' <span style="display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700;color:#991b1b;background:#fee2e2;border:1px solid #fecaca;">Устаревшая версия</span>'
          : '';
      return `<li>${escapeHtml(String(entry.name))}${obsoleteBadge}</li>`;
    })
    .join('')}</ul>`;
}

function printEngineReport(
  engine: EngineDetails,
  context?: {
    engineNumber?: string;
    engineBrand?: string;
    arrivalDate?: string;
    customer?: string;
    contract?: string;
  },
  orderedRows?: Array<[string, string]>,
) {
  const attrs = engine.attributes ?? {};
  const mainRows: Array<[string, string]> =
    orderedRows && orderedRows.length > 0
      ? orderedRows
      : [
          ['Номер двигателя', String(context?.engineNumber ?? attrs.engine_number ?? '')],
          ['Марка двигателя', String(context?.engineBrand ?? attrs.engine_brand ?? '')],
          ['Дата прихода', String(context?.arrivalDate ?? formatDateLabel(toInputDate(attrs.arrival_date as number | null | undefined)) ?? '')],
          ['Контрагент', String(context?.customer ?? attrs.customer_id ?? '')],
          ['Контракт', String(context?.contract ?? attrs.contract_id ?? '')],
        ];

  openPrintPreview({
    title: `Карточка двигателя`,
    ...((context?.engineNumber ?? attrs.engine_number)
      ? { subtitle: `Номер: ${String(context?.engineNumber ?? attrs.engine_number)}` }
      : {}),
    sections: [
      { id: 'main', title: 'Основное', html: keyValueTable(mainRows) },
      { id: 'files', title: 'Файлы', html: fileListHtml(attrs.attachments) },
    ],
  });
}

export function EngineDetailsPage(props: {
  engineId: string;
  engine: EngineDetails;
  onReload: () => Promise<void>;
  onEngineUpdated: () => Promise<void>;
  canEditEngines: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canPrintEngineCard: boolean;
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canExportReports?: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  canConfirmEngineDisassemble?: boolean;
  canAssemblyReturn?: boolean;
  currentUserProfile?: { fullName: string; position: string } | null;
  onOpenEngine?: (engineId: string) => void;
  onOpenEngineBrand?: (engineBrandId: string) => void;
  onOpenCounterparty?: (counterpartyId: string) => void;
  onOpenContract?: (contractId: string) => void;
  onOpenSupplyRequest?: (supplyRequestId: string) => void;
  canCreateSupplyRequest?: boolean;
  /** Ф5: Repair-наряд из строк «свой ремонт» в списке деталей. */
  canCreateWorkOrder?: boolean;
  onOpenWorkOrder?: (workOrderId: string) => void;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
  initialTab?: EngineCardTab;
}) {
  const [dismantleOpen, setDismantleOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [engineNumber, setEngineNumber] = useState(String(props.engine.attributes?.engine_number ?? ''));
  const [dupMatches, setDupMatches] = useState<EngineDuplicateMatches>({ exact: [], similar: [] });
  // "New engine" = the card was opened with an empty number (freshly created). Captured
  // once per engine open (ref-guarded below) so the similar-dup hint shows throughout the
  // create session but not when editing an already-numbered engine.
  const [isNewEngine, setIsNewEngine] = useState(false);
  const [engineBrand, setEngineBrand] = useState(String(props.engine.attributes?.engine_brand ?? ''));
  const [engineBrandId, setEngineBrandId] = useState(String(props.engine.attributes?.engine_brand_id ?? ''));
  const [arrivalDate, setArrivalDate] = useState(
    toInputDate(props.engine.attributes?.arrival_date as number | null | undefined),
  );

  const [customerId, setCustomerId] = useState(String(props.engine.attributes?.customer_id ?? ''));
  const [contractId, setContractId] = useState(String(props.engine.attributes?.contract_id ?? ''));
  const [contractSectionNumber, setContractSectionNumber] = useState(
    String(props.engine.attributes?.contract_section_number ?? ''),
  );
  const [contractSectionOptions, setContractSectionOptions] = useState<ContractSectionOption[]>([]);
  // C-#8: контрагент стал первичным (выбирается пользователем), контракт фильтруется по нему.
  // Эффект загрузки контракта читает свежий customerId через ref — иначе пришлось бы добавить
  // customerId в deps и эффект перезапускался бы на каждый выбор контрагента.
  const customerIdRef = useRef(customerId);
  customerIdRef.current = customerId;
  // Цех, выполнивший ремонт (захват цех-измерения, warehouse-analytics C2). Id из
  // канонного справочника directory_workshops (как наряды/склад), не workshop_ref.
  const [workshopId, setWorkshopId] = useState(String(props.engine.attributes?.workshop_id ?? ''));
  const [workshopOptions, setWorkshopOptions] = useState<LinkOpt[]>([]);
  const [statusFlags, setStatusFlags] = useState<Partial<Record<StatusCode, boolean>>>(() => {
    const attrs = props.engine.attributes ?? {};
    const out: Partial<Record<StatusCode, boolean>> = {};
    for (const c of STATUS_CODES) {
      out[c] = Boolean(attrs[c]);
    }
    return out;
  });
  const [statusDates, setStatusDates] = useState<Partial<Record<StatusCode, number | null>>>(() => {
    const attrs = props.engine.attributes ?? {};
    const out: Partial<Record<StatusCode, number | null>> = {};
    for (const c of STATUS_CODES) {
      out[c] = normalizeDateInput(attrs[statusDateCode(c)]);
    }
    return out;
  });

  const [linkLists, setLinkLists] = useState<Record<string, LinkOpt[]>>({});
  // Резолв id связанной сущности в человекочитаемый label. Пока linkLists ещё не
  // догрузился (или сущность отсутствует) — НЕ показываем оператору сырой UUID:
  // возвращаем пусто. Иначе в поле «Контрагент»/«Контракт» секунду мигает UUID.
  const linkLabel = (key: string, id: string): string => {
    const v = String(id ?? '');
    const m = (linkLists[key] ?? []).find((o) => o.id === v);
    if (m) return m.label;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? '' : v;
  };
  const typeIdByCode = useRef<Record<string, string>>({});
  const [engineTypeId, setEngineTypeId] = useState<string>('');
  const [engineDefs, setEngineDefs] = useState<AttributeDefRow[]>([]);
  const [coreDefsReady, setCoreDefsReady] = useState(false);

  const [saveStatus, setSaveStatus] = useState<string>('');
  const engineBrandOptions =
    (linkLists.engine_brand ?? []).length > 0
      ? (linkLists.engine_brand ?? [])
      : engineBrandId && engineBrand
        ? [{ id: engineBrandId, label: engineBrand }]
        : [];
  const sessionHadChanges = useRef<boolean>(false);
  // Зеркало sessionHadChanges в state — только чтобы ярлык вкладки «Основное»
  // мог показать маркер несохранённых изменений (ref не триггерит рендер).
  const [mainDirty, setMainDirty] = useState(false);
  const setSessionChanged = (v: boolean) => {
    sessionHadChanges.current = v;
    setMainDirty(v);
  };
  const [activeTab, setActiveTab] = useState<EngineCardTab>(props.initialTab ?? 'main');
  const initialSnapshot = useRef<{
    engineNumber: string;
    engineBrand: string;
    arrivalDate: string;
  } | null>(null);
  // Tracks which engineId we last set isNewEngine for, so the sync effect (which also
  // re-runs on updatedAt) flips the flag only when a different engine is opened.
  const newEngineFlagId = useRef<string | null>(null);

  // Проактивная подсказка о дублях номера двигателя (#317): дебаунс, чтобы не дёргать main на каждый символ.
  useEffect(() => {
    const num = engineNumber.trim();
    if (num.length < 3) {
      setDupMatches({ exact: [], similar: [] });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.matrica.engines
        .findDuplicateCandidates({ engineNumber: num, excludeEngineId: props.engineId })
        .then((res) => {
          if (!cancelled) setDupMatches(res ?? { exact: [], similar: [] });
        })
        .catch(() => {
          if (!cancelled) setDupMatches({ exact: [], similar: [] });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [engineNumber, props.engineId]);

  // Синхронизируем локальные поля с тем, что реально лежит в БД (важно при reload/после sync).
  useEffect(() => {
    setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
    setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
    setEngineBrandId(String(props.engine.attributes?.engine_brand_id ?? ''));
    setArrivalDate(toInputDate(props.engine.attributes?.arrival_date as number | null | undefined));
    setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
    setContractId(String(props.engine.attributes?.contract_id ?? ''));
    setContractSectionNumber(String(props.engine.attributes?.contract_section_number ?? ''));
    setWorkshopId(String(props.engine.attributes?.workshop_id ?? ''));
    const attrs = props.engine.attributes ?? {};
    const flags: Partial<Record<StatusCode, boolean>> = {};
    for (const c of STATUS_CODES) flags[c] = Boolean(attrs[c]);
    setStatusFlags(flags);
    const dates: Partial<Record<StatusCode, number | null>> = {};
    for (const c of STATUS_CODES) dates[c] = normalizeDateInput(attrs[statusDateCode(c)]);
    setStatusDates(dates);
    if (newEngineFlagId.current !== props.engineId) {
      newEngineFlagId.current = props.engineId;
      setIsNewEngine(!String(attrs.engine_number ?? '').trim());
    }
  }, [props.engineId, props.engine.updatedAt]);

  useEffect(() => {
    if (!engineBrandId || engineBrand) return;
    const label = (linkLists.engine_brand ?? []).find((o) => o.id === engineBrandId)?.label ?? '';
    if (!label) return;
    setEngineBrand(label);
  }, [engineBrandId, engineBrand, linkLists.engine_brand]);

  useEffect(() => {
    if (engineBrandId || !engineBrand.trim()) return;
    const match = (linkLists.engine_brand ?? []).find(
      (o) => normalizeForMatch(o.label) === normalizeForMatch(engineBrand),
    );
    if (!match) return;
    setEngineBrandId(match.id);
  }, [engineBrandId, engineBrand, linkLists.engine_brand]);

  useEffect(() => {
    if (!contractId) {
      // C-#8: контрагент теперь первичный и независим — НЕ обнуляем его при пустом контракте.
      setContractSectionOptions([]);
      return;
    }
    void (async () => {
      try {
        const contract = await window.matrica.admin.entities.get(contractId);
        const sections = parseContractSections((contract as { attributes?: Record<string, unknown> })?.attributes ?? {});
        setContractSectionOptions(buildContractSectionOptions(sections));
        // Обратный путь (контракт → контрагент) — только запасной: заполняем контрагента из
        // контракта, лишь когда он ещё не задан (выбор контракта первым / backfill старых карточек).
        if (sections.primary.customerId && !customerIdRef.current) {
          setCustomerId(sections.primary.customerId);
        }
      } catch {
        setContractSectionOptions([]);
      }
    })();
  }, [contractId]);

  useEffect(() => {
    // Reset “editing session” baseline on engine switch.
    initialSnapshot.current = {
      engineNumber: String(props.engine.attributes?.engine_number ?? ''),
      engineBrand: String(props.engine.attributes?.engine_brand ?? ''),
      arrivalDate: toInputDate(props.engine.attributes?.arrival_date as number | null | undefined),
    };
    setSessionChanged(false);
    setActiveTab(props.initialTab ?? 'main');
  }, [props.engineId]);

  function asNullableText(v: unknown): string | null {
    const s = String(v ?? '').trim();
    return s ? s : null;
  }

  function sameValue(a: unknown, b: unknown): boolean {
    if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
    const aNum = typeof a === 'number' ? a : typeof a === 'string' && a.trim() !== '' ? Number(a) : null;
    const bNum = typeof b === 'number' ? b : typeof b === 'string' && b.trim() !== '' ? Number(b) : null;
    if (Number.isFinite(aNum) || Number.isFinite(bNum)) {
      return Number.isFinite(aNum) && Number.isFinite(bNum) ? Number(aNum) === Number(bNum) : false;
    }
    return (a == null ? null : String(a)) === (b == null ? null : String(b));
  }

  async function saveAttr(code: string, value: unknown) {
    if (!props.canEditEngines) return;
    try {
      setSaveStatus('Сохраняю...');
      await window.matrica.engines.setAttr(props.engineId, code, value);
      await props.onEngineUpdated();
      setSaveStatus('Сохранено');
      setTimeout(() => setSaveStatus(''), 700);
    } catch (e) {
      setSaveStatus(`Ошибка сохранения: ${String(e)}`);
    }
  }

  const REPAIR_STARTED_CODE: StatusCode = 'status_repair_started';

  /** Взаимоисключение флагов статусов: «Начат ремонт» ↔ остальные; дата начала ремонта при снятии через другой статус не трогаем. */
  function applyStatusCheckboxChange(code: StatusCode, next: boolean) {
    setSessionChanged(true);
    setStatusFlags((prev) => {
      const updated: Partial<Record<StatusCode, boolean>> = { ...prev, [code]: next };
      if (code === REPAIR_STARTED_CODE && next) {
        for (const c of STATUS_CODES) {
          if (c !== REPAIR_STARTED_CODE) updated[c] = false;
        }
      } else if (code !== REPAIR_STARTED_CODE && next) {
        updated[REPAIR_STARTED_CODE] = false;
      }
      return updated;
    });
    setStatusDates((prev) => {
      if (code === REPAIR_STARTED_CODE && next) {
        return { ...prev, [REPAIR_STARTED_CODE]: prev[REPAIR_STARTED_CODE] ?? Date.now() };
      }
      if (code !== REPAIR_STARTED_CODE && next) {
        return { ...prev, [code]: prev[code] ?? Date.now() };
      }
      return { ...prev, [code]: next ? prev[code] ?? Date.now() : null };
    });
  }

  async function saveAllAndClose() {
    if (props.canEditEngines) {
      const attrs = props.engine.attributes ?? {};
      const labelById = (id: string) => (linkLists.engine_brand ?? []).find((o) => o.id === id)?.label ?? '';
      const brandLabel = engineBrandId ? labelById(engineBrandId) || engineBrand : engineBrand;

      const nextValues: Record<string, unknown> = {
        engine_number: engineNumber,
        engine_brand_id: asNullableText(engineBrandId),
        engine_brand: asNullableText(brandLabel),
        arrival_date: fromInputDate(arrivalDate),
        customer_id: asNullableText(customerId),
        contract_id: asNullableText(contractId),
        contract_section_number: asNullableText(contractSectionNumber),
        workshop_id: asNullableText(workshopId),
      };
      for (const c of STATUS_CODES) {
        nextValues[c] = Boolean(statusFlags[c]);
        nextValues[statusDateCode(c)] = statusDates[c] ?? null;
      }

      const currentValues: Record<string, unknown> = {
        engine_number: String(attrs.engine_number ?? ''),
        engine_brand_id: asNullableText(attrs.engine_brand_id),
        engine_brand: asNullableText(attrs.engine_brand),
        arrival_date: normalizeDateInput(attrs.arrival_date),
        customer_id: asNullableText(attrs.customer_id),
        contract_id: asNullableText(attrs.contract_id),
        contract_section_number: asNullableText(attrs.contract_section_number),
        workshop_id: asNullableText(attrs.workshop_id),
      };
      for (const c of STATUS_CODES) {
        currentValues[c] = Boolean(attrs[c]);
        currentValues[statusDateCode(c)] = normalizeDateInput(attrs[statusDateCode(c)]);
      }

      const changedEntries = Object.entries(nextValues).filter(([code, nextValue]) => !sameValue(currentValues[code], nextValue));
      if (changedEntries.length > 0) {
        try {
          setSaveStatus('Сохраняю...');
          for (const [code, value] of changedEntries) {
            await window.matrica.engines.setAttr(props.engineId, code, value);
          }
          // Межцеховая передача («отдал»): цех сменился с одного реального на другой →
          // фиксируем операцию workshop_transfer (from → to) для per-цех учёта C3.
          const prevWorkshop = asNullableText(attrs.workshop_id);
          if (prevWorkshop && workshopId && prevWorkshop !== workshopId) {
            const label = (id: string) => workshopOptions.find((o) => o.id === id)?.label ?? id;
            try {
              await window.matrica.operations.add(
                props.engineId,
                'workshop_transfer',
                'transferred',
                `Цех: ${label(prevWorkshop)} → ${label(workshopId)}`,
                JSON.stringify({ fromWorkshopId: prevWorkshop, toWorkshopId: workshopId }),
              );
            } catch {
              /* передача — аудиторская запись, не валим сохранение карточки */
            }
          }
          await props.onEngineUpdated();
          setSaveStatus('Сохранено');
          setTimeout(() => setSaveStatus(''), 700);
        } catch (e) {
          setSaveStatus(`Ошибка сохранения: ${String(e)}`);
          throw e;
        }
      }
    }
    setSessionChanged(false);
  }

  async function handleDelete() {
    if (!props.canEditEngines) return;
    try {
      setSaveStatus('Удаление…');
      const r = await window.matrica.engines.delete(props.engineId);
      if (!r.ok) {
        setSaveStatus(`Ошибка удаления: ${r.error ?? 'unknown'}`);
        return;
      }
      await props.onEngineUpdated();
      setSaveStatus('Удалено');
      setTimeout(() => setSaveStatus(''), 900);
      props.onClose();
    } catch (e) {
      setSaveStatus(`Ошибка удаления: ${String(e)}`);
    }
  }

  async function auditEditDone() {
    try {
      if (!sessionHadChanges.current) return;
      const base = initialSnapshot.current;
      const fieldsChanged: string[] = [];
      const push = (ru: string, a: string, b: string) => {
        if ((a ?? '') !== (b ?? '')) fieldsChanged.push(ru);
      };
      push('Номер', base?.engineNumber ?? '', String(engineNumber ?? ''));
      push('Марка', base?.engineBrand ?? '', String(engineBrand ?? ''));
      push('Дата прихода', base?.arrivalDate ?? '', String(arrivalDate ?? ''));
      if (!fieldsChanged.length) return;
      await window.matrica.audit.add({
        action: 'ui.engine.edit_done',
        entityId: props.engineId,
        tableName: 'entities',
        payload: {
          engineId: props.engineId,
          engineNumber: String(engineNumber || '').trim() || null,
          engineBrand: String(engineBrand || '').trim() || null,
          fieldsChanged,
          summaryRu: `Изменил: ${fieldsChanged.join(', ')}`,
        },
      });
      setSessionChanged(false);
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    return () => {
      void auditEditDone();
    };
  }, []);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => sessionHadChanges.current,
      saveAndClose: async () => {
        await saveAllAndClose();
        setSessionChanged(false);
      },
      reset: async () => {
        await props.onReload();
        setSessionChanged(false);
      },
      closeWithoutSave: () => {
        setSessionChanged(false);
      },
      copyToNew: async () => {
        const r = await window.matrica.engines.create();
        if (r?.id) {
          await window.matrica.engines.setAttr(r.id, 'engine_number', engineNumber + ' (копия)');
          await window.matrica.engines.setAttr(r.id, 'engine_brand', engineBrand || null);
          await window.matrica.engines.setAttr(r.id, 'engine_brand_id', engineBrandId || null);
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [engineNumber, engineBrand, engineBrandId, arrivalDate, customerId, contractId, contractSectionNumber, workshopId, statusFlags, statusDates, props.registerCardCloseActions]);

  async function saveAttachments(next: any[]) {
    try {
      await saveAttr('attachments', next);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  }

  // Дефектовка → заявка в снабжение: создаём черновик и кладём в него детали «к заказу».
  async function handleCreateSupplyRequestFromDefects(items: SupplyRequestItem[], photos: FileRef[] = []) {
    if (!items.length) return;
    setSaveStatus('Создаём заявку в снабжение…');
    try {
      const created = await window.matrica.supplyRequests.create();
      if (!created?.ok) {
        setSaveStatus(`Ошибка: ${String(created?.error ?? 'не удалось создать заявку')}`);
        return;
      }
      const payload = { ...created.payload, items, ...(photos.length ? { attachments: photos } : {}) };
      const upd = await window.matrica.supplyRequests.update({ id: created.id, payload });
      if (!upd?.ok) {
        setSaveStatus(`Ошибка: ${String(upd?.error ?? 'не удалось записать позиции заявки')}`);
        return;
      }
      setSaveStatus(`Заявка ${created.payload.requestNumber} создана (${items.length} поз.)`);
      props.onOpenSupplyRequest?.(created.id);
    } catch (e) {
      setSaveStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function loadLinkLists() {
    const types = await window.matrica.admin.entityTypes.list();
    typeIdByCode.current = Object.fromEntries(types.map((t) => [String(t.code), String(t.id)]));
    const typeIdByCodeMap = new Map(types.map((t) => [t.code, t.id] as const));
    const engineType = types.find((t) => String(t.code) === 'engine');
    if (engineType?.id) {
      setEngineTypeId(String(engineType.id));
      const defs = await window.matrica.admin.attributeDefs.listByEntityType(String(engineType.id));
      setEngineDefs(defs as AttributeDefRow[]);
      setCoreDefsReady(false);
    }
    async function load(code: string, key: string) {
      const tid = typeIdByCodeMap.get(code);
      if (!tid) return;
      const rows = await window.matrica.admin.entities.listByEntityType(tid);
      const opts = mapEntityRowsToSearchOptions(rows);
      setLinkLists((p) => ({ ...p, [key]: opts }));
    }
    // Параллельно — иначе customer/contract ждут engine_brand и в поле секунду мигает UUID.
    await Promise.all([
      load('engine_brand', 'engine_brand'),
      load('customer', 'customer_id'),
      load('contract', 'contract_id'),
    ]);
    // Цеха — из directory_workshops (канон), не из workshop_ref entity-type.
    try {
      const wr = await window.matrica.workshops.list({ activeOnly: true });
      if (wr?.ok) setWorkshopOptions(wr.rows.map((w) => ({ id: String(w.id), label: String(w.name) })));
    } catch {
      /* ignore — селектор просто будет пустым */
    }
  }

  useEffect(() => {
    if (!props.canViewMasterData) return;
    void loadLinkLists();
  }, [props.canViewMasterData]);

  useEffect(() => {
    if (!props.canEditMasterData || !engineTypeId || engineDefs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'engine_number', name: 'Номер двигателя', dataType: 'text', sortOrder: 10 },
      {
        code: 'engine_brand_id',
        name: 'Марка двигателя',
        dataType: 'link',
        sortOrder: 20,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'engine_brand' }),
      },
      {
        code: 'customer_id',
        name: 'Контрагент',
        dataType: 'link',
        sortOrder: 30,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'customer' }),
      },
      {
        code: 'contract_id',
        name: 'Контракт',
        dataType: 'link',
        sortOrder: 40,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'contract' }),
      },
      { code: 'contract_section_number', name: 'ДС контракта', dataType: 'text', sortOrder: 45 },
      {
        code: 'workshop_id',
        name: 'Цех',
        dataType: 'link',
        sortOrder: 47,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'workshop' }),
      },
      { code: 'arrival_date', name: 'Дата прихода', dataType: 'date', sortOrder: 50 },
      ...STATUS_DISPLAY_ORDER.flatMap((code, i) => [
        { code, name: STATUS_LABELS[code], dataType: 'boolean' as const, sortOrder: 60 + i * 2 },
        { code: statusDateCode(code), name: `Дата ${STATUS_LABELS[code]}`, dataType: 'date', sortOrder: 61 + i * 2 },
      ]),
    ];
    void ensureAttributeDefs(engineTypeId, desired, engineDefs).then((next) => {
      const orderedCodes = desired.map((f) => f.code);
      void persistFieldOrder(orderedCodes, next, { entityTypeId: engineTypeId }).then(() => {
        setEngineDefs([...next]);
        setCoreDefsReady(true);
      });
    });
  }, [props.canEditMasterData, engineTypeId, engineDefs.length, coreDefsReady]);

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const typeId = typeIdByCode.current[typeCode];
    if (!typeId) {
      setSaveStatus(`Справочник не найден: ${typeCode}`);
      return null;
    }
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created.ok || !created.id) {
      setSaveStatus(`Ошибка создания: ${typeCode}`);
      return null;
    }
    const attrByType: Record<string, string> = {
      engine_brand: 'name',
      customer: 'name',
      contract: 'number',
    };
    const attr = attrByType[typeCode] ?? 'name';
    await window.matrica.admin.entities.setAttr(created.id, attr, label);
    await loadLinkLists();
    return created.id;
  }

  // Резиновые поля верхнего блока: floor 30 символов, потолок ~48ch — не на всю ширину экрана.
  const elasticFieldStyle: React.CSSProperties = { width: '100%', minWidth: '30ch', maxWidth: '48ch' };

  const mainFieldItems = [
    {
      code: 'engine_number',
      defaultOrder: 10,
      label: 'Номер двигателя',
      value: engineNumber,
      render: (
        <>
          <Input
            value={engineNumber}
            disabled={!props.canEditEngines}
            // Fill the value column like the sibling fields (Марка/Контрагент) AND keep a
            // 30-character floor so long numbers («2Ж11АТ1798…») are never clipped even
            // when the grid cell is narrow. width:100% grows with the cell; minWidth:30ch
            // is the readable floor (a bare `min-width` without width:100% collapsed the
            // field to ~86px in earlier attempts, so we keep both).
            style={{ width: '100%', minWidth: '30ch' }}
            onChange={(e) => {
              setSessionChanged(true);
              setEngineNumber(e.target.value);
            }}
          />
          <EngineDuplicateHint matches={dupMatches} showSimilar={isNewEngine} {...(props.onOpenEngine ? { onOpenEngine: props.onOpenEngine } : {})} />
        </>
      ),
    },
    {
      code: 'engine_brand_id',
      defaultOrder: 20,
      label: 'Марка двигателя',
      value: engineBrand,
      render: (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
          <SearchSelectWithCreate
            value={engineBrandId || null}
            options={engineBrandOptions}
            disabled={!props.canEditEngines}
            canCreate={props.canEditMasterData}
            createLabel="Новая марка двигателя"
            onChange={(next) => {
              const nextId = next ?? '';
              const label = next ? engineBrandOptions.find((o) => o.id === next)?.label ?? '' : '';
              setSessionChanged(true);
              setEngineBrandId(nextId);
              setEngineBrand(label);
            }}
            onCreate={async (label) => {
              const id = await createMasterDataItem('engine_brand', label);
              if (!id) return null;
              setSessionChanged(true);
              setEngineBrandId(id);
              setEngineBrand(label);
              return id;
            }}
          />
          {engineBrandId && props.onOpenEngineBrand ? (
            <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenEngineBrand?.(engineBrandId)}>
              Открыть
            </Button>
          ) : null}
          {(linkLists.engine_brand ?? []).length === 0 && (
            <span style={{ color: 'var(--subtle)', fontSize: 12 }}>Справочник марок пуст — выберите или создайте значение.</span>
          )}
        </div>
      ),
    },
    {
      code: 'arrival_date',
      defaultOrder: 50,
      label: 'Дата прихода',
      value: arrivalDate,
      render: (
        <Input
          type="date"
          value={arrivalDate}
          disabled={!props.canEditEngines}
          style={elasticFieldStyle}
          onChange={(e) => {
            setSessionChanged(true);
            setArrivalDate(e.target.value);
          }}
        />
      ),
    },
    props.canViewMasterData
      ? {
          code: 'customer_id',
          defaultOrder: 30,
          label: 'Контрагент',
          value: linkLabel('customer_id', customerId),
          render: (
            // C-#8: контрагент выбирается первым и фильтрует список контрактов ниже.
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(30ch, 48ch) auto', gap: 8, alignItems: 'start' }}>
              <SearchSelectWithCreate
                value={customerId || null}
                options={linkLists.customer_id ?? []}
                disabled={!props.canEditEngines}
                canCreate={props.canEditMasterData}
                createLabel="Контрагент"
                onChange={(next) => {
                  const v = next ?? '';
                  setSessionChanged(true);
                  setCustomerId(v);
                  // Сменили контрагента — сбрасываем контракт/ДС, если они принадлежат другому
                  // контрагенту (его UUID нет в searchText опции контракта).
                  if (v && contractId) {
                    const opt = (linkLists.contract_id ?? []).find((o) => o.id === contractId);
                    if (opt && !(opt.searchText ?? '').includes(v)) {
                      setContractId('');
                      setContractSectionNumber('');
                    }
                  }
                }}
                onCreate={async (label) => createMasterDataItem('customer', label)}
              />
              {customerId && props.onOpenCounterparty ? (
                <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenCounterparty?.(customerId)}>
                  Открыть
                </Button>
              ) : null}
            </div>
          ),
        }
      : null,
    props.canViewMasterData
      ? {
          code: 'contract_id',
          defaultOrder: 40,
          label: 'Контракт',
          value: linkLabel('contract_id', contractId),
          render: (
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(30ch, 48ch) auto', gap: 8, alignItems: 'start' }}>
              <SearchSelectWithCreate
                value={contractId || null}
                // C-#8: показываем только контракты выбранного контрагента (его UUID есть в
                // searchText опции — он склеен из всех значений атрибутов, включая customer_id и
                // contract_sections). Без контрагента — все контракты (обратный путь contract→customer).
                options={(linkLists.contract_id ?? []).filter(
                  (o) => !customerId || (o.searchText ?? '').includes(customerId),
                )}
                disabled={!props.canEditEngines}
                canCreate={props.canEditMasterData}
                createLabel="Номер контракта"
                onChange={(next) => {
                  const v = next ?? '';
                  setSessionChanged(true);
                  setContractId(v);
                }}
                onCreate={async (label) => {
                  const id = await createMasterDataItem('contract', label);
                  // Новый контракт создаётся для выбранного контрагента — привязываем его, иначе
                  // он сразу выпал бы из отфильтрованного списка (нет customerId в searchText).
                  if (id && customerId) {
                    await window.matrica.admin.entities.setAttr(id, 'customer_id', customerId);
                    await loadLinkLists();
                  }
                  return id;
                }}
              />
              {contractId && props.onOpenContract ? (
                <Button
                  variant="outline"
                  tone="neutral"
                  size="sm"
                  onClick={() => props.onOpenContract?.(contractId)}
                >
                  Открыть
                </Button>
              ) : null}
            </div>
          ),
        }
      : null,
    props.canViewMasterData
      ? {
          code: 'contract_section_number',
          defaultOrder: 45,
          label: 'ДС контракта',
          value: contractSectionNumber,
          render: (
            <SearchSelect
              value={contractSectionNumber || null}
              options={(contractSectionNumber && !contractSectionOptions.some((o) => o.id === contractSectionNumber)
                ? [{ id: contractSectionNumber, label: contractSectionNumber }, ...contractSectionOptions]
                : contractSectionOptions
              ).map((o) => ({ id: o.id, label: o.label }))}
              placeholder={contractId ? 'Выберите ДС' : 'Сначала выберите контракт'}
              disabled={!props.canEditEngines || !contractId || contractSectionOptions.length === 0}
              showAllWhenEmpty
              onChange={(next) => {
                setSessionChanged(true);
                setContractSectionNumber(next ?? '');
              }}
            />
          ),
        }
      : null,
    props.canViewMasterData
      ? {
          code: 'workshop_id',
          defaultOrder: 47,
          label: 'Цех',
          value: workshopOptions.find((o) => o.id === workshopId)?.label ?? '',
          render: (
            <SearchSelect
              value={workshopId || null}
              options={workshopOptions}
              placeholder="Выберите цех"
              disabled={!props.canEditEngines || workshopOptions.length === 0}
              showAllWhenEmpty
              onChange={(next) => {
                setSessionChanged(true);
                setWorkshopId(next ?? '');
              }}
            />
          ),
        }
      : null,
    ...STATUS_DISPLAY_ORDER.map((code) => {
      const dateValue = toInputDate(statusDates[code] ?? null);
      return {
        code,
        defaultOrder: 60 + STATUS_DISPLAY_ORDER.indexOf(code) * 2,
        label: getStatusLabel(code),
        value: statusFlags[code] ? 'да' : 'нет',
        render: (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={!!statusFlags[code]}
                disabled={!props.canEditEngines}
                onChange={(e) => {
                  applyStatusCheckboxChange(code, e.target.checked);
                }}
              />
              <span>{statusFlags[code] ? 'Да' : 'Нет'}</span>
            </label>
            <Input
              type="date"
              value={dateValue}
              disabled={!props.canEditEngines}
              style={{ width: 168, minWidth: 168 }}
              onChange={(e) => {
                setSessionChanged(true);
                setStatusDates((prev) => ({ ...prev, [code]: fromInputDate(e.target.value) }));
              }}
            />
          </div>
        ),
      };
    }),
  ].filter(Boolean);
  const mainFields = orderFieldsByDefs(mainFieldItems as any[], engineDefs);

  const orderedPrintRows: Array<[string, string]> = [
    ['Номер двигателя', engineNumber],
    ['Марка двигателя', engineBrand],
    ['Контрагент', linkLabel('customer_id', customerId)],
    ['Контракт', linkLabel('contract_id', contractId)],
    ['ДС контракта', contractSectionNumber],
    ['Дата прихода', formatDateLabel(arrivalDate)],
    ['Забракован', statusPrintValue(Boolean(statusFlags.status_rejected), statusDates.status_rejected)],
    [
      'Отправлен заказчику на перекомплектацию',
      statusPrintValue(Boolean(statusFlags.status_rework_sent), statusDates.status_rework_sent),
    ],
    ['Принят на хранение', statusPrintValue(Boolean(statusFlags.status_storage_received), statusDates.status_storage_received)],
    ['Начат ремонт', statusPrintValue(Boolean(statusFlags.status_repair_started), statusDates.status_repair_started)],
    ['Отремонтирован', statusPrintValue(Boolean(statusFlags.status_repaired), statusDates.status_repaired)],
    ['Дата отгрузки', statusPrintValue(Boolean(statusFlags.status_customer_sent), statusDates.status_customer_sent)],
    ['Принято заказчиком', statusPrintValue(Boolean(statusFlags.status_customer_accepted), statusDates.status_customer_accepted)],
  ];
  const headerTitle = engineNumber.trim() ? `Двигатель: ${engineNumber.trim()}` : 'Карточка двигателя';
  const contractLabelForChecklist = ((linkLists.contract_id ?? []).find((o) => o.id === contractId)?.label ?? '').trim();
  const arrivalDateMsForChecklist = fromInputDate(arrivalDate);
  const handlePrint = () => {
    const pickLabel = (key: string, id: string) => (linkLists[key] ?? []).find((o) => o.id === id)?.label ?? id;
    printEngineReport(
      props.engine,
      {
        engineNumber,
        engineBrand,
        arrivalDate,
        customer: pickLabel('customer_id', customerId),
        contract: pickLabel('contract_id', contractId),
      },
      orderedPrintRows,
    );
  };

  return (
    <EntityCardShell
      title={headerTitle}
      layout="two-column"
      className="entity-card-shell--full-width"
      cardActions={
        <CardActionBar
          canEdit={props.canEditEngines}
          onCopyToNew={() => {
            void (async () => {
              const r = await window.matrica.engines.create();
              if (r?.id) {
                await window.matrica.engines.setAttr(r.id, 'engine_number', engineNumber + ' (копия)');
                await window.matrica.engines.setAttr(r.id, 'engine_brand', engineBrand || null);
                await window.matrica.engines.setAttr(r.id, 'engine_brand_id', engineBrandId || null);
              }
            })();
          }}
          onSave={() => { void saveAllAndClose().catch(() => undefined); }}
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onReset={() => {
            void props.onReload().then(() => {
              setSessionChanged(false);
            });
          }}
          onPrint={props.canPrintEngineCard ? handlePrint : undefined}
          onDelete={() => void handleDelete()}
          deleteConfirmDetail={`Будет удалён двигатель «${String(engineNumber || '').trim() || props.engineId}» (марка: ${String(engineBrand || '—').trim()}). Действие обычно нельзя отменить.`}
          onClose={() => props.requestClose?.()}
        />
      }
      status={saveStatus ? <div style={{ color: saveStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 12 }}>{saveStatus}</div> : null}
    >
        {/* Вкладки карточки (план reclamation-mvp-2026-07 Ф0). Панели НЕ размонтируются
            (скрытие через hidden) — save-on-close/черновики/печать работают по state как раньше. */}
        <div className="entity-card-span-full" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderBottom: '1px solid var(--border)' }}>
          {ENGINE_CARD_TABS.filter((t) => t.key !== 'details' || props.canViewOperations).map((t) => {
            const active = activeTab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                style={{
                  padding: '7px 14px',
                  borderRadius: '10px 10px 0 0',
                  border: '1px solid var(--border)',
                  borderBottom: 'none',
                  background: active ? 'rgba(59, 130, 246, 0.12)' : 'transparent',
                  fontWeight: active ? 700 : 400,
                  cursor: 'pointer',
                  color: 'inherit',
                  fontSize: 13,
                }}
              >
                {t.label}
                {t.key === 'main' && mainDirty ? <span style={{ color: 'var(--danger)' }}> ●</span> : null}
              </button>
            );
          })}
        </div>

        {/* Поля + действия — центрированная читаемая колонка (а не прижатая влево
            с пустотой справа): span-full тянется на всю grid-ширину, но внутренний
            контейнер капнут и центрирован, контролы не растягиваются. UI-аудит p2 #5. */}
        <div className="entity-card-span-full" hidden={activeTab !== 'main'} style={{ maxWidth: 820, width: '100%', margin: '0 auto' }}>
        <SectionCard style={{ padding: 12, background: 'rgba(59, 130, 246, 0.08)' }}>
        <DraggableFieldList
          items={mainFields}
          getKey={(f) => f.code}
          canDrag={props.canEditMasterData}
          onReorder={(next) => {
            if (!engineTypeId) return;
            void persistFieldOrder(
              next.map((f) => f.code),
              engineDefs,
              { entityTypeId: engineTypeId },
            ).then(() => setEngineDefs([...engineDefs]));
          }}
          renderItem={(field, itemProps, _dragHandleProps, state) => (
            <div
              {...itemProps}
              className="card-row"
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(140px, 180px) 1fr',
                gap: 8,
                alignItems: 'center',
                padding: '4px 6px',
                border: state.isOver ? '1px dashed var(--input-border-focus)' : '1px solid var(--card-row-border)',
                background: state.isDragging ? 'var(--card-row-drag-bg)' : undefined,
              }}
            >
              <div style={{ color: 'var(--subtle)' }}>{field.label}</div>
              {field.render}
            </div>
          )}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <Button
            variant="ghost"
            onClick={() => {
              setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
              setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
              setEngineBrandId(String(props.engine.attributes?.engine_brand_id ?? ''));
              setArrivalDate(toInputDate(props.engine.attributes?.arrival_date as number | null | undefined));
              setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
              setContractId(String(props.engine.attributes?.contract_id ?? ''));
              setContractSectionNumber(String(props.engine.attributes?.contract_section_number ?? ''));
              const attrs = props.engine.attributes ?? {};
              const flags: Partial<Record<StatusCode, boolean>> = {};
              for (const c of STATUS_CODES) flags[c] = Boolean(attrs[c]);
              setStatusFlags(flags);
              const dates: Partial<Record<StatusCode, number | null>> = {};
              for (const c of STATUS_CODES) dates[c] = normalizeDateInput(attrs[statusDateCode(c)]);
              setStatusDates(dates);
              setSessionChanged(false);
            }}
          >
            Отменить
          </Button>
          <div style={{ flex: 1 }} />
          {props.canEditEngines && (
            <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
              Изменения сохраняются одним действием при закрытии карточки.
            </div>
          )}
        </div>
      </SectionCard>

      {((FEATURE_ENGINE_DISMANTLE && props.canConfirmEngineDisassemble) || props.canAssemblyReturn) && (
        <SectionCard style={{ padding: 12, background: 'rgba(168, 85, 247, 0.08)' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>Модуль движения деталей:</strong>
            {FEATURE_ENGINE_DISMANTLE && props.canConfirmEngineDisassemble && (
              <Button
                onClick={() => setDismantleOpen(true)}
                title="Создать и провести документ engine_dismantling: годные детали → ремфонд, утиль → утиль"
              >
                Разобрать двигатель
              </Button>
            )}
            {props.canAssemblyReturn && (
              <Button
                variant="ghost"
                onClick={() => setReturnOpen(true)}
                title="Возврат деталей из «в сборке» в ремфонд (доработка) или утиль"
              >
                Возврат из сборки
              </Button>
            )}
            <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
              Действия создают складские движения с привязкой к этому двигателю; видны в журнале (отчёт «Журнал движений деталей»).
            </span>
          </div>
        </SectionCard>
      )}
        </div>

      {FEATURE_ENGINE_DISMANTLE && (
        <EngineDismantlePreviewDialog
          open={dismantleOpen}
          onClose={() => setDismantleOpen(false)}
          engineId={props.engineId}
          engineLabel={String(engineNumber || props.engineId)}
          engineBrandId={engineBrandId || null}
        />
      )}
      <AssemblyReturnDialog
        open={returnOpen}
        onClose={() => setReturnOpen(false)}
        engineId={props.engineId}
        engineLabel={String(engineNumber || props.engineId)}
      />

      {props.canViewOperations && (
        <div className="entity-card-span-full" hidden={activeTab !== 'details'} style={{ background: 'rgba(99, 102, 241, 0.08)', borderRadius: 14, padding: 10 }}>
          <RepairChecklistPanel
            engineId={props.engineId}
            stage="engine_inventory"
            canEdit={props.canEditOperations}
            canEditMasterData={props.canEditMasterData}
            canPrint={props.canPrintEngineCard}
            canExport={props.canExportReports === true}
            engineNumber={engineNumber}
            engineBrand={engineBrand}
            contractNumber={contractLabelForChecklist}
            arrivalDate={arrivalDateMsForChecklist}
            {...(engineBrandId ? { engineBrandId } : {})}
            {...(() => {
              const name = workshopOptions.find((o) => o.id === workshopId)?.label ?? '';
              return name ? { workshopName: name } : {};
            })()}
            canViewFiles={props.canViewFiles}
            canUploadFiles={props.canUploadFiles}
            currentUserProfile={props.currentUserProfile ?? null}
            {...(props.canCreateSupplyRequest && props.onOpenSupplyRequest
              ? { onCreateSupplyRequestFromDefects: handleCreateSupplyRequestFromDefects }
              : {})}
            {...(props.canCreateWorkOrder ? { canCreateWorkOrder: true } : {})}
            {...(props.onOpenWorkOrder ? { onOpenWorkOrder: props.onOpenWorkOrder } : {})}
          />
        </div>
      )}

      <div className="entity-card-span-full" hidden={activeTab !== 'files'}>
        <EnginePhotoGallery
          value={props.engine.attributes?.attachments}
          canView={props.canViewFiles}
          canDelete={props.canUploadFiles && props.canEditEngines}
          engineLabel={[engineBrand, engineNumber].filter(Boolean).join(' ')}
          onChange={saveAttachments}
        />
        <AttachmentsPanel
          title="Вложения к двигателю"
          value={props.engine.attributes?.attachments}
          canView={props.canViewFiles}
          canUpload={props.canUploadFiles && props.canEditEngines}
          onChange={saveAttachments}
        />
      </div>

      <div className="entity-card-span-full" hidden={activeTab !== 'reclamation'} style={{ maxWidth: 820, width: '100%', margin: '0 auto' }}>
        <SectionCard style={{ padding: 16 }}>
          <div style={{ color: 'var(--subtle)', fontSize: 13 }}>
            Двигатель не принят по рекламации. Рекламационный учёт появится здесь в следующем обновлении.
          </div>
        </SectionCard>
      </div>
    </EntityCardShell>
  );
}


