import React, { useEffect, useRef, useState } from 'react';

import type { EngineDetails } from '@matricarmz/shared';
import { parseContractSections, STATUS_CODES, STATUS_LABELS, statusDateCode, type StatusCode } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { SectionCard } from '../components/SectionCard.js';
import { RepairChecklistPanel } from '../components/RepairChecklistPanel.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';
import { CardActionBar } from '../components/CardActionBar.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { mapEntityRowsToSearchOptions } from '../utils/selectOptions.js';

type LinkOpt = SearchSelectOption;

function normalizeForMatch(s: string) {
  return String(s ?? '').trim().toLowerCase();
}

function getStatusLabel(code: StatusCode) {
  return code === 'status_customer_sent' ? 'Дата отгрузки' : STATUS_LABELS[code];
}

const STATUS_DISPLAY_ORDER: StatusCode[] = [
  'status_rejected',
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
  currentUserProfile?: { fullName: string; position: string } | null;
  onOpenEngineBrand?: (engineBrandId: string) => void;
  onOpenCounterparty?: (counterpartyId: string) => void;
  onOpenContract?: (contractId: string) => void;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [engineNumber, setEngineNumber] = useState(String(props.engine.attributes?.engine_number ?? ''));
  const [engineBrand, setEngineBrand] = useState(String(props.engine.attributes?.engine_brand ?? ''));
  const [engineBrandId, setEngineBrandId] = useState(String(props.engine.attributes?.engine_brand_id ?? ''));
  const [arrivalDate, setArrivalDate] = useState(
    toInputDate(props.engine.attributes?.arrival_date as number | null | undefined),
  );

  const [customerId, setCustomerId] = useState(String(props.engine.attributes?.customer_id ?? ''));
  const [contractId, setContractId] = useState(String(props.engine.attributes?.contract_id ?? ''));
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
  const initialSnapshot = useRef<{
    engineNumber: string;
    engineBrand: string;
    arrivalDate: string;
  } | null>(null);

  // Синхронизируем локальные поля с тем, что реально лежит в БД (важно при reload/после sync).
  useEffect(() => {
    setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
    setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
    setEngineBrandId(String(props.engine.attributes?.engine_brand_id ?? ''));
    setArrivalDate(toInputDate(props.engine.attributes?.arrival_date as number | null | undefined));
    setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
    setContractId(String(props.engine.attributes?.contract_id ?? ''));
    const attrs = props.engine.attributes ?? {};
    const flags: Partial<Record<StatusCode, boolean>> = {};
    for (const c of STATUS_CODES) flags[c] = Boolean(attrs[c]);
    setStatusFlags(flags);
    const dates: Partial<Record<StatusCode, number | null>> = {};
    for (const c of STATUS_CODES) dates[c] = normalizeDateInput(attrs[statusDateCode(c)]);
    setStatusDates(dates);
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
      setCustomerId('');
      return;
    }
    void (async () => {
      try {
        const contract = await window.matrica.admin.entities.get(contractId);
        const sections = parseContractSections((contract as { attributes?: Record<string, unknown> })?.attributes ?? {});
        setCustomerId(sections.primary.customerId ?? '');
      } catch {
        setCustomerId('');
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
    sessionHadChanges.current = false;
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
    sessionHadChanges.current = true;
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
          await props.onEngineUpdated();
          setSaveStatus('Сохранено');
          setTimeout(() => setSaveStatus(''), 700);
        } catch (e) {
          setSaveStatus(`Ошибка сохранения: ${String(e)}`);
          throw e;
        }
      }
    }
    sessionHadChanges.current = false;
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
      sessionHadChanges.current = false;
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
        sessionHadChanges.current = false;
      },
      reset: async () => {
        await props.onReload();
        sessionHadChanges.current = false;
      },
      closeWithoutSave: () => {
        sessionHadChanges.current = false;
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
  }, [engineNumber, engineBrand, engineBrandId, arrivalDate, customerId, contractId, statusFlags, statusDates, props.registerCardCloseActions]);

  async function saveAttachments(next: any[]) {
    try {
      await saveAttr('attachments', next);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: String(e) };
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
    await load('engine_brand', 'engine_brand');
    await load('customer', 'customer_id');
    await load('contract', 'contract_id');
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

  const mainFieldItems = [
    {
      code: 'engine_number',
      defaultOrder: 10,
      label: 'Номер двигателя',
      value: engineNumber,
      render: (
        <Input
          value={engineNumber}
          disabled={!props.canEditEngines}
          onChange={(e) => {
            sessionHadChanges.current = true;
            setEngineNumber(e.target.value);
          }}
        />
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
              sessionHadChanges.current = true;
              setEngineBrandId(nextId);
              setEngineBrand(label);
            }}
            onCreate={async (label) => {
              const id = await createMasterDataItem('engine_brand', label);
              if (!id) return null;
              sessionHadChanges.current = true;
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
          onChange={(e) => {
            sessionHadChanges.current = true;
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
          value: (linkLists.customer_id ?? []).find((o) => o.id === customerId)?.label ?? customerId,
          render: (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
              <Input value={(linkLists.customer_id ?? []).find((o) => o.id === customerId)?.label ?? customerId} disabled />
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
          value: (linkLists.contract_id ?? []).find((o) => o.id === contractId)?.label ?? contractId,
          render: (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
              <SearchSelectWithCreate
                value={contractId || null}
                options={linkLists.contract_id ?? []}
                disabled={!props.canEditEngines}
                canCreate={props.canEditMasterData}
                createLabel="Номер контракта"
                onChange={(next) => {
                  const v = next ?? '';
                  sessionHadChanges.current = true;
                  setContractId(v);
                }}
                onCreate={async (label) => createMasterDataItem('contract', label)}
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
                sessionHadChanges.current = true;
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
    ['Контрагент', (linkLists.customer_id ?? []).find((o) => o.id === customerId)?.label ?? customerId],
    ['Контракт', (linkLists.contract_id ?? []).find((o) => o.id === contractId)?.label ?? contractId],
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
          onSaveAndClose={() => { void saveAllAndClose().then(() => props.onClose()); }}
          onReset={() => {
            void props.onReload().then(() => {
              sessionHadChanges.current = false;
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
              const attrs = props.engine.attributes ?? {};
              const flags: Partial<Record<StatusCode, boolean>> = {};
              for (const c of STATUS_CODES) flags[c] = Boolean(attrs[c]);
              setStatusFlags(flags);
              const dates: Partial<Record<StatusCode, number | null>> = {};
              for (const c of STATUS_CODES) dates[c] = normalizeDateInput(attrs[statusDateCode(c)]);
              setStatusDates(dates);
              sessionHadChanges.current = false;
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

      {props.canViewOperations && (
        <div style={{ background: 'rgba(248, 113, 113, 0.08)', borderRadius: 14, padding: 10 }}>
          <RepairChecklistPanel
            engineId={props.engineId}
            stage="defect"
            canEdit={props.canEditOperations}
            canEditMasterData={props.canEditMasterData}
            canPrint={props.canPrintEngineCard}
            canExport={props.canExportReports === true}
            engineNumber={engineNumber}
            engineBrand={engineBrand}
            contractNumber={contractLabelForChecklist}
            arrivalDate={arrivalDateMsForChecklist}
            {...(engineBrandId ? { engineBrandId } : {})}
            canViewFiles={props.canViewFiles}
            canUploadFiles={props.canUploadFiles}
            currentUserProfile={props.currentUserProfile ?? null}
          />
        </div>
      )}

      {props.canViewOperations && (
        <div style={{ background: 'rgba(34, 197, 94, 0.08)', borderRadius: 14, padding: 10 }}>
          <RepairChecklistPanel
            engineId={props.engineId}
            stage="completeness"
            canEdit={props.canEditOperations}
            canEditMasterData={props.canEditMasterData}
            canPrint={props.canPrintEngineCard}
            canExport={props.canExportReports === true}
            engineNumber={engineNumber}
            engineBrand={engineBrand}
            contractNumber={contractLabelForChecklist}
            arrivalDate={arrivalDateMsForChecklist}
            {...(engineBrandId ? { engineBrandId } : {})}
            canViewFiles={props.canViewFiles}
            canUploadFiles={props.canUploadFiles}
            currentUserProfile={props.currentUserProfile ?? null}
          />
        </div>
      )}

      {props.canViewOperations && (
        <RepairChecklistPanel
          engineId={props.engineId}
          stage="repair"
          canEdit={props.canEditOperations}
          canEditMasterData={props.canEditMasterData}
          canPrint={props.canPrintEngineCard}
          canExport={props.canExportReports === true}
          engineNumber={engineNumber}
          engineBrand={engineBrand}
          contractNumber={contractLabelForChecklist}
          arrivalDate={arrivalDateMsForChecklist}
          {...(engineBrandId ? { engineBrandId } : {})}
          canViewFiles={props.canViewFiles}
          canUploadFiles={props.canUploadFiles}
          currentUserProfile={props.currentUserProfile ?? null}
        />
      )}

      <div className="entity-card-span-full">
        <AttachmentsPanel
          title="Вложения к двигателю"
          value={props.engine.attributes?.attachments}
          canView={props.canViewFiles}
          canUpload={props.canUploadFiles && props.canEditEngines}
          onChange={saveAttachments}
        />
      </div>
    </EntityCardShell>
  );
}


