import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import {
  globalSearchKindLabel,
  groupRowsBySearchField,
  searchFieldOptionsForRows,
  type GlobalSearchHit,
  type GlobalSearchKind,
  type SearchFieldMatch,
  type SearchFieldOption,
} from '@matricarmz/shared';

import { SearchModeToggle, searchModeOf } from './SearchModeToggle.js';
import { SEARCH_MODE_HINT } from './SearchModeHint.js';
import { SEARCH_FIELD_NARROWED_NOTE, SearchFieldPicker } from './SearchFieldPicker.js';
import { useSearchMode } from '../hooks/useSearchMode.js';
import { type SearchFieldChoice } from '../hooks/useSearchField.js';
import { EngineQrScanButton } from './EngineQrScanButton.js';
import { useGlobalSearchScope } from '../context/globalSearchScope.js';
import { L2_SOURCES, loadAllL2, pickL2Label, type L2Row } from '../services/globalSearchSources.js';
import { KIND_PATH, UI_SEARCH_ENTRIES, type UiSearchEntry } from '../services/uiSearchRegistry.js';
import { filterPreparedRecords, prepareRecordSearch, type PreparedRecordSearch } from '../utils/search.js';

type LevelMode = 'auto' | 'page' | 'directories' | 'server';

const LEVELS: Array<{ mode: LevelMode; label: string }> = [
  { mode: 'auto', label: 'Авто' },
  { mode: 'page', label: 'Эта страница' },
  { mode: 'directories', label: 'Справочники' },
  { mode: 'server', label: 'Сервер' },
];

// Group display order; kinds not listed fall to the end in encounter order.
const KIND_ORDER: GlobalSearchKind[] = [
  'nomenclature',
  'engine',
  'work_sheet',
  'engine_brand',
  'contract',
  'counterparty',
  'employee',
  'work_order',
  'request',
  'service',
  'product',
  'tool',
  'tool_property',
  'stock_document',
];

// Deep card-content search (tier L2.5) runs over EAV-backed entity kinds only —
// nomenclature/stock documents are erp_* tables without attribute_values.
const DEEP_KINDS: GlobalSearchKind[] = [
  'engine',
  'employee',
  'request',
  'work_order',
  'tool',
  'tool_property',
  'engine_brand',
  'counterparty',
  'contract',
  'service',
  'product',
];

const PER_GROUP = 6;
const SERVER_DEBOUNCE_MS = 250;
const DEEP_DEBOUNCE_MS = 300;
const SERVER_MIN_CHARS = 2;

// Unified result row: an entity hit (opens the card) or a UI surface (opens the tab).
type RowItem = {
  key: string;
  label: string;
  code?: string;
  path?: string;
  note?: string;
  hit?: GlobalSearchHit;
  tabId?: string;
};

// Группа выдачи: по виду сущности (как было) и — внутри — подгруппы по месту совпадения
// («по номеру двигателя — 3»). Подгруппы появляются только там, где поле известно;
// серверный и карточный слои поля не знают — там вид остаётся как был.
type PaletteSubgroup = { key: string; title: string; rows: RowItem[] };
type PaletteGroup = { key: string; title: string; rows: RowItem[]; subgroups?: PaletteSubgroup[] };

export function GlobalSearchOverlay(props: {
  open: boolean;
  onClose: () => void;
  onSelect: (hit: GlobalSearchHit) => void;
  onNavigateTab?: (tabId: string) => void;
}) {
  const { open, onClose, onSelect, onNavigateTab } = props;
  const scope = useGlobalSearchScope();

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<LevelMode>('auto');
  // Режим совпадения — не путать с уровнем поиска `mode`: точное или ещё и похожее.
  const { similar: searchSimilar, toggle: toggleSearchMode } = useSearchMode({ query });
  const searchMode = searchModeOf(searchSimilar);
  // Выбор поля — «где искать» (промт КАРМАНА #138): сужает выдачу до одного поля.
  // Это НЕ уровень поиска: уровень отвечает «откуда смотреть», поле — «по какому полю».
  const [fieldChoice, setFieldChoice] = useState<SearchFieldChoice | null>(null);
  const narrowed = fieldChoice != null;
  const [l2Loaded, setL2Loaded] = useState<Partial<Record<GlobalSearchKind, L2Row[]>>>({});
  const [serverHits, setServerHits] = useState<GlobalSearchHit[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [deepIds, setDeepIds] = useState<Set<string>>(new Set());
  // Двигатели, найденные по НАБИТОМУ на детали номеру (№ на детали) из списка деталей карточки.
  const [stampHits, setStampHits] = useState<GlobalSearchHit[]>([]);
  const [sheetHits, setSheetHits] = useState<GlobalSearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  // Reset + focus on open; load L2 directories once per open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setMode('auto');
    setFieldChoice(null);
    setActiveIndex(0);
    setServerHits([]);
    setDeepIds(new Set());
    setStampHits([]);
    setSheetHits([]);
    const focus = window.setTimeout(() => inputRef.current?.focus(), 0);
    let cancelled = false;
    void (async () => {
      const loaded = await loadAllL2();
      if (!cancelled) setL2Loaded(loaded);
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(focus);
    };
  }, [open]);

  // Debounced, abortable L3 server search.
  useEffect(() => {
    if (!open || !(mode === 'auto' || mode === 'server') || narrowed) {
      setServerHits([]);
      setServerLoading(false);
      return;
    }
    const q = query.trim();
    if (q.length < SERVER_MIN_CHARS) {
      setServerHits([]);
      setServerLoading(false);
      return;
    }
    let cancelled = false;
    setServerLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.matrica.search.global({ q, limit: 12 });
        if (!cancelled) setServerHits(Array.isArray(res?.hits) ? res.hits : []);
      } catch {
        if (!cancelled) setServerHits([]);
      } finally {
        if (!cancelled) setServerLoading(false);
      }
    }, SERVER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, mode, query, narrowed]);

  // Debounced L2.5 deep search inside card content (live EAV values in local SQLite)
  // across the already-loaded directory rows — «ищет и в карточках, и в базе».
  useEffect(() => {
    if (!open || !(mode === 'auto' || mode === 'directories') || narrowed) {
      setDeepIds(new Set());
      return;
    }
    const q = query.trim();
    if (q.length < SERVER_MIN_CHARS) {
      setDeepIds(new Set());
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const entityIds: string[] = [];
        for (const kind of DEEP_KINDS) {
          for (const r of l2Loaded[kind] ?? []) {
            const id = String((r as L2Row).id ?? '');
            if (id) entityIds.push(id);
          }
        }
        if (entityIds.length === 0) return;
        const res = await window.matrica.search.cardContent({ entityIds, q });
        if (!cancelled) setDeepIds(res.ok ? new Set(res.ids) : new Set());
      } catch {
        if (!cancelled) setDeepIds(new Set());
      }
    }, DEEP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, mode, query, l2Loaded, narrowed]);

  // Двигатели по «№ на детали» (stamped_number из operations.metaJson — не EAV, поэтому
  // deep card-content его не видит; отдельный main-поиск по локальному SQLite).
  useEffect(() => {
    if (!open || mode === 'page' || narrowed) {
      setStampHits([]);
      return;
    }
    const q = query.trim();
    if (q.length < SERVER_MIN_CHARS) {
      setStampHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.matrica.search.enginesByStampedNumber({ q, limit: 12 });
        if (!cancelled) setStampHits(res?.ok ? res.hits : []);
      } catch {
        if (!cancelled) setStampHits([]);
      }
    }, DEEP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, mode, query, narrowed]);

  // Этапы работ: строки живут в локальной реплике `operations`, а не в EAV и не на сервере,
  // поэтому ни deep card-content, ни серверный /search их не видят — свой main-поиск.
  useEffect(() => {
    if (!open || mode === 'page' || narrowed) {
      setSheetHits([]);
      return;
    }
    const q = query.trim();
    if (q.length < SERVER_MIN_CHARS) {
      setSheetHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await window.matrica.workSheets.rows.search({ q, limit: 12 });
        if (!cancelled) setSheetHits(res?.ok ? res.hits : []);
      } catch {
        // Нет права или раздела — группы просто не будет, как у серверного поиска.
        if (!cancelled) setSheetHits([]);
      }
    }, DEEP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, mode, query, narrowed]);

  const l2Prepared = useMemo(() => {
    const out: Partial<Record<GlobalSearchKind, PreparedRecordSearch<L2Row>>> = {};
    for (const src of L2_SOURCES) {
      const rows = l2Loaded[src.kind] ?? [];
      out[src.kind] = prepareRecordSearch(
        rows,
        (r) => String((r as L2Row).id ?? ''),
        (r) => pickL2Label(r as L2Row),
        { kind: src.kind },
      );
    }
    return out;
  }, [l2Loaded]);

  const l1Prepared = useMemo(() => {
    if (!scope) return null;
    return prepareRecordSearch(scope.rows, scope.getId, scope.getLabel, { kind: scope.kind });
  }, [scope]);

  const uiPrepared = useMemo(
    () =>
      prepareRecordSearch(
        UI_SEARCH_ENTRIES,
        (e) => `${e.tabId}|${e.label}`,
        (e) => `${e.label} ${(e.synonyms ?? []).join(' ')}`,
      ),
    [],
  );

  /**
   * Поля, которые предлагает кнопка «где искать» (промт КАРМАНА #138).
   *
   * Поиск сам знает, где он находится: текущая страница (L1-скоуп) и справочники (L2).
   * Из общего реестра берём только те поля, что в строках этой сущности ЕСТЬ: строка
   * справочника и строка списка — разные формы, и поле, которого в строке нет, обещало
   * бы пустую выдачу («совпадений нет» — это другое, об этом сказано в меню).
   */
  const fieldOptions = useMemo<SearchFieldOption[]>(() => {
    const out: SearchFieldOption[] = [];
    const seen = new Set<string>();
    const push = (kind: GlobalSearchKind, rows: unknown[]) => {
      if (seen.has(kind)) return;
      seen.add(kind);
      out.push(...searchFieldOptionsForRows(kind, rows));
    };
    if (scope?.kind) push(scope.kind, scope.rows);
    for (const src of L2_SOURCES) push(src.kind, l2Loaded[src.kind] ?? []);
    return out;
  }, [scope, l2Loaded]);

  const { hits, hitFieldMatches } = useMemo<{ hits: GlobalSearchHit[]; hitFieldMatches: Map<string, SearchFieldMatch[]> }>(() => {
    const q = query.trim();
    const fieldMatches = new Map<string, SearchFieldMatch[]>();
    if (!q) return { hits: [], hitFieldMatches: fieldMatches };
    const showL1 = (mode === 'auto' || mode === 'page') && !!scope && !!l1Prepared;
    const showL2 = mode === 'auto' || mode === 'directories';
    const showL3 = mode === 'auto' || mode === 'server';
    const out: GlobalSearchHit[] = [];
    // Выбранное поле: сужаем до сущности этого поля и до совпадений ПО НЕМУ.
    const chosenKind = fieldChoice?.kind ?? null;
    const chosenField = fieldChoice?.fieldId ?? null;
    const narrowOpts = chosenField ? { fieldId: chosenField } : undefined;

    if (showL1 && scope && l1Prepared) {
      // Чужую сущность при выбранном поле показывать нельзя: поле ей не принадлежит.
      if (!chosenKind || scope.kind === chosenKind) {
        const tier = filterPreparedRecords(l1Prepared, q, searchMode, narrowOpts);
        for (const r of tier.records.slice(0, PER_GROUP)) {
          const id = scope.getId(r);
          if (!id) continue;
          const fields = tier.fieldMatches.get(id);
          if (fields?.length) fieldMatches.set(`${scope.kind}|${id}`, fields);
          out.push({ kind: scope.kind, id, label: scope.getLabel(r) || id });
        }
      }
    }
    if (showL2) {
      for (const src of L2_SOURCES) {
        if (chosenKind && src.kind !== chosenKind) continue;
        const prep = l2Prepared[src.kind];
        if (!prep) continue;
        const tier = filterPreparedRecords(prep, q, searchMode, narrowOpts);
        for (const r of tier.records.slice(0, PER_GROUP)) {
          const id = String(r.id ?? '');
          if (!id) continue;
          const fields = tier.fieldMatches.get(id);
          if (fields?.length) fieldMatches.set(`${src.kind}|${id}`, fields);
          const code = src.getCode?.(r) ?? '';
          out.push({ kind: src.kind, id, label: pickL2Label(r) || id, ...(code ? { code } : {}) });
        }
      }
    }
    // Серверный слой и этапы поля не знают — при выбранном поле они выключены.
    if (showL3 && !chosenKind) out.push(...serverHits);
    if (mode !== 'page' && !chosenKind) out.push(...sheetHits);

    const seen = new Set<string>();
    return {
      hits: out.filter((h) => {
        const key = `${h.kind}|${h.id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      hitFieldMatches: fieldMatches,
    };
  }, [query, mode, searchMode, scope, l1Prepared, l2Prepared, serverHits, sheetHits, fieldChoice]);

  // Deep-only hits: ids matched inside card content that tier-1/2/3 did not surface.
  // При выбранном поле глубокий слой выключен: поле совпадения он не называет.
  const deepHits = useMemo<GlobalSearchHit[]>(() => {
    if (deepIds.size === 0 || fieldChoice) return [];
    const already = new Set(hits.map((h) => h.id));
    const out: GlobalSearchHit[] = [];
    for (const kind of DEEP_KINDS) {
      for (const r of l2Loaded[kind] ?? []) {
        const id = String((r as L2Row).id ?? '');
        if (!id || !deepIds.has(id) || already.has(id)) continue;
        out.push({ kind, id, label: pickL2Label(r as L2Row) || id });
        if (out.length >= PER_GROUP * 2) return out;
      }
    }
    return out;
  }, [deepIds, hits, l2Loaded, fieldChoice]);

  const uiRows = useMemo<UiSearchEntry[]>(() => {
    const q = query.trim();
    // Кнопки и разделы — не поле: при выбранном поле они в выдачу не попадают
    // (владелец: «остальные вхождения он показывать не будет»).
    if (!q || !(mode === 'auto' || mode === 'page') || fieldChoice) return [];
    return filterPreparedRecords(uiPrepared, q, searchMode).records.slice(0, PER_GROUP);
  }, [query, mode, searchMode, uiPrepared, fieldChoice]);

  // Двигатели по «№ на детали»: dedup против уже показанных двигателей; метку берём из L2
  // (актуальный номер двигателя), номер детали — как code справа.
  const stampRows = useMemo<RowItem[]>(() => {
    if (stampHits.length === 0 || fieldChoice) return [];
    const already = new Set<string>([...hits, ...deepHits].map((h) => `${h.kind}|${h.id}`));
    const engineById = new Map<string, L2Row>(
      (l2Loaded.engine ?? []).map((r) => [String((r as L2Row).id ?? ''), r as L2Row]),
    );
    const out: RowItem[] = [];
    for (const h of stampHits) {
      if (already.has(`engine|${h.id}`)) continue;
      const l2 = engineById.get(h.id);
      const label = (l2 ? pickL2Label(l2) : '') || h.label || h.id;
      out.push({
        key: `stamp|${h.id}`,
        label,
        ...(h.code ? { code: h.code } : {}),
        path: KIND_PATH.engine,
        hit: { ...h, label },
      });
      if (out.length >= PER_GROUP * 2) break;
    }
    return out;
  }, [stampHits, hits, deepHits, l2Loaded, fieldChoice]);

  const groups = useMemo<PaletteGroup[]>(() => {
    const ordered: PaletteGroup[] = [];

    if (uiRows.length) {
      ordered.push({
        key: '__ui',
        title: 'Интерфейс',
        rows: uiRows.map((e) => ({
          key: `ui|${e.tabId}|${e.label}`,
          label: e.label,
          path: e.path,
          note: e.surface,
          tabId: e.tabId,
        })),
      });
    }

    const byKind = new Map<GlobalSearchKind, GlobalSearchHit[]>();
    for (const h of hits) {
      const arr = byKind.get(h.kind) ?? [];
      if (arr.length < PER_GROUP) arr.push(h);
      byKind.set(h.kind, arr);
    }
    const toRows = (arr: GlobalSearchHit[]): RowItem[] =>
      arr.map((h) => ({
        key: `${h.kind}|${h.id}`,
        label: h.label,
        ...(h.code ? { code: h.code } : {}),
        path: KIND_PATH[h.kind],
        hit: h,
      }));
    // Группа вида сущности + подгруппы по месту совпадения («по номеру двигателя — 3»).
    // Подгруппы есть только там, где поле известно; серверный и карточный слои поля
    // не знают — там вид остаётся плоским, как был.
    const kindGroup = (kind: GlobalSearchKind, arr: GlobalSearchHit[]): PaletteGroup => {
      const rows = toRows(arr);
      const buckets = groupRowsBySearchField(
        kind,
        rows,
        (r) => (r.hit ? `${r.hit.kind}|${r.hit.id}` : r.key),
        hitFieldMatches,
      );
      if (!buckets.some((b) => b.fieldId !== null)) return { key: kind, title: groupTitle(kind, scope), rows };
      const subgroups: PaletteSubgroup[] = buckets.map((b) => ({
        key: `${kind}|${b.fieldId ?? 'other'}`,
        title: `${b.title} — ${b.rows.length}`,
        rows: b.rows,
      }));
      return { key: kind, title: groupTitle(kind, scope), rows: [], subgroups };
    };
    const used = new Set<GlobalSearchKind>();
    for (const kind of KIND_ORDER) {
      const arr = byKind.get(kind);
      if (arr && arr.length) {
        ordered.push(kindGroup(kind, arr));
        used.add(kind);
      }
    }
    for (const [kind, arr] of byKind) {
      if (!used.has(kind) && arr.length) ordered.push(kindGroup(kind, arr));
    }

    if (stampRows.length) {
      ordered.push({ key: '__stamp', title: 'Двигатели · по № на детали', rows: stampRows });
    }

    if (deepHits.length) {
      ordered.push({
        key: '__deep',
        title: 'Найдено в содержимом карточек',
        rows: deepHits.map((h) => ({
          key: `deep|${h.kind}|${h.id}`,
          label: h.label,
          path: KIND_PATH[h.kind],
          note: globalSearchKindLabel(h.kind).toLowerCase(),
          hit: h,
        })),
      });
    }
    return ordered;
  }, [uiRows, hits, deepHits, stampRows, scope, hitFieldMatches]);

  const flat = useMemo(
    () => groups.flatMap((g) => (g.subgroups ? g.subgroups.flatMap((s) => s.rows) : g.rows)),
    [groups],
  );

  useEffect(() => {
    setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const pick = (row: RowItem) => {
    if (row.hit) {
      onSelect(row.hit);
      return;
    }
    if (row.tabId && onNavigateTab) {
      onClose();
      onNavigateTab(row.tabId);
    }
  };

  /** Строка выдачи. Порядок обхода обязан совпадать с `flat` — по нему идёт стрелками. */
  const renderRow = (row: RowItem) => {
    const idx = flatCursor;
    flatCursor += 1;
    const isActive = idx === activeIndex;
    return (
      <button
        key={row.key}
        ref={isActive ? activeRowRef : null}
        data-testid="global-search-row"
        data-kind={row.hit ? row.hit.kind : 'ui'}
        type="button"
        onMouseEnter={() => setActiveIndex(idx)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(row)}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          gap: 2,
          width: '100%',
          textAlign: 'left',
          padding: '7px 16px',
          border: 'none',
          cursor: 'pointer',
          background: isActive ? 'var(--surface2)' : 'transparent',
          color: 'var(--text)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ flex: '1 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {row.label}
          </span>
          {row.code ? <span style={{ flex: '0 0 auto', fontSize: 12, color: 'var(--muted)' }}>{row.code}</span> : null}
          {row.note ? <span style={{ flex: '0 0 auto', fontSize: 11, color: 'var(--muted)' }}>{row.note}</span> : null}
        </span>
        {row.path ? (
          <span
            style={{
              fontSize: 11,
              color: 'var(--muted)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.path}
          </span>
        ) : null}
      </button>
    );
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (flat.length === 0 ? 0 : Math.min(i + 1, flat.length - 1)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = flat[activeIndex];
      if (row) pick(row);
    }
  };

  const q = query.trim();
  let flatCursor = 0;

  const node = (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.45)',
        zIndex: 6000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '9vh',
      }}
    >
      <div
        data-testid="global-search-overlay"
        onKeyDown={onKeyDown}
        style={{
          width: 'min(720px, 92vw)',
          maxHeight: '74vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          boxShadow: 'var(--chat-menu-shadow, 0 24px 60px rgba(15,23,42,0.35))',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <input
                ref={inputRef}
                data-testid="global-search-input"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                placeholder="Поиск по всему: детали, двигатели, наряды, кнопки и разделы…"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '10px 12px',
                  fontSize: 16,
                  color: 'var(--text)',
                  background: 'var(--input-bg, var(--surface2))',
                  border: '1px solid var(--input-border, var(--border))',
                  borderRadius: 8,
                  outline: 'none',
                }}
              />
            </div>
            {/* Кнопка «где искать» (промт КАРМАНА #138): поиск сам знает, в какой сущности
                он стоит, и по кнопке можно сузить выдачу до одного поля. */}
            {fieldOptions.length > 0 ? (
              <SearchFieldPicker options={fieldOptions} choice={fieldChoice} onSelect={setFieldChoice} />
            ) : null}
            <EngineQrScanButton
              onEngineNumber={(n) => {
                setQuery(n);
                setActiveIndex(0);
              }}
            />
          </div>
          {/* Выдача сужена — сказано прямо: часть вхождений не показывается, и без этой
              строки это читается как поломка поиска. */}
          {fieldChoice ? (
            <div data-search-field-note style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
              {SEARCH_FIELD_NARROWED_NOTE}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
            {LEVELS.map((lvl) => {
              const activeLevel = lvl.mode === mode;
              return (
                <button
                  key={lvl.mode}
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => setMode(lvl.mode)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    color: activeLevel ? '#fff' : 'var(--muted)',
                    background: activeLevel ? 'var(--accent, #2563eb)' : 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                  }}
                >
                  {lvl.label}
                </button>
              );
            })}
            {/* Режим совпадения отодвинут вправо, чтобы не читался как ещё один уровень поиска. */}
            <span style={{ marginLeft: 'auto' }}>
              <SearchModeToggle similar={searchSimilar} onToggle={toggleSearchMode} />
            </span>
          </div>
        </div>

        <div style={{ overflowY: 'auto', padding: '6px 0' }}>
          {q.length === 0 && (
            <div style={{ padding: '18px 16px', color: 'var(--muted)', fontSize: 14 }}>Начните вводить запрос…</div>
          )}
          {q.length > 0 && flat.length === 0 && (
            <div style={{ padding: '18px 16px', color: 'var(--muted)', fontSize: 14 }}>
              {serverLoading
                ? 'Поиск…'
                : searchSimilar
                  ? 'Ничего не найдено'
                  : `Ничего не найдено. ${SEARCH_MODE_HINT}`}
            </div>
          )}
          {groups.map((group) => (
            <div key={group.key}>
              <div
                style={{
                  padding: '8px 16px 4px',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                  color: 'var(--muted)',
                }}
              >
                {group.title}
              </div>
              {group.subgroups
                ? group.subgroups.map((sub) => (
                    <div key={sub.key}>
                      <div
                        data-testid="global-search-field-group"
                        style={{
                          padding: '3px 16px 2px 26px',
                          fontSize: 11,
                          color: 'var(--muted)',
                        }}
                      >
                        {sub.title}
                      </div>
                      {sub.rows.map((row) => renderRow(row))}
                    </div>
                  ))
                : group.rows.map((row) => renderRow(row))}
            </div>
          ))}
        </div>

        <div
          style={{
            padding: '8px 14px',
            borderTop: '1px solid var(--border)',
            fontSize: 12,
            color: 'var(--muted)',
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>↑↓ выбрать · Enter открыть · Esc закрыть</span>
          {serverLoading ? <span>сервер…</span> : null}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

function groupTitle(kind: GlobalSearchKind, scope: { kind: GlobalSearchKind; title: string } | null): string {
  if (scope && scope.kind === kind && scope.title) return `${globalSearchKindLabel(kind)} · ${scope.title}`;
  return globalSearchKindLabel(kind);
}
