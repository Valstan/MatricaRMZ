import React, { useEffect, useState } from 'react';

import type { ScrapStageGate } from '@matricarmz/shared';

import { Button } from './Button.js';

/**
 * ОКНО ГЕЙТА УТИЛЯ (промт КАРМАНА #170).
 *
 * Ситуация: оператор начал этап ремонта у утильного двигателя. Программа этап не завела
 * и показала это окно: какая деталь утильная и в каком двигателе.
 *
 * Два действия — ровно два (требование владельца):
 *  · «Деталь отремонтирована» — снять утиль (след в истории ремонта с причиной, деталь в
 *    ремонтный фонд); после этого вызывающий повторяет запись этапа;
 *  · «Отмена (не была отремонтирована)» — этап не создаётся, следов записи не остаётся.
 *
 * Причина снятия спрашивается ТУТ ЖЕ (пункт 10 промта): без неё след снятия неполон, и по
 * истории нельзя собрать отчёт «почему двигатель снят с утиля».
 */
export type ScrapStageBlockInfo = ScrapStageGate & {
  /** id двигателя — по нему повторяется запись этапа после снятия утиля. */
  engineId: string;
};

export function ScrapStageBlockDialog(props: {
  info: ScrapStageBlockInfo | null;
  /** Закрыть без действий (кнопка «Отмена»). */
  onCancel: () => void;
  /** Деталь отремонтирована: утиль снят, этап можно заводить. */
  onResolved: (info: ScrapStageBlockInfo, warning?: string) => void;
  /** Причины снятия утиля (ремонт / закупка / иное). */
  reasons?: readonly string[];
}) {
  const [reason, setReason] = useState('Ремонт');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (props.info) {
      setReason(props.reasons?.[0] ?? 'Ремонт');
      setError('');
      setBusy(false);
    }
  }, [props.info, props.reasons]);

  if (!props.info) return null;
  const info = props.info;
  const reasons = props.reasons?.length ? props.reasons : ['Ремонт', 'Закупка', 'Иное'];

  async function applyResolve() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await window.matrica.engineScrap.resolve({
        engineId: info.engineId,
        partId: info.partId,
        partLabel: info.partLabel,
        outcome: 'repaired',
        reason,
      });
      if (!res.ok) {
        setError(res.error ?? 'Не удалось снять утиль');
        return;
      }
      // Предупреждение (деталь не вернулась в ремонтный фонд) уходит вызывающему:
      // окно сейчас закроется, и предупреждение пропало бы вместе с ним.
      props.onResolved(info, res.warning);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Двигатель утильный — ремонт не начинаем"
      data-scrap-stage-block
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => {
        if (!busy) props.onCancel();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--panel-bg, #fff)', color: 'var(--text, #111)', borderRadius: 12, padding: 18, minWidth: 380, maxWidth: 520, display: 'grid', gap: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.25)' }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>Двигатель утильный — ремонт не начинаем</div>
        <div style={{ fontSize: 13 }}>
          Утильная деталь: <b>{info.partLabel || 'не названа в акте дефектовки'}</b>
          {info.engineNumber ? <> · двигатель <b>{info.engineNumber}</b></> : null}
        </div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          Этап «{info.stageName}» не заведён: пока деталь не отремонтирована, ремонт не начинаем.
        </div>
        <label style={{ display: 'grid', gap: 4, fontSize: 13 }}>
          <span>Причина снятия утиля</span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            data-scrap-stage-reason
            style={{ padding: 6, borderRadius: 8, border: '1px solid var(--input-border, #ccc)', background: 'var(--input-bg, #fff)' }}
          >
            {reasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        {error ? <div style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }} data-scrap-stage-error>{error}</div> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button
            variant="outline"
            data-scrap-stage-cancel
            disabled={busy}
            onClick={() => props.onCancel()}
          >
            Отмена (не была отремонтирована)
          </Button>
          <Button variant="primary" data-scrap-stage-apply disabled={busy} onClick={() => void applyResolve()}>
            Деталь отремонтирована
          </Button>
        </div>
      </div>
    </div>
  );
}
