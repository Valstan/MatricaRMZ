import React, { useCallback, useEffect, useState } from 'react';

import { Button } from './Button.js';

/**
 * Признак «эта деталь уводит двигатель в утиль» — глобальная метка детали
 * (решение владельца 02.11.2026).
 *
 * Если деталь помечена и она ушла в утиль по акту дефектовки, двигатель
 * считается утильным везде: розовая полоса в списке, фильтр «утиль/не утиль»,
 * отчёты, группа «Утиль» на заводе. Перед включением показываем сухой прогон:
 * сколько двигателей это затронет (в том числе по уже заведённым актам).
 */
export function ScrapCriterionPartToggle(props: { partId: string; canEdit: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [impact, setImpact] = useState<{ engines: number; lines: number } | null>(null);

  const load = useCallback(async () => {
    if (!props.partId) return;
    try {
      const result = await window.matrica.scrapCriterion.get({ partId: props.partId });
      if (!result?.ok) {
        setStatus(String(result?.error ?? 'не удалось прочитать признак'));
        return;
      }
      setEnabled(result.enabled);
      setImpact({ engines: result.engines, lines: result.lines });
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.partId]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (next: boolean) => {
      if (!props.canEdit || busy) return;
      setBusy(true);
      setStatus('');
      try {
        // Сухой прогон перед включением: показываем, сколько двигателей затронет.
        if (next) {
          const preview = await window.matrica.scrapCriterion.impact({ partIds: [props.partId] });
          if (!preview?.ok) {
            setStatus(String(preview?.error ?? 'не удалось посчитать влияние'));
            setBusy(false);
            return;
          }
          setImpact({ engines: preview.engines, lines: preview.lines });
        }
        const result = await window.matrica.scrapCriterion.set({ partId: props.partId, enabled: next });
        if (!result?.ok) {
          setStatus(String(result?.error ?? 'не удалось сохранить признак'));
          setBusy(false);
          return;
        }
        setEnabled(next);
        setImpact({ engines: result.engines, lines: result.lines });
        setStatus(next ? 'Признак поставлен' : 'Признак снят');
      } catch (e) {
        setStatus(`Ошибка: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [busy, props.canEdit, props.partId],
  );

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!props.canEdit || busy}
          onChange={(e) => {
            void apply(e.target.checked);
          }}
        />
        <span>Деталь уводит двигатель в утиль</span>
      </label>
      <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
        Если эта деталь ушла в утиль по акту дефектовки, двигатель помечается утильным везде: список, фильтр,
        отчёты, этапы на заводе.
      </div>
      {impact ? (
        <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
          Затронуто двигателей по заведённым актам: <b>{impact.engines}</b>
          {impact.lines > 0 ? ` (строк в списках деталей: ${impact.lines})` : ''}
        </div>
      ) : null}
      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)', fontSize: 13 }}>{status}</div>
      ) : null}
      {props.canEdit ? (
        <div>
          <Button
            variant="outline"
            tone="neutral"
            size="sm"
            disabled={busy}
            onClick={() => {
              void apply(!enabled);
            }}
          >
            {enabled ? 'Снять признак' : 'Поставить признак'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
