import React, { useEffect, useMemo, useState } from 'react';
import type { ReportPresetDefinition, ReportPresetId, ReportPresetHistoryEntry } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { SectionCard } from '../components/SectionCard.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';

export function ReportsCatalogPage(props: { userId: string; onOpenPreset: (presetId: ReportPresetId) => void }) {
  const [presets, setPresets] = useState<ReportPresetDefinition[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<ReportPresetId[]>([]);
  const [history, setHistory] = useState<ReportPresetHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  const presetById = useMemo(() => {
    const map = new Map<ReportPresetId, ReportPresetDefinition>();
    for (const preset of presets) map.set(preset.id, preset);
    return map;
  }, [presets]);
  const favoritePresets = useMemo(
    () => favoriteIds.map((id) => presetById.get(id)).filter((preset): preset is ReportPresetDefinition => Boolean(preset)),
    [favoriteIds, presetById],
  );
  const sortedHistory = useMemo(
    () => [...history].sort((a, b) => Number(b.generatedAt ?? 0) - Number(a.generatedAt ?? 0)),
    [history],
  );

  async function loadAll() {
    setBusy(true);
    setStatus('Загрузка отчётов...');
    try {
      const [presetsResult, favoritesResult, historyResult] = await Promise.all([
        window.matrica.reports.presetList(),
        window.matrica.reports.favoritesGet({ userId: props.userId }),
        window.matrica.reports.historyList({ userId: props.userId, limit: 20 }),
      ]);
      if (!presetsResult?.ok) {
        setStatus(`Ошибка: ${presetsResult?.error ?? 'unknown'}`);
        return;
      }
      setPresets(presetsResult.presets);
      if (favoritesResult?.ok) setFavoriteIds(favoritesResult.ids);
      if (historyResult?.ok) setHistory(historyResult.entries);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, [props.userId]);

  async function toggleFavorite(presetId: ReportPresetId) {
    const next = favoriteIds.includes(presetId) ? favoriteIds.filter((id) => id !== presetId) : [...favoriteIds, presetId];
    setFavoriteIds(next);
    const result = await window.matrica.reports.favoritesSet({
      userId: props.userId,
      ids: next,
    });
    if (!result?.ok) {
      setStatus(`Ошибка: ${result?.error ?? 'unknown'}`);
      setFavoriteIds(favoriteIds);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <SectionCard title="Избранное">
        {favoritePresets.length === 0 ? (
          <div className="ui-muted">Шаблонов пока нет. Добавьте их звездой в разделе «Шаблоны отчётов».</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: 8 }}>
            {favoritePresets.map((preset) => (
              <Button
                key={`favorite-${preset.id}`}
                variant="primary"
                onClick={() => props.onOpenPreset(preset.id)}
                style={{ textAlign: 'left', display: 'grid', gap: 2, justifyItems: 'start' }}
              >
                <span style={{ fontWeight: 800 }}>★ {preset.title}</span>
                <span style={{ fontWeight: 500, fontSize: 12, whiteSpace: 'normal' }}>{preset.description}</span>
              </Button>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Шаблоны отчётов"
        actions={
          <Button variant="ghost" onClick={() => void loadAll()} disabled={busy}>
            Обновить
          </Button>
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="ui-muted">Выберите шаблон, откройте его на отдельной странице и сформируйте нужный отчёт.</div>
          {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 8 }}>
            {presets.map((preset) => {
              const isFavorite = favoriteIds.includes(preset.id);
              return (
                <div
                  key={preset.id}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 8,
                    display: 'grid',
                    gap: 4,
                    background: 'var(--surface-1, #fff)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                    <Button
                      variant="ghost"
                      onClick={() => props.onOpenPreset(preset.id)}
                      style={{ textAlign: 'left', display: 'grid', gap: 2, justifyItems: 'start', flex: 1, minWidth: 0 }}
                    >
                      <span style={{ fontWeight: 800 }}>{preset.title}</span>
                      <span style={{ fontWeight: 500, fontSize: 12, whiteSpace: 'normal' }}>{preset.description}</span>
                    </Button>
                    <button
                      type="button"
                      onClick={() => void toggleFavorite(preset.id)}
                      title={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        width: 34,
                        minWidth: 34,
                        height: 34,
                        background: isFavorite ? 'rgba(245, 158, 11, 0.12)' : 'transparent',
                        color: isFavorite ? '#b45309' : 'var(--muted)',
                        cursor: 'pointer',
                        fontSize: 18,
                        lineHeight: 1,
                      }}
                      aria-label={isFavorite ? 'Убрать из избранного' : 'Добавить в избранное'}
                    >
                      {isFavorite ? '★' : '☆'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Последние созданные отчёты">
        {sortedHistory.length === 0 ? (
          <div className="ui-muted">Пока нет сформированных отчётов.</div>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {sortedHistory.map((entry) => {
              const title = presetById.get(entry.presetId)?.title ?? entry.title;
              return (
                <button
                  key={`${entry.presetId}-${entry.generatedAt}`}
                  type="button"
                  onClick={() => props.onOpenPreset(entry.presetId)}
                  style={{
                    textAlign: 'left',
                    background: 'transparent',
                    border: '1px solid transparent',
                    borderRadius: 8,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    color: 'var(--primary, #1d4ed8)',
                    textDecoration: 'underline',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <span>{title}</span>
                  <span style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 12 }}>
                    {formatMoscowDateTime(entry.generatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
