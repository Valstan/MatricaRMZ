import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isBulkStageCandidate, isEngineAtPlant, repairStageRank } from '@matricarmz/shared';
import { useVirtualizer } from '@tanstack/react-virtual';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { EngineQrScanButton } from './EngineQrScanButton.js';
import { SearchSelect } from './SearchSelect.js';
import { emojiAttrs } from '../utils/labelEmoji.js';

type StageTemplate = { code: string; name: string };
type EngineOption = { id: string; label: string; atPlant: boolean };
type StageMarks = { lastStageCode: string | null; lastStageAt: number | null; hasScrapBranch: boolean };

/** Строка списка двигателей: разделитель или сам двигатель. */
type ListRow =
  | { kind: 'header'; key: string; text: string; section?: 'priority' | 'rest' }
  | { kind: 'engine'; key: string; engine: EngineOption };

type EngineCatalog = {
  engines: EngineOption[];
  marks: Record<string, StageMarks>;
  ranks: Record<string, number>;
  loadedAt: number;
};

/**
 * Каталог двигателей и метки последних этапов — дорогая часть двери «Добавить этап»:
 * `engine:list` и `lastMarks` читают весь парк синхронно в main (журнал признаёт это
 * сам — `slow engine:list` пишется от 1.5 с), и повторять её на каждое открытие диалога
 * незачем. Кэш живёт на модуле: диалог размонтируется при закрытии, а состояние — нет.
 * Своя запись этапа меняет метки, поэтому после неё кэш сбрасывается.
 */
const CATALOG_TTL_MS = 30_000;
let catalogCache: EngineCatalog | null = null;

export function invalidateEngineCatalogCache(): void {
  catalogCache = null;
}

async function loadEngineCatalog(): Promise<EngineCatalog> {
  if (catalogCache && Date.now() - catalogCache.loadedAt < CATALOG_TTL_MS) return catalogCache;
  const rows = await window.matrica.engines.list();
  const engines: EngineOption[] = rows.map((e) => ({
    id: String(e.id),
    label: e.engineNumber || `Без номера (${String(e.id).slice(0, 8)})`,
    atPlant: isEngineAtPlant({ arrivalDate: e.arrivalDate ?? null, shippingDate: e.shippingDate ?? null }),
  }));
  let marks: Record<string, StageMarks> = {};
  try {
    const r = await window.matrica.workSheets.stages.lastMarks(engines.map((o) => o.id));
    if (r.ok) marks = r.marks;
  } catch {
    // Метки последних этапов не загрузились — приоритет «с предыдущего этапа» не построится
  }
  const ranks: Record<string, number> = {};
  try {
    const t = await window.matrica.workSheets.stages.templates.list();
    if (t.ok) {
      for (const row of t.templates) ranks[String(row.code).trim().toLowerCase()] = Number(row.sortOrder) || 0;
    }
  } catch {
    // Ранги линейки не загрузились — откатимся на статичную линейку shared
  }
  const catalog: EngineCatalog = { engines, marks, ranks, loadedAt: Date.now() };
  catalogCache = catalog;
  return catalog;
}

function toInputDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromInputDate(v: string): number | null {
  const ms = v ? Date.parse(`${v}T12:00:00`) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Строка-галочка двигателя отдельным компонентом под `React.memo`: без этого клик
 * по одному двигателю перерисовывал весь длинный список.
 */
const EngineCheckboxRow = React.memo(function EngineCheckboxRow(props: {
  engine: EngineOption;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label
      data-bulk-stage-engine={props.engine.id}
      style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}
    >
      <input type="checkbox" checked={props.selected} onChange={() => props.onToggle(props.engine.id)} />
      <span>{props.engine.label}</span>
    </label>
  );
});

/**
 * Массовое добавление этапа на несколько двигателей (PR-D).
 * Оператор выбирает тип этапа, дату, цех и несколько двигателей —
 * этап создаётся у каждого выбранного двигателя.
 *
 * Двигатели ищутся по номеру (подстрока, как в остальных списках). Когда выбран
 * этап, кандидаты — двигатели, которые стоят на заводе сейчас на предыдущем
 * этапе (владелец 01.10.2026) — идут первыми; ниже — все остальные из поиска,
 * без отсечений: нужно для внесения этапов задним числом, вперемешку (PR-3).
 *
 * Список рисуется окном (`useVirtualizer`), а не целиком: «остальные» — это весь
 * каталог парка, и после PR-3 диалог отдавал в DOM тысячи галочек. На каждой
 * перерисовке (клик по галочке, статус сохранения, обновление списка за диалогом)
 * браузер пересобирал их заново — на слабой машине это и читалось как «программа
 * зависла» (владелец 19.10.2026, вис на 3–4-м добавленном этапе).
 */
export function BulkStageAddDialog(props: {
  templates: StageTemplate[];
  workshops: Array<{ id: string; label: string }>;
  onClose: () => void;
  onAdded: () => Promise<void> | void;
}) {
  const [engines, setEngines] = useState<EngineOption[]>([]);
  const [marks, setMarks] = useState<Record<string, StageMarks>>({});
  const [rankByCode, setRankByCode] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selectedEngineIds, setSelectedEngineIds] = useState<string[]>([]);
  const [stageCode, setStageCode] = useState('');
  const [date, setDate] = useState(toInputDate(Date.now()));
  const [workshopId, setWorkshopId] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const catalog = await loadEngineCatalog();
        if (!alive) return;
        setEngines(catalog.engines);
        setMarks(catalog.marks);
        setRankByCode(catalog.ranks);
      } catch {
        // Список двигателей не загрузился — оператор может ввести ID вручную
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const rankOf = (code: string): number => {
    const c = String(code ?? '').trim().toLowerCase();
    const fromTemplates = rankByCode[c];
    if (typeof fromTemplates === 'number') return fromTemplates;
    return repairStageRank(c);
  };
  const selectedRank = stageCode ? rankOf(stageCode) : null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return engines;
    return engines.filter((e) => e.label.toLowerCase().includes(q));
  }, [engines, query]);

  // При выбранном этапе кандидаты (владелец 01.10.2026): двигатели, которые стоят
  // на заводе сейчас на предыдущем этапе. Остальные не скрываются, а идут ниже
  // отдельным списком — иначе этапы задним числом, вперемешку, внести нельзя (PR-3).
  // Без выбранного этапа — все со строкой поиска, как раньше.
  const candidates = useMemo(() => {
    if (selectedRank === null || selectedRank <= 0) return null;
    const rankOfCode = (code: string): number => {
      const c = String(code ?? '').trim().toLowerCase();
      const r = rankByCode[c];
      return typeof r === 'number' ? r : repairStageRank(c);
    };
    const out: EngineOption[] = [];
    for (const e of filtered) {
      const m = marks[e.id];
      const lastRank = !m || m.lastStageCode === null ? null : rankOfCode(m.lastStageCode);
      if (
        isBulkStageCandidate({
          atPlant: e.atPlant,
          hasScrapBranch: m?.hasScrapBranch === true,
          lastRank,
          selectedRank,
        })
      ) {
        out.push(e);
      }
    }
    return out;
  }, [filtered, selectedRank, marks, rankByCode]);

  // Остальные из поиска — всё, что не попало в кандидаты. Пустой поиск = весь каталог.
  const rest = useMemo(() => {
    if (!candidates) return null;
    const ids = new Set(candidates.map((e) => e.id));
    return filtered.filter((e) => !ids.has(e.id));
  }, [candidates, filtered]);

  // Плоский список строк окна: разделители живут в том же потоке, что двигатели, —
  // так «кандидаты сверху, остальные ниже» сохраняется без двух прокруток.
  const listRows = useMemo<ListRow[]>(() => {
    const rows: ListRow[] = [];
    if (!candidates || !rest) {
      for (const e of filtered) rows.push({ kind: 'engine', key: e.id, engine: e });
      return rows;
    }
    rows.push({
      kind: 'header',
      key: '__candidates',
      section: 'priority',
      text:
        candidates.length === 0
          ? 'На предыдущих этапах никого нет — все либо стоят выше, либо уже уехали с завода'
          : `На заводе на предыдущем этапе (${candidates.length})`,
    });
    for (const e of candidates) rows.push({ kind: 'engine', key: e.id, engine: e });
    rows.push({
      kind: 'header',
      key: '__rest',
      section: 'rest',
      text: `Остальные (${rest.length}) — в т.ч. для внесения задним числом`,
    });
    for (const e of rest) rows.push({ kind: 'engine', key: e.id, engine: e });
    return rows;
  }, [filtered, candidates, rest]);

  const toggleEngine = useCallback((id: string) => {
    setSelectedEngineIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);
  const selectedSet = useMemo(() => new Set(selectedEngineIds), [selectedEngineIds]);

  const virtualizer = useVirtualizer({
    count: listRows.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 24,
    overscan: 10,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const paddingTop = virtualItems.length > 0 ? virtualItems[0]!.start : 0;
  const paddingBottom =
    virtualItems.length > 0 ? totalSize - virtualItems[virtualItems.length - 1]!.end : 0;

  // Поиск и смена этапа перекраивают список — оставляем оператора у его начала,
  // а не на высоте прежней прокрутки (иначе окно показывает середину нового списка).
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [query, stageCode]);

  const save = async () => {
    if (!stageCode) return setStatus('Выберите этап');
    if (selectedEngineIds.length === 0) return setStatus('Выберите хотя бы один двигатель');
    const atMs = fromInputDate(date);
    if (atMs === null) return setStatus('Укажите дату');

    setBusy(true);
    setStatus('');
    try {
      let ok = 0;
      let fail = 0;
      for (const engineId of selectedEngineIds) {
        const r = await window.matrica.workSheets.stages.save({
          id: crypto.randomUUID(),
          engineId,
          code: stageCode,
          atMs,
          ...(workshopId ? { workshopId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        if (r.ok) ok++;
        else fail++;
      }
      setStatus(`Сохранено: ${ok}${fail > 0 ? `, ошибок: ${fail}` : ''}`);
      // Записанный этап сдвинул метки «последнего этапа» — кэш каталога устарел.
      if (ok > 0) invalidateEngineCatalogCache();
      await props.onAdded();
      if (fail === 0) {
        setSelectedEngineIds([]);
        setNote('');
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Массовое добавление этапа"
      data-bulk-stage-add
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(700px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gap: 12 }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>Добавить этап на несколько двигателей</div>

        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }} {...emojiAttrs('Этап')}>Этап</span>
            <select
              value={stageCode}
              disabled={busy}
              data-bulk-stage-code
              onChange={(e) => setStageCode(e.target.value)}
              style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
            >
              <option value="">Выберите этап…</option>
              {props.templates.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="ui-muted" style={{ fontSize: 12 }} {...emojiAttrs('Дата')}>Дата</span>
              <Input type="date" value={date} disabled={busy} data-bulk-stage-date onChange={(e) => setDate(e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="ui-muted" style={{ fontSize: 12 }} {...emojiAttrs('Цех (необязательно)')}>Цех (необязательно)</span>
              <SearchSelect
                value={workshopId}
                options={props.workshops}
                placeholder="—"
                showAllWhenEmpty
                onChange={(next) => setWorkshopId(String(next ?? ''))}
              />
            </label>
          </div>

          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }} {...emojiAttrs('Примечание (необязательно)')}>Примечание (необязательно)</span>
            <Input value={note} disabled={busy} placeholder="Примечание к этапу" onChange={(e) => setNote(e.target.value)} />
          </label>

          <div style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }} {...emojiAttrs('Двигатели')}>Двигатели ({selectedEngineIds.length} выбрано)</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Input
                  value={query}
                  disabled={busy}
                  placeholder="Поиск по номеру двигателя…"
                  data-bulk-stage-search
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <EngineQrScanButton onEngineNumber={(n) => setQuery(n)} />
            </div>
            <div
              ref={listRef}
              data-bulk-stage-list
              style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: '6px 8px' }}
            >
              {loading ? (
                <div className="ui-muted" style={{ fontSize: 12 }}>Загрузка списка двигателей…</div>
              ) : engines.length === 0 ? (
                <div className="ui-muted" style={{ fontSize: 12 }}>Список двигателей не загрузился</div>
              ) : filtered.length === 0 ? (
                <div className="ui-muted" style={{ fontSize: 12 }}>По запросу ничего не найдено</div>
              ) : (
                <div style={{ position: 'relative' }}>
                  {paddingTop > 0 ? <div style={{ height: paddingTop }} /> : null}
                  {virtualItems.map((vi) => {
                    const row = listRows[vi.index];
                    if (!row) return null;
                    return (
                      <div
                        key={row.key}
                        data-index={vi.index}
                        ref={virtualizer.measureElement}
                        style={{ paddingTop: 2, paddingBottom: 2 }}
                      >
                        {row.kind === 'header' ? (
                          <div
                            className="ui-muted"
                            style={{ fontSize: 12, fontWeight: 700 }}
                            {...(row.section === 'priority'
                              ? { 'data-bulk-stage-priority': '' }
                              : row.section === 'rest'
                                ? { 'data-bulk-stage-rest': '' }
                                : {})}
                          >
                            {row.text}
                          </div>
                        ) : (
                          <EngineCheckboxRow
                            engine={row.engine}
                            selected={selectedSet.has(row.engine.id)}
                            onToggle={toggleEngine}
                          />
                        )}
                      </div>
                    );
                  })}
                  {paddingBottom > 0 ? <div style={{ height: paddingBottom }} /> : null}
                </div>
              )}
            </div>
          </div>
        </div>

        {status ? <div className="ui-muted">{status}</div> : null}

        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => void save()} disabled={busy || !stageCode || selectedEngineIds.length === 0} data-bulk-stage-save>
            {busy ? 'Сохранение…' : `Сохранить этап для выбранных${selectedEngineIds.length > 0 ? ` (${selectedEngineIds.length})` : ''}`}
          </Button>
          <div style={{ flex: 1 }} />
          <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
            Закрыть
          </Button>
        </div>
      </div>
    </div>
  );
}
