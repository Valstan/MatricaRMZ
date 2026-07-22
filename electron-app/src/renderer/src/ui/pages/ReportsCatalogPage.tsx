import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ReportPresetDefinition,
  ReportPresetId,
  ReportPresetHistoryEntry,
  ReportThemeId,
} from '@matricarmz/shared';
import { REPORT_PRESET_THEMES, REPORT_THEMES } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';

function presetThemes(presetId: ReportPresetId): readonly ReportThemeId[] {
  return REPORT_PRESET_THEMES[presetId] ?? [];
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('ru');
}

function presetMatchesQuery(preset: ReportPresetDefinition, query: string): boolean {
  return normalize(`${preset.title} ${preset.description}`).includes(query);
}

export function ReportsCatalogPage(props: {
  userId: string;
  onOpenPreset: (presetId: ReportPresetId) => void;
  themeId: ReportThemeId | null;
  onThemeChange: (themeId: ReportThemeId | null) => void;
  pinnedShortcuts?: string[];
  onAddShortcut?: (id: string) => void;
  onRemoveShortcut?: (id: string) => void;
}) {
  const [presets, setPresets] = useState<ReportPresetDefinition[]>([]);
  const [favoriteIds, setFavoriteIds] = useState<ReportPresetId[]>([]);
  const [history, setHistory] = useState<ReportPresetHistoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; presetId: ReportPresetId } | null>(null);
  const [query, setQuery] = useState('');
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  const activeTheme = useMemo(
    () => REPORT_THEMES.find((theme) => theme.id === props.themeId) ?? null,
    [props.themeId],
  );
  const themeCounts = useMemo(() => {
    const counts = new Map<ReportThemeId, number>(REPORT_THEMES.map((theme) => [theme.id, 0]));
    for (const preset of presets) {
      for (const themeId of presetThemes(preset.id)) counts.set(themeId, (counts.get(themeId) ?? 0) + 1);
    }
    return counts;
  }, [presets]);
  const normalizedQuery = normalize(query);
  const searching = normalizedQuery.length > 0;
  /** Поиск идёт по всем темам: один отчёт живёт в нескольких темах, искать его по темам — мучение. */
  const visiblePresets = useMemo(() => {
    if (searching) return presets.filter((preset) => presetMatchesQuery(preset, normalizedQuery));
    if (!props.themeId) return [];
    return presets.filter((preset) => presetThemes(preset.id).includes(props.themeId as ReportThemeId));
  }, [presets, props.themeId, normalizedQuery, searching]);

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

  useEffect(() => {
    if (!ctxMenu) return;
    const handler = (e: MouseEvent) => {
      if (ctxMenuRef.current?.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    window.addEventListener('mousedown', handler, true);
    window.addEventListener('keydown', keyHandler, true);
    return () => {
      window.removeEventListener('mousedown', handler, true);
      window.removeEventListener('keydown', keyHandler, true);
    };
  }, [ctxMenu]);

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

  function openCardContextMenu(e: React.MouseEvent, presetId: ReportPresetId) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, presetId });
  }

  function backToThemes() {
    setQuery('');
    props.onThemeChange(null);
  }

  // Escape ловим ТОЛЬКО внутри каталога: в оболочке v2 страница остаётся смонтированной в колонке
  // списков, пока оператор работает в других колонках, и window-слушатель молча сбрасывал бы тему
  // на каждый чужой Escape (закрытие лайтбокса, модалки карточки).
  function onCatalogKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Escape' || ctxMenu) return;
    if (!props.themeId && !searching) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
    backToThemes();
  }

  function renderPresetCard(preset: ReportPresetDefinition) {
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
        onContextMenu={(e) => openCardContextMenu(e, preset.id)}
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
  }

  return (
    <div style={{ display: 'grid', gap: 10 }} onKeyDown={onCatalogKeyDown}>
      {!activeTheme && !searching && (
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
                  onContextMenu={(e) => openCardContextMenu(e, preset.id)}
                  style={{ textAlign: 'left', display: 'grid', gap: 2, justifyItems: 'start' }}
                >
                  <span style={{ fontWeight: 800 }}>{preset.title}</span>
                  <span style={{ fontWeight: 500, fontSize: 12, whiteSpace: 'normal' }}>{preset.description}</span>
                </Button>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      <SectionCard
        title={activeTheme && !searching ? `Шаблоны отчётов — ${activeTheme.title}` : 'Шаблоны отчётов'}
        actions={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {activeTheme || searching ? (
              <Button variant="ghost" onClick={backToThemes}>
                ← Все темы
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => void loadAll()} disabled={busy}>
              Обновить
            </Button>
          </div>
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Поиск по названию и описанию — по всем темам"
            aria-label="Поиск шаблона отчёта"
          />
          {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div> : null}

          {searching ? (
            <>
              <div className="ui-muted">
                {visiblePresets.length === 0
                  ? 'Ничего не найдено — попробуйте другое слово.'
                  : `Найдено ${visiblePresets.length} — поиск идёт по всем темам.`}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 8 }}>
                {visiblePresets.map(renderPresetCard)}
              </div>
            </>
          ) : activeTheme ? (
            <>
              <div className="ui-muted">{activeTheme.description}. Правый клик — добавить в Мой круг.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: 8 }}>
                {visiblePresets.map(renderPresetCard)}
              </div>
            </>
          ) : (
            <>
              <div className="ui-muted">Выберите тему — внутри лежат шаблоны по ней. Отчёт, который задевает две темы, лежит в обеих.</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))', gap: 8 }}>
                {REPORT_THEMES.map((theme) => {
                  const count = themeCounts.get(theme.id) ?? 0;
                  return (
                    <Button
                      key={theme.id}
                      variant="ghost"
                      size="lg"
                      onClick={() => {
                        setQuery('');
                        props.onThemeChange(theme.id);
                      }}
                      disabled={count === 0}
                      style={{
                        textAlign: 'left',
                        display: 'grid',
                        gridTemplateColumns: 'auto 1fr',
                        columnGap: 12,
                        rowGap: 2,
                        alignItems: 'center',
                        justifyItems: 'start',
                        minHeight: 'var(--ui-report-theme-tile-height, 96px)',
                        padding: 'var(--ui-report-theme-tile-padding, 12px 16px)',
                      }}
                    >
                      <span aria-hidden="true" style={{ gridRow: '1 / span 3', fontSize: 'calc(var(--ui-body-size, 14px) * 1.8)' }}>
                        {theme.icon}
                      </span>
                      <span style={{ fontWeight: 800, fontSize: 'calc(var(--ui-body-size, 14px) * 1.5)', lineHeight: 1.15 }}>
                        {theme.title}
                      </span>
                      <span style={{ fontWeight: 500, fontSize: 'calc(var(--ui-muted-size, 12px) * 1)', whiteSpace: 'normal', opacity: 0.85 }}>
                        {theme.description}
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 'calc(var(--ui-muted-size, 12px) * 0.92)', opacity: 0.65 }}>
                        {count} {count === 1 ? 'отчёт' : count < 5 ? 'отчёта' : 'отчётов'}
                      </span>
                    </Button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </SectionCard>

      {!activeTheme && !searching && (
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
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    alignItems: 'center',
                    gap: 12,
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
                  <span style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 12 }}>
                    {formatMoscowDateTime(entry.generatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </SectionCard>
      )}

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          style={{
            position: 'fixed',
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 13000,
            minWidth: 220,
            background: 'var(--surface, #fff)',
            border: '1px solid var(--border)',
            boxShadow: '0 16px 40px rgba(15,23,42,0.18)',
            borderRadius: 10,
            padding: 6,
          }}
        >
          {(() => {
            const shortcutId = `report:${ctxMenu.presetId}`;
            const isPinned = (props.pinnedShortcuts ?? []).includes(shortcutId);
            return (
              <button
                type="button"
                onClick={() => {
                  if (isPinned) props.onRemoveShortcut?.(shortcutId);
                  else props.onAddShortcut?.(shortcutId);
                  setCtxMenu(null);
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: '1px solid transparent',
                  background: 'transparent',
                  color: isPinned ? 'var(--danger, #dc2626)' : 'var(--text)',
                  padding: '8px 10px',
                  cursor: 'pointer',
                  fontSize: 13,
                  borderRadius: 6,
                }}
              >
                {isPinned ? 'Убрать из Моего круга' : 'Добавить в Мой круг'}
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}
