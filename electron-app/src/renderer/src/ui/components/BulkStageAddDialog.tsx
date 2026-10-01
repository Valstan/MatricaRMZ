import React, { useEffect, useMemo, useState } from 'react';

import { isBulkStageCandidate, isEngineAtPlant, repairStageRank } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SearchSelect } from './SearchSelect.js';

type StageTemplate = { code: string; name: string };
type EngineOption = { id: string; label: string; atPlant: boolean };
type StageMarks = { lastStageCode: string | null; lastStageAt: number | null; hasScrapBranch: boolean };

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
 * Массовое добавление этапа на несколько двигателей (PR-D).
 * Оператор выбирает тип этапа, дату, цех и несколько двигателей —
 * этап создаётся у каждого выбранного двигателя.
 *
 * Двигатели ищутся по номеру (подстрока, как в остальных списках). Когда выбран
 * этап, показываются ТОЛЬКО кандидаты — двигатели, которые стоят на заводе сейчас
 * на предыдущем этапе (владелец 01.10.2026). Уехавшие, стоящие выше и утиль скрыты.
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
  const [query, setQuery] = useState('');
  const [selectedEngineIds, setSelectedEngineIds] = useState<string[]>([]);
  const [stageCode, setStageCode] = useState('');
  const [date, setDate] = useState(toInputDate(Date.now()));
  const [workshopId, setWorkshopId] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await window.matrica.engines.list();
        const opts = rows.map((e) => ({
          id: String(e.id),
          label: e.engineNumber || `Без номера (${String(e.id).slice(0, 8)})`,
          atPlant: isEngineAtPlant({ arrivalDate: e.arrivalDate ?? null, shippingDate: e.shippingDate ?? null }),
        }));
        setEngines(opts);
        try {
          const r = await window.matrica.workSheets.stages.lastMarks(opts.map((o) => o.id));
          if (r.ok) setMarks(r.marks);
        } catch {
          // Метки последних этапов не загрузились — приоритет «с предыдущего этапа» не построится
        }
      } catch {
        // Список двигателей не загрузился — оператор может ввести ID вручную
      }
      try {
        const t = await window.matrica.workSheets.stages.templates.list();
        if (t.ok) {
          const ranks: Record<string, number> = {};
          for (const row of t.templates) ranks[String(row.code).trim().toLowerCase()] = Number(row.sortOrder) || 0;
          setRankByCode(ranks);
        }
      } catch {
        // Ранги линейки не загрузились — откатимся на статичную линейку shared
      }
    })();
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

  // При выбранном этапе показывают ТОЛЬКО кандидатов (владелец 01.10.2026): двигатели,
  // которые стоят на заводе сейчас на предыдущем этапе. Уехавшие, стоящие выше и утиль
  // скрываются совсем — иначе за обкатку список из сотен штук, где живых горсть.
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

  const toggleEngine = (id: string) => {
    setSelectedEngineIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

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

  const renderEngineRow = (e: EngineOption) => (
    <label key={e.id} data-bulk-stage-engine={e.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
      <input type="checkbox" checked={selectedEngineIds.includes(e.id)} onChange={() => toggleEngine(e.id)} />
      <span>{e.label}</span>
    </label>
  );

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
            <span className="ui-muted" style={{ fontSize: 12 }}>Этап</span>
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
              <span className="ui-muted" style={{ fontSize: 12 }}>Дата</span>
              <Input type="date" value={date} disabled={busy} data-bulk-stage-date onChange={(e) => setDate(e.target.value)} />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span className="ui-muted" style={{ fontSize: 12 }}>Цех (необязательно)</span>
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
            <span className="ui-muted" style={{ fontSize: 12 }}>Примечание (необязательно)</span>
            <Input value={note} disabled={busy} placeholder="Примечание к этапу" onChange={(e) => setNote(e.target.value)} />
          </label>

          <div style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>Двигатели ({selectedEngineIds.length} выбрано)</span>
            <Input
              value={query}
              disabled={busy}
              placeholder="Поиск по номеру двигателя…"
              data-bulk-stage-search
              onChange={(e) => setQuery(e.target.value)}
            />
            <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
              {engines.length === 0 ? (
                <div className="ui-muted" style={{ fontSize: 12 }}>Список двигателей не загрузился</div>
              ) : filtered.length === 0 ? (
                <div className="ui-muted" style={{ fontSize: 12 }}>По запросу ничего не найдено</div>
              ) : candidates ? (
                candidates.length === 0 ? (
                  <div className="ui-muted" style={{ fontSize: 12 }}>
                    На предыдущих этапах никого нет — все либо стоят выше, либо уже уехали с завода
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 4 }} data-bulk-stage-priority>
                    <div className="ui-muted" style={{ fontSize: 12, fontWeight: 700 }}>
                      На заводе на предыдущем этапе ({candidates.length})
                    </div>
                    {candidates.map(renderEngineRow)}
                  </div>
                )
              ) : (
                <div style={{ display: 'grid', gap: 4 }}>{filtered.map(renderEngineRow)}</div>
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
