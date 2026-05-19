import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { ColumnSettingsButton, type ColumnDescriptor } from '../components/ColumnSettingsButton.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { Input } from '../components/Input.js';
import { ListContextMenu } from '../components/ListContextMenu.js';
import { ListRowThumbs } from '../components/ListRowThumbs.js';
import { TwoColumnList } from '../components/TwoColumnList.js';
import { ListColumnsToggle } from '../components/ListColumnsToggle.js';
import { useColumnLayout } from '../hooks/useColumnLayout.js';
import { useWindowWidth } from '../hooks/useWindowWidth.js';
import { useListColumnsMode } from '../hooks/useListColumnsMode.js';
import { useListSelection } from '../hooks/useListSelection.js';
import { sortArrow, toggleSort, useListUiState, usePersistedScrollTop, useSortedItems } from '../hooks/useListBehavior.js';
import { useLiveDataRefresh } from '../hooks/useLiveDataRefresh.js';
import {
  aggregateContractExecutionProgress,
  effectiveContractDueAt,
  type ContractSections,
  type ProgressLinkedItem,
  parseContractExecutionParts,
  parseContractSections,
} from '@matricarmz/shared';
import { formatMoscowDate, formatMoscowDateTime, formatRuMoney } from '../utils/dateUtils.js';
import {
  buildCopyRowsStatus,
  buildDeleteConfirmMessage,
  buildDeleteRowsStatus,
  buildListContextMenuItems,
  copyRowsToClipboard,
  printRowsPreview,
  resolveMenuRows,
} from '../utils/listContextActions.js';
import { matchesQueryInRecord } from '../utils/search.js';
import { getContractProgressVisual } from '../utils/contractProgressVisual.js';
type Row = {
  id: string;
  number: string;
  internalNumber: string;
  counterparty: string;
  searchText?: string;
  dateMs: number | null;
  dueDateMs: number | null;
  contractAmount: number;
  updatedAt: number;
  daysLeft: number | null;
  progressPct: number | null;
  isFullyExecuted: boolean;
  enginesPlanned: number;
  enginesAccepted: number;
  enginesAtFactory: number;
  partsPlanned: number;
  partsCompleted: number;
  attachmentPreviews?: Array<{ id: string; name: string; mime: string | null }>;
};
type SortKey =
  | 'number'
  | 'internalNumber'
  | 'counterparty'
  | 'dateMs'
  | 'dueDateMs'
  | 'amount'
  | 'updatedAt'
  | 'progressPct'
  | 'daysLeft'
  | 'enginesPlanned'
  | 'enginesAccepted'
  | 'enginesAtFactory'
  | 'partsPlanned'
  | 'partsCompleted';
type ContractsListUiState = {
  query: string;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  showPreviews: boolean;
  contractDateFrom: string;
  contractDateTo: string;
};

function sumMoneyItems(items: Array<{ qty: number; unitPrice: number }>) {
  return items.reduce<number>((acc, row) => {
    const qty = Number(row.qty);
    const unitPrice = Number(row.unitPrice);
    if (!Number.isFinite(qty) || !Number.isFinite(unitPrice)) return acc;
    return acc + qty * unitPrice;
  }, 0);
}

function getContractAmount(sections: ContractSections): number {
  let total = 0;
  total += sumMoneyItems(sections.primary.engineBrands);
  total += sumMoneyItems(sections.primary.parts);
  for (const addon of sections.addons) {
    total += sumMoneyItems(addon.engineBrands);
    total += sumMoneyItems(addon.parts);
  }
  return total;
}

function normalizeContractNumber(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function collectProgressContractNumbers(sections: ContractSections): Set<string> {
  const out = new Set<string>();
  const primary = normalizeContractNumber(sections.primary.number);
  if (primary) out.add(primary);
  for (const addon of sections.addons) {
    const addonNumber = normalizeContractNumber(addon.number);
    if (addonNumber) out.add(addonNumber);
  }
  return out;
}

function fromInputDate(value: string): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ms = Date.parse(`${text}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

function endOfInputDate(value: string): number | null {
  const startMs = fromInputDate(value);
  if (startMs == null) return null;
  return startMs + 24 * 60 * 60 * 1000 - 1;
}

function toAttachmentPreviews(raw: unknown): Array<{ id: string; name: string; mime: string | null }> {
  if (!Array.isArray(raw)) return [];
  const previews: Array<{ id: string; name: string; mime: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.isObsolete === true) continue;
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!id || !name) continue;
    const mime = typeof entry.mime === 'string' ? entry.mime : null;
    previews.push({ id, name, mime });
    if (previews.length >= 5) break;
  }
  return previews;
}

function collectAttachmentPreviews(attrs: Record<string, unknown>): Array<{ id: string; name: string; mime: string | null }> {
  const out: Array<{ id: string; name: string; mime: string | null }> = [];
  const seen = new Set<string>();
  for (const value of Object.values(attrs)) {
    const previews = toAttachmentPreviews(value);
    for (const preview of previews) {
      if (seen.has(preview.id)) continue;
      seen.add(preview.id);
      out.push(preview);
      if (out.length >= 5) return out;
    }
  }
  return out;
}

function getProgressBarStyle(row: Row): { style: React.CSSProperties; textColor: string; hoverable: boolean } {
  const visual = getContractProgressVisual({
    progressPct: row.progressPct,
    dateMs: row.dateMs,
    dueDateMs: row.dueDateMs,
    isFullyExecuted: row.isFullyExecuted,
    isOverdue: row.daysLeft != null && row.daysLeft < 0 && !row.isFullyExecuted,
  });

  // Полностью исполнен — синий фон, белый текст
  if (row.isFullyExecuted) {
    return {
      style: { backgroundColor: 'rgba(59, 130, 246, 0.85)' },
      textColor: '#fff',
      hoverable: false,
    };
  }

  const isOverdue = row.daysLeft != null && row.daysLeft < 0;

  // Контракт ещё не начат (0% исполнения) — белый фон, чёрные или красные буквы
  if (row.progressPct == null || row.progressPct <= 0) {
    return {
      style: { backgroundColor: '#fff' },
      textColor: isOverdue ? '#dc2626' : '#111827',
      hoverable: true,
    };
  }

  // Частично исполнен — градиент: тёмная заполненная часть с белым текстом,
  // незаполненная часть — белый фон с чёрными/красными буквами.
  // Используем два слоя: gradient для фона + отдельный подход для текста.
  // Поскольку текст один на всю ячейку, используем подход:
  // если прогресс > 70% и лаг >= 30 — весь текст белый на тёмном фоне,
  // иначе — прогресс-бар с transparent gradient поверх белого фона.
  const pct = visual.execPct.toFixed(2);

  // Если большая часть уже выполнена — тёмный фон на всю ячейку
  if (visual.execPct > 70 && (visual.lag ?? 0) >= 30) {
    return {
      style: {
        background: `linear-gradient(to right, ${visual.barColor} ${pct}%, ${visual.barColor}33 ${pct}%)`,
      },
      textColor: '#fff',
      hoverable: false,
    };
  }

  // Стандартный случай: прозрачный градиент поверх белого фона
  // Текст — чёрный (или красный если просрочен) на белой части,
  // но поскольку текст один — берём цвет для незаполненной части.
  return {
    style: {
      backgroundColor: '#fff',
      background: `linear-gradient(to right, ${visual.barColor}22 ${pct}%, transparent ${pct}%)`,
    },
    textColor: isOverdue ? '#dc2626' : '#111827',
    hoverable: true,
  };
}

export function ContractsPage(props: {
  onOpen: (id: string) => Promise<void>;
  canCreate: boolean;
  canDelete: boolean;
}) {
  const { confirm } = useConfirm();
  const [rows, setRows] = useState<Row[]>([]);
  const [status, setStatus] = useState<string>('');
  const [menu, setMenu] = useState<{ x: number; y: number; targetIds: string[]; bulk: boolean } | null>(null);
  const { state: listState, patchState } = useListUiState<ContractsListUiState>('list:contracts', {
    query: '',
    sortKey: 'updatedAt' as SortKey,
    sortDir: 'desc' as const,
    showPreviews: true,
    contractDateFrom: '',
    contractDateTo: '',
  });
  const { containerRef, onScroll } = usePersistedScrollTop('list:contracts');
  const query = String(listState.query ?? '');
  const showPreviews = listState.showPreviews !== false;
  const contractDateFrom = String(listState.contractDateFrom ?? '');
  const contractDateTo = String(listState.contractDateTo ?? '');
  const [contractTypeId, setContractTypeId] = useState<string>('');
  const width = useWindowWidth();
  const { isMultiColumn, toggle: toggleColumnsMode } = useListColumnsMode();
  const twoCol = isMultiColumn && width >= 1400;

  const loadContracts = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    try {
      if (!silent) setStatus('Загрузка…');
      const types = await window.matrica.admin.entityTypes.list();
      const type = (types as any[]).find((t) => String(t.code) === 'contract') ?? null;
      if (!type?.id) {
        setContractTypeId('');
        setRows([]);
        setStatus('Справочник «Контракты» не найден (contract).');
        return;
      }
      setContractTypeId(String(type.id));
      const listRaw = await window.matrica.admin.entities.listByEntityType(String(type.id));
      if (!Array.isArray(listRaw) || listRaw.length === 0) {
        setRows([]);
        setStatus('');
        return;
      }

      const customerType = (types as any[]).find((t) => String(t.code) === 'customer') ?? null;
      const customerRows =
        customerType?.id != null ? await window.matrica.admin.entities.listByEntityType(String(customerType.id)).catch(() => []) : [];
      const customerById = new Map<string, string>();
      for (const row of customerRows) {
        if (!row?.id) continue;
        customerById.set(String(row.id), String(row.displayName ?? String(row.id).slice(0, 8)));
      }

      const engines = await window.matrica.engines.list();
      const linkedItemsByContractId = new Map<string, Array<Pick<ProgressLinkedItem, 'statusFlags'>>>();
      for (const item of Array.isArray(engines) ? engines : []) {
        const contractId = String(item.contractId ?? '');
        if (!contractId) continue;
        const bucket = linkedItemsByContractId.get(contractId) ?? [];
        bucket.push({ statusFlags: item.statusFlags ?? null });
        linkedItemsByContractId.set(contractId, bucket);
      }

      const contractIdsByNumber = new Map<string, Set<string>>();
      for (const row of listRaw as any[]) {
        const id = String(row?.id ?? '');
        if (!id) continue;
        const numberKey = normalizeContractNumber(row?.displayName ?? '');
        if (!numberKey) continue;
        const bucket = contractIdsByNumber.get(numberKey) ?? new Set<string>();
        bucket.add(id);
        contractIdsByNumber.set(numberKey, bucket);
      }

      const details = await Promise.all(
        (listRaw as any[]).map(async (row: any) => {
          try {
            const d = await window.matrica.admin.entities.get(String(row.id));
            const attrs = (d as any).attributes ?? {};
            const attachmentPreviews = collectAttachmentPreviews(attrs);
            const sections = parseContractSections(attrs);
            const executionParts = parseContractExecutionParts(attrs);
            const numberRaw = (sections.primary.number || attrs.number) ?? row.displayName ?? '';
            const internalRaw = (sections.primary.internalNumber || attrs.internal_number) ?? '';
            const dateMs = sections.primary.signedAt ?? (typeof attrs.date === 'number' ? Number(attrs.date) : null);
            const dueDateMs = effectiveContractDueAt(sections);
            const daysLeft = dueDateMs != null ? Math.ceil((dueDateMs - Date.now()) / (24 * 60 * 60 * 1000)) : null;

            const contractAmount = getContractAmount(sections);
            const counterparty = sections.primary.customerId ? customerById.get(sections.primary.customerId) ?? sections.primary.customerId : '—';
            const progressNumberKeys = collectProgressContractNumbers(sections);
            if (progressNumberKeys.size === 0) {
              const fallback = normalizeContractNumber(numberRaw);
              if (fallback) progressNumberKeys.add(fallback);
            }
            const relatedContractIds = new Set<string>([String(row.id)]);
            for (const numberKey of progressNumberKeys) {
              const byNumber = contractIdsByNumber.get(numberKey);
              if (!byNumber) continue;
              for (const relatedId of byNumber) relatedContractIds.add(relatedId);
            }
            const relatedItems: Array<Pick<ProgressLinkedItem, 'statusFlags'>> = [];
            for (const relatedId of relatedContractIds) {
              const bucket = linkedItemsByContractId.get(relatedId);
              if (bucket?.length) relatedItems.push(...bucket);
            }
            const progress = aggregateContractExecutionProgress({
              sections,
              engineItems: relatedItems,
              executionParts,
            });
            const progressPct = progress?.progressPct ?? null;
            const isFullyExecuted = Boolean(progressPct != null && progressPct >= 100);

            let enginesAtFactory = 0;
            for (const item of relatedItems) {
              const flags = item.statusFlags ?? {};
              const arrivedAtFactory =
                flags.status_storage_received === true ||
                flags.status_repair_started === true ||
                flags.status_repaired === true;
              const shippedOut =
                flags.status_customer_sent === true || flags.status_customer_accepted === true;
              if (arrivedAtFactory && !shippedOut) enginesAtFactory += 1;
            }

            return {
              id: String(row.id),
              number: numberRaw == null ? '' : String(numberRaw),
              internalNumber: internalRaw == null ? '' : String(internalRaw),
              counterparty,
              searchText: row.searchText ? String(row.searchText) : '',
              dueDateMs,
              contractAmount,
              dateMs,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft,
              progressPct,
              isFullyExecuted,
              enginesPlanned: Number(progress?.enginePlannedCount ?? 0),
              enginesAccepted: Number(progress?.engineAcceptedCount ?? 0),
              enginesAtFactory,
              partsPlanned: Number(progress?.partPlannedCount ?? 0),
              partsCompleted: Number(progress?.partCompletedCount ?? 0),
              ...(attachmentPreviews.length > 0 ? { attachmentPreviews } : {}),
            };
          } catch {
            return {
              id: String(row.id),
              number: row.displayName ? String(row.displayName) : String(row.id).slice(0, 8),
              internalNumber: '',
              counterparty: '—',
              searchText: row.searchText ? String(row.searchText) : '',
              dueDateMs: null,
              contractAmount: 0,
              dateMs: null,
              updatedAt: Number(row.updatedAt ?? 0),
              daysLeft: null,
              progressPct: null,
              isFullyExecuted: false,
              enginesPlanned: 0,
              enginesAccepted: 0,
              enginesAtFactory: 0,
              partsPlanned: 0,
              partsCompleted: 0,
            };
          }
        }),
      );
      setRows(details);
      if (!silent) setStatus('');
    } catch (e) {
      if (!silent) setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void loadContracts();
  }, [loadContracts]);

  useLiveDataRefresh(
    useCallback(async () => {
      await loadContracts({ silent: true });
    }, [loadContracts]),
    { intervalMs: 15000 },
  );

  const filtered = useMemo(() => {
    const fromMs = fromInputDate(contractDateFrom);
    const toMs = endOfInputDate(contractDateTo);
    const hasDateFilter = fromMs != null || toMs != null;
    return rows.filter((row) => {
      if (!matchesQueryInRecord(query, row)) return false;
      if (!hasDateFilter) return true;
      const contractSignedAt = row.dateMs;
      if (contractSignedAt == null) return false;
      if (fromMs != null && contractSignedAt < fromMs) return false;
      if (toMs != null && contractSignedAt > toMs) return false;
      return true;
    });
  }, [rows, query, contractDateFrom, contractDateTo]);

  const sorted = useSortedItems(
    filtered,
    listState.sortKey as SortKey,
    listState.sortDir,
    (row, key) => {
      if (key === 'number') return String(row.number ?? '').toLowerCase();
      if (key === 'internalNumber') return String(row.internalNumber ?? '').toLowerCase();
      if (key === 'counterparty') return String(row.counterparty ?? '').toLowerCase();
      if (key === 'dateMs') return Number(row.dateMs ?? 0);
      if (key === 'dueDateMs') return Number(row.dueDateMs ?? 0);
      if (key === 'amount') return Number(row.contractAmount ?? 0);
      if (key === 'progressPct') return Number(row.progressPct ?? -1);
      if (key === 'daysLeft') return Number(row.daysLeft ?? Number.MAX_SAFE_INTEGER);
      if (key === 'enginesPlanned') return Number(row.enginesPlanned ?? 0);
      if (key === 'enginesAccepted') return Number(row.enginesAccepted ?? 0);
      if (key === 'enginesAtFactory') return Number(row.enginesAtFactory ?? 0);
      if (key === 'partsPlanned') return Number(row.partsPlanned ?? 0);
      if (key === 'partsCompleted') return Number(row.partsCompleted ?? 0);
      return Number(row.updatedAt ?? 0);
    },
    (row) => row.id,
  );
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const selection = useListSelection(sorted.map((row) => row.id));

  function onSort(key: SortKey) {
    patchState(toggleSort(listState.sortKey as SortKey, listState.sortDir, key));
  }

  type ColumnDef = ColumnDescriptor & {
    sortable: boolean;
    sortKey?: SortKey;
    headerAlign?: 'left' | 'right';
    cellAlign?: 'left' | 'right';
    width?: number;
    requireShowPreviews?: boolean;
    render: (row: Row, ctx: { textColor: string }) => React.ReactNode;
  };

  const allColumns = useMemo<ColumnDef[]>(
    () => [
      {
        id: 'number',
        label: 'Номер контракта',
        sortable: true,
        sortKey: 'number',
        render: (row) => row.number || '(без номера)',
      },
      {
        id: 'internalNumber',
        label: 'Внутренний номер контракта',
        sortable: true,
        sortKey: 'internalNumber',
        render: (row) => row.internalNumber || '—',
      },
      {
        id: 'counterparty',
        label: 'Контрагент',
        sortable: true,
        sortKey: 'counterparty',
        render: (row) => row.counterparty || '—',
      },
      {
        id: 'dateMs',
        label: 'Дата заключения',
        sortable: true,
        sortKey: 'dateMs',
        render: (row) => (row.dateMs ? formatMoscowDate(row.dateMs) : '—'),
      },
      {
        id: 'dueDateMs',
        label: 'Дата исполнения',
        sortable: true,
        sortKey: 'dueDateMs',
        render: (row) => (row.dueDateMs ? formatMoscowDate(row.dueDateMs) : '—'),
      },
      {
        id: 'daysLeft',
        label: 'Дней до исполнения',
        sortable: true,
        sortKey: 'daysLeft',
        headerAlign: 'right',
        cellAlign: 'right',
        width: 100,
        render: (row) => (row.daysLeft == null ? '—' : String(row.daysLeft)),
      },
      {
        id: 'amount',
        label: 'Сумма контракта (контракт плюс ДС)',
        sortable: true,
        sortKey: 'amount',
        headerAlign: 'right',
        cellAlign: 'right',
        render: (row) => formatRuMoney(row.contractAmount),
      },
      {
        id: 'updatedAt',
        label: 'Дата обновления карточки контракта',
        sortable: true,
        sortKey: 'updatedAt',
        render: (row) => (row.updatedAt ? formatMoscowDateTime(row.updatedAt) : '—'),
      },
      {
        id: 'enginesPlanned',
        label: 'Двигателей по контракту',
        sortable: true,
        sortKey: 'enginesPlanned',
        headerAlign: 'right',
        cellAlign: 'right',
        width: 110,
        render: (row) => (row.enginesPlanned > 0 ? String(row.enginesPlanned) : '—'),
      },
      {
        id: 'enginesAccepted',
        label: 'Двигателей исполнено',
        sortable: true,
        sortKey: 'enginesAccepted',
        headerAlign: 'right',
        cellAlign: 'right',
        width: 110,
        render: (row) =>
          row.enginesPlanned > 0
            ? `${row.enginesAccepted} / ${row.enginesPlanned}`
            : row.enginesAccepted > 0
              ? String(row.enginesAccepted)
              : '—',
      },
      {
        id: 'enginesAtFactory',
        label: 'Двигателей на заводе',
        sortable: true,
        sortKey: 'enginesAtFactory',
        headerAlign: 'right',
        cellAlign: 'right',
        width: 110,
        render: (row) => (row.enginesAtFactory > 0 ? String(row.enginesAtFactory) : '—'),
      },
      {
        id: 'partsCompleted',
        label: 'Запчасти исполнено',
        sortable: true,
        sortKey: 'partsCompleted',
        headerAlign: 'right',
        cellAlign: 'right',
        width: 120,
        render: (row) =>
          row.partsPlanned > 0
            ? `${row.partsCompleted} / ${row.partsPlanned}`
            : row.partsCompleted > 0
              ? String(row.partsCompleted)
              : '—',
      },
      {
        id: 'progressPct',
        label: 'Прогресс',
        sortable: true,
        sortKey: 'progressPct',
        headerAlign: 'right',
        cellAlign: 'right',
        width: 90,
        render: (row, ctx) => (
          <span style={{ color: ctx.textColor, fontWeight: 600, fontSize: 12 }}>
            {row.progressPct != null ? `${Math.round(row.progressPct)}%` : '—'}
          </span>
        ),
      },
      {
        id: 'attachmentPreviews',
        label: 'Превью',
        sortable: false,
        headerAlign: 'right',
        cellAlign: 'right',
        width: 220,
        requireShowPreviews: true,
        render: (row) => <ListRowThumbs files={row.attachmentPreviews ?? []} />,
      },
    ],
    [],
  );

  const allColumnIds = useMemo(() => allColumns.map((c) => c.id), [allColumns]);
  const defaultHidden = useMemo(
    () => ['daysLeft', 'enginesPlanned', 'enginesAccepted', 'enginesAtFactory', 'partsCompleted'],
    [],
  );
  const columnLayout = useColumnLayout('list:contracts', allColumnIds, defaultHidden);
  const columnsById = useMemo(() => new Map(allColumns.map((c) => [c.id, c])), [allColumns]);
  const visibleColumns = useMemo(
    () =>
      columnLayout.order
        .map((id) => columnsById.get(id))
        .filter((col): col is ColumnDef => Boolean(col))
        .filter((col) => columnLayout.isVisible(col.id))
        .filter((col) => !col.requireShowPreviews || showPreviews),
    [columnLayout.order, columnLayout.hidden, columnsById, showPreviews],
  );
  const columnDescriptors = useMemo<ColumnDescriptor[]>(
    () => allColumns.map((col) => ({ id: col.id, label: col.label })),
    [allColumns],
  );

  const contextColumns = useMemo(
    () => [
      { title: 'Номер', value: (row: Row) => row.number || '(без номера)' },
      { title: 'Внутренний номер', value: (row: Row) => row.internalNumber || '—' },
      { title: 'Контрагент', value: (row: Row) => row.counterparty || '—' },
      { title: 'Дата заключения', value: (row: Row) => (row.dateMs ? formatMoscowDate(row.dateMs) : '—') },
      { title: 'Дата исполнения', value: (row: Row) => (row.dueDateMs ? formatMoscowDate(row.dueDateMs) : '—') },
      { title: 'Сумма', value: (row: Row) => formatRuMoney(row.contractAmount) },
    ],
    [],
  );

  function printRows(items: Row[]) {
    printRowsPreview({
      title: items.length > 1 ? `Выделенные контракты (${items.length})` : `Контракт: ${items[0]?.number || '(без номера)'}`,
      sectionTitle: 'Список контрактов',
      rows: items,
      columns: contextColumns,
    });
  }

  async function copyRows(items: Row[]) {
    await copyRowsToClipboard(items, contextColumns);
    setStatus(buildCopyRowsStatus(items.length));
  }

  async function deleteRows(ids: string[]) {
    if (!props.canDelete || ids.length === 0) return;
    const message = buildDeleteConfirmMessage({
      selectedCount: ids.length,
      selectedManyLabel: 'выделенные контракты',
      singleLabel: 'контракт',
    });
    const ok = await confirm({ detail: `${message}\n\nКонтракты будут помечены удалёнными (soft delete).` });
    if (!ok) return;
    let failed = 0;
    for (const id of ids) {
      const r = await window.matrica.admin.entities.softDelete(id);
      if (!r.ok) failed += 1;
    }
    setStatus(
      buildDeleteRowsStatus({
        failedCount: failed,
        deletedCount: ids.length,
        deletedManyLabel: 'контрактов',
      }),
    );
    selection.clearSelection();
    await loadContracts();
  }

  const headerCellBorder = { borderBottom: '1px solid #e5e7eb' } as const;
  const headerThBase: React.CSSProperties = {
    ...headerCellBorder,
    padding: 8,
    fontWeight: 700,
    fontSize: 14,
    color: '#111827',
  };

  function renderTableHeader() {
    return (
      <thead>
        <tr style={{ background: '#f9fafb', color: '#111827' }}>
          {visibleColumns.map((col) => {
            const align = col.headerAlign ?? 'left';
            const baseStyle: React.CSSProperties = {
              ...headerThBase,
              textAlign: align,
              cursor: col.sortable ? 'pointer' : 'default',
              ...(col.width ? { width: col.width } : {}),
            };
            const arrow = col.sortable && col.sortKey ? sortArrow(listState.sortKey as SortKey, listState.sortDir, col.sortKey) : '';
            return (
              <th
                key={col.id}
                style={baseStyle}
                onClick={col.sortable && col.sortKey ? () => onSort(col.sortKey as SortKey) : undefined}
              >
                {col.label}
                {arrow ? ` ${arrow}` : ''}
              </th>
            );
          })}
        </tr>
      </thead>
    );
  }

  function renderContractRow(row: Row) {
    const rowVisual = getProgressBarStyle(row);
    const textColor = rowVisual.textColor;
    return (
      <tr
        key={row.id}
        data-list-selected={selection.isSelected(row.id) ? 'true' : undefined}
        style={{
          borderBottom: '1px solid #f3f4f6',
          cursor: 'pointer',
          ...(rowVisual.style && rowVisual.style),
        }}
        onContextMenu={(e) => {
          const result = selection.onRowContextMenu(e, row.id);
          if (!result.openMenu) return;
          setMenu({ x: e.clientX, y: e.clientY, targetIds: result.targetIds, bulk: result.bulk });
        }}
        onClick={() => {
          selection.onRowPrimaryAction(row.id);
          void props.onOpen(row.id);
        }}
        onMouseEnter={(e) => {
          if (rowVisual.hoverable) e.currentTarget.style.backgroundColor = '#f9fafb';
        }}
        onMouseLeave={(e) => {
          if (rowVisual.hoverable) e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        {visibleColumns.map((col) => {
          const align = col.cellAlign ?? 'left';
          const cellStyle: React.CSSProperties = {
            padding: '8px 10px',
            color: textColor,
            textAlign: align,
          };
          return (
            <td key={col.id} style={cellStyle}>
              {col.render(row, { textColor })}
            </td>
          );
        })}
      </tr>
    );
  }

  function renderTable(items: Row[]) {
    return (
      <div style={{ border: '1px solid #e5e7eb', overflow: 'hidden' }}>
        <table className="list-table">
          {renderTableHeader()}
          <tbody>
            {items.map((row) => renderContractRow(row))}
            {items.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, visibleColumns.length)} style={{ padding: 10, color: '#6b7280' }}>
                  Ничего не найдено
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: '0 0 auto' }}>
        {props.canCreate && (
          <Button
            onClick={async () => {
              if (!contractTypeId) return;
              try {
                setStatus('Создание контракта…');
                const r = await window.matrica.admin.entities.create(contractTypeId);
                if (!r?.ok || !r?.id) {
                  setStatus(`Ошибка: ${(r as any)?.error ?? 'unknown'}`);
                  return;
                }
                setStatus('');
                await loadContracts();
                await props.onOpen(String(r.id));
              } catch (e) {
                setStatus(`Ошибка: ${String(e)}`);
              }
            }}
          >
            Создать контракт
          </Button>
        )}
        <div style={{ flex: 1 }}>
          <Input value={query} onChange={(e) => patchState({ query: e.target.value })} placeholder="Поиск по всем данным контракта…" />
        </div>
        <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          По дате заключения:
        </span>
        <div style={{ width: 170 }}>
          <Input
            type="date"
            value={contractDateFrom}
            onChange={(e) => patchState({ contractDateFrom: e.target.value })}
            title="Дата заключения контракта: с"
          />
        </div>
        <div style={{ width: 170 }}>
          <Input
            type="date"
            value={contractDateTo}
            onChange={(e) => patchState({ contractDateTo: e.target.value })}
            title="Дата заключения контракта: по"
          />
        </div>
        <Button
          variant="ghost"
          onClick={() => patchState({ contractDateFrom: '', contractDateTo: '' })}
          disabled={!contractDateFrom && !contractDateTo}
        >
          Сбросить даты
        </Button>
        <Button variant="ghost" onClick={() => void loadContracts()}>
          Обновить
        </Button>
        <Button variant="ghost" onClick={() => patchState({ showPreviews: !showPreviews })}>
          {showPreviews ? 'Отключить превью' : 'Включить превью'}
        </Button>
        <ColumnSettingsButton
          columns={columnDescriptors}
          order={columnLayout.order}
          isVisible={columnLayout.isVisible}
          onToggleVisible={columnLayout.setVisible}
          onMove={columnLayout.moveColumn}
          onReset={columnLayout.resetToDefault}
        />
        <ListColumnsToggle isMultiColumn={isMultiColumn} onToggle={toggleColumnsMode} />
      </div>

      {status && <div style={{ marginTop: 10, color: status.startsWith('Ошибка') ? '#b91c1c' : '#6b7280' }}>{status}</div>}

      <div ref={containerRef} onScroll={onScroll} style={{ marginTop: 8, flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        <TwoColumnList items={sorted} enabled={twoCol} renderColumn={(items) => renderTable(items)} />
      </div>
      {menu ? (
        <ListContextMenu
          x={menu.x}
          y={menu.y}
          items={buildListContextMenuItems({
            rows: resolveMenuRows(menu.targetIds, rowById),
            bulk: menu.bulk,
            canDelete: props.canDelete,
            getId: (row) => row.id,
            onSelect: selection.toggleSelect,
            onPrint: printRows,
            onCopy: copyRows,
            onDelete: deleteRows,
            onClearSelection: selection.clearSelection,
          })}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
