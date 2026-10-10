import React, { useEffect, useMemo, useState } from 'react';

import { isTransferableStageCode, repairStageRank } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { emojiAttrs } from '../utils/labelEmoji.js';

type EngineOption = { id: string; label: string };
type MovingStage = { id: string; code: string; name: string; at: number | null };

/**
 * Перенос этапов при перебивке номера (программа владельца, п.4, 10.10.2026):
 * срез «от укладки вала и выше» переезжает с этого двигателя на выбранный.
 * Источник гасится, обе истории получают записи о переносе. Номера, платежи
 * и привязки не трогаются.
 */
export function TransferStagesDialog(props: {
  sourceEngineId: string;
  sourceLabel: string;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [engines, setEngines] = useState<EngineOption[]>([]);
  const [query, setQuery] = useState('');
  const [targetId, setTargetId] = useState('');
  const [moving, setMoving] = useState<MovingStage[] | null>(null);
  const [rankByCode, setRankByCode] = useState<Record<string, number>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const rows = await window.matrica.engines.list();
        setEngines(
          rows
            .filter((e) => String(e.id) !== props.sourceEngineId)
            .map((e) => ({ id: String(e.id), label: e.engineNumber || `Без номера (${String(e.id).slice(0, 8)})` })),
        );
      } catch {
        // Список не загрузился — диалог честно скажет, а не умрёт молча (ниже).
      }
      try {
        const st = await window.matrica.workSheets.stages.list(props.sourceEngineId);
        if (st.ok) {
          setMoving(
            st.rows
              .filter((r) => isTransferableStageCode(r.code))
              .map((r) => ({ id: r.id, code: r.code, name: r.name, at: r.at })),
          );
        }
      } catch {
        // Строки источника не прочитались — перенос вслепую не предлагаем.
      }
      try {
        const t = await window.matrica.workSheets.stages.templates.list();
        if (t.ok) {
          const ranks: Record<string, number> = {};
          for (const row of t.templates) ranks[String(row.code).trim().toLowerCase()] = Number(row.sortOrder) || 0;
          setRankByCode(ranks);
        }
      } catch {
        // Ранги линейки не загрузились — порядок по статике shared.
      }
    })();
  }, [props.sourceEngineId]);

  const rankOf = (code: string): number => {
    const c = String(code ?? '').trim().toLowerCase();
    const fromTemplates = rankByCode[c];
    if (typeof fromTemplates === 'number') return fromTemplates;
    return repairStageRank(c);
  };
  const sortedMoving = useMemo(
    () => (moving ?? []).map((m) => m).sort((a, b) => rankOf(a.code) - rankOf(b.code)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rankOf зависит от rankByCode; массив собираем при его смене
    [moving, rankByCode],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return engines;
    return engines.filter((e) => e.label.toLowerCase().includes(q));
  }, [engines, query]);
  const targetLabel = engines.find((e) => e.id === targetId)?.label ?? '';

  async function apply() {
    if (busy || !targetId || !moving || moving.length === 0) return;
    setBusy(true);
    setStatus('Переношу…');
    try {
      const r = await window.matrica.workSheets.stages.transfer({
        sourceEngineId: props.sourceEngineId,
        targetEngineId: targetId,
        sourceLabel: props.sourceLabel,
        targetLabel,
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStatus(`Готово: перенесено этапов: ${r.moved.length}`);
      await props.onDone();
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-transfer-dialog style={{ display: 'grid', gap: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
      <div style={{ fontWeight: 700 }} {...emojiAttrs('Перенос этапов')}>
        Перенести этапы с {props.sourceLabel}
      </div>
      <div className="ui-muted" style={{ fontSize: 12 }}>
        {moving === null
          ? 'Читаю этапы источника…'
          : moving.length === 0
            ? 'Переносить нечего: этапов от укладки вала и выше нет'
            : `Переедет (${moving.length}): ${sortedMoving.map((m) => m.name).join(', ')}. Источник погасится, обе истории получат записи о переносе.`}
      </div>
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="ui-muted" style={{ fontSize: 12 }} {...emojiAttrs('Двигатель-цель')}>Двигатель-цель</span>
        <Input
          value={query}
          disabled={busy}
          placeholder="Поиск по номеру двигателя…"
          data-transfer-search
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}>
        {engines.length === 0 ? (
          <div className="ui-muted" style={{ fontSize: 12 }}>Список двигателей не загрузился</div>
        ) : filtered.length === 0 ? (
          <div className="ui-muted" style={{ fontSize: 12 }}>По запросу ничего не найдено</div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {filtered.slice(0, 50).map((e) => (
              <Button
                key={e.id}
                variant={e.id === targetId ? 'primary' : 'ghost'}
                disabled={busy}
                data-transfer-target={e.id}
                onClick={() => setTargetId(e.id)}
              >
                {e.label}
              </Button>
            ))}
          </div>
        )}
      </div>
      {status ? <div className="ui-muted" data-transfer-status>{status}</div> : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => void apply()} disabled={busy || !targetId || !moving || moving.length === 0} data-transfer-confirm>
          {busy ? 'Переношу…' : 'Перенести этапы'}
        </Button>
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
          Закрыть
        </Button>
      </div>
    </div>
  );
}
