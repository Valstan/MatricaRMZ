import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CustomReportTemplate,
  ReportFilterOption,
  ReportOptionSource,
  ReportPresetDefinition,
  ReportPresetFilterTemplate,
  ReportPresetHistoryEntry,
  ReportPresetId,
  ReportThemeId,
} from '@matricarmz/shared';
import { REPORT_PRESET_THEMES, REPORT_THEMES, formatReportFiltersSummary, reportHistorySignature } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SectionCard } from '../components/SectionCard.js';
import { formatMoscowDateTime } from '../utils/dateUtils.js';

/**
 * Витрина заготовок (пакет владельца 12.09.2026, этап 2B): «огромный список отчётов, у каждого
 * много настроек; хотим повторить недавний — не помним, каким пользовались и что выставляли».
 *
 * Экран не заводит собственного хранилища: он сводит в одно место то, что уже есть и лежит
 * по трём разным углам — сохранённые шаблоны фильтров (были видны только внутри своего
 * отчёта), журнал построенных отчётов и «Мои отчёты». Ещё одно хранилище означало бы второе
 * мнение о том же и расхождение между экранами.
 */

type ShowcaseKind = 'template' | 'history' | 'custom';

type ShowcaseItem = {
  key: string;
  kind: ShowcaseKind;
  title: string;
  /** Подпись владельца своими словами; у журнала её нет — там только настройки. */
  description: string;
  /** Настройки человеческими словами (период, марки, договоры — именами). */
  summary: string;
  themes: string;
  /** Когда этот набор строили в последний раз; у шаблона без прогонов — когда сохранён. */
  lastAt: number;
  /** Сколько раз строили; «популярность» — это он, отдельного счётчика нет. */
  times: number;
  rowCount: number | null;
  open: () => void;
};

const KIND_LABEL: Record<ShowcaseKind, string> = {
  template: 'сохранённые настройки',
  history: 'строили раньше',
  custom: 'мой отчёт',
};

const KIND_TONE: Record<ShowcaseKind, string> = {
  template: 'rgba(37, 99, 235, 0.12)',
  history: 'rgba(100, 116, 139, 0.14)',
  custom: 'rgba(190, 24, 93, 0.12)',
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase('ru');
}

function themesOf(presetId: ReportPresetId): string {
  const ids: readonly ReportThemeId[] = REPORT_PRESET_THEMES[presetId] ?? [];
  return ids
    .map((id) => REPORT_THEMES.find((theme) => theme.id === id)?.title ?? '')
    .filter(Boolean)
    .join(' · ');
}

export function ReportTemplatesShowcasePage(props: {
  userId: string;
  onOpenPreset: (
    presetId: ReportPresetId,
    opts?: { filters?: Record<string, unknown> | null; disabled?: string[]; label?: string },
  ) => void;
  /** «Мои отчёты» живут в своём конструкторе — витрина только приводит оператора к нужному. */
  onOpenCustomReport: (templateId: string) => void;
}) {
  const [presets, setPresets] = useState<ReportPresetDefinition[]>([]);
  const [optionSets, setOptionSets] = useState<Partial<Record<ReportOptionSource, ReportFilterOption[]>>>({});
  const [templatesByPreset, setTemplatesByPreset] = useState<Record<string, ReportPresetFilterTemplate[]>>({});
  const [history, setHistory] = useState<ReportPresetHistoryEntry[]>([]);
  const [customTemplates, setCustomTemplates] = useState<CustomReportTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'frequent' | 'recent'>('recent');
  const [kinds, setKinds] = useState<Record<ShowcaseKind, boolean>>({ template: true, history: true, custom: true });

  const loadAll = useCallback(async () => {
    setBusy(true);
    setStatus('Загрузка заготовок...');
    try {
      const [presetsResult, templatesResult, historyResult, customResult] = await Promise.all([
        window.matrica.reports.presetList(),
        window.matrica.reports.filterTemplatesExportAll({ userId: props.userId }),
        window.matrica.reports.historyList({ userId: props.userId, limit: 50 }),
        window.matrica.reports.customTemplatesList({ userId: props.userId }),
      ]);
      if (!presetsResult?.ok) {
        setStatus(`Ошибка: ${presetsResult?.error ?? 'unknown'}`);
        return;
      }
      setPresets(presetsResult.presets);
      setOptionSets(presetsResult.optionSets ?? {});
      if (templatesResult?.ok) setTemplatesByPreset(templatesResult.byPreset ?? {});
      if (historyResult?.ok) setHistory(historyResult.entries);
      if (customResult?.ok) setCustomTemplates(customResult.templates);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [props.userId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Отчёт строят в соседней вкладке, шаблон сохраняют в карточке отчёта — витрина, открытая
  // рядом, устарела бы молча. Оба события уже рассылаются теми, кто пишет.
  useEffect(() => {
    function onChanged() {
      void loadAll();
    }
    window.addEventListener('matrica:report-history-changed', onChanged);
    window.addEventListener('matrica:report-templates-changed', onChanged);
    return () => {
      window.removeEventListener('matrica:report-history-changed', onChanged);
      window.removeEventListener('matrica:report-templates-changed', onChanged);
    };
  }, [loadAll]);

  const presetById = useMemo(() => {
    const map = new Map<string, ReportPresetDefinition>();
    for (const preset of presets) map.set(String(preset.id), preset);
    return map;
  }, [presets]);

  /**
   * Журнал по подписи набора. Сохранённый шаблон и строка журнала — это один и тот же набор
   * настроек, записанный в двух местах, и подпись их сводит: у шаблона появляется «строили
   * N раз, последний раз тогда-то», а в витрине он не двоится со строкой журнала.
   */
  const historyBySignature = useMemo(() => {
    const map = new Map<string, ReportPresetHistoryEntry>();
    for (const entry of history) {
      map.set(reportHistorySignature(String(entry.presetId), entry.filters, entry.disabled), entry);
    }
    return map;
  }, [history]);

  const items = useMemo<ShowcaseItem[]>(() => {
    const out: ShowcaseItem[] = [];
    const claimedSignatures = new Set<string>();

    for (const [presetIdRaw, templates] of Object.entries(templatesByPreset)) {
      const presetId = presetIdRaw as ReportPresetId;
      const preset = presetById.get(presetIdRaw);
      for (const tpl of templates) {
        const signature = reportHistorySignature(presetIdRaw, tpl.filters, tpl.disabled);
        const twin = historyBySignature.get(signature);
        if (twin) claimedSignatures.add(signature);
        out.push({
          key: `template-${presetIdRaw}-${tpl.id}`,
          kind: 'template',
          title: tpl.name,
          description: tpl.description ?? '',
          summary: formatReportFiltersSummary(preset, tpl.filters, { optionSets }, tpl.disabled ?? []),
          themes: [preset?.title ?? presetIdRaw, themesOf(presetId)].filter(Boolean).join(' · '),
          lastAt: Number(twin?.generatedAt ?? tpl.createdAt ?? 0),
          times: Number(twin?.times ?? 0),
          rowCount: Number.isFinite(Number(twin?.rowCount)) ? Number(twin?.rowCount) : null,
          open: () =>
            props.onOpenPreset(presetId, {
              filters: tpl.filters ?? null,
              ...(tpl.disabled ? { disabled: tpl.disabled } : {}),
              label: tpl.name,
            }),
        });
      }
    }

    for (const entry of history) {
      const signature = reportHistorySignature(String(entry.presetId), entry.filters, entry.disabled);
      // Набор, уже показанный сохранённым шаблоном, второй раз не показываем: для оператора
      // это одна и та же заготовка, просто у одной из двух есть имя.
      if (claimedSignatures.has(signature)) continue;
      const preset = presetById.get(String(entry.presetId));
      out.push({
        key: `history-${entry.presetId}-${entry.generatedAt}`,
        kind: 'history',
        title: preset?.title ?? entry.title,
        description: '',
        summary: entry.filters ? formatReportFiltersSummary(preset, entry.filters, { optionSets }, entry.disabled ?? []) : '',
        themes: themesOf(entry.presetId),
        lastAt: Number(entry.generatedAt ?? 0),
        times: Number(entry.times ?? 0),
        rowCount: Number.isFinite(Number(entry.rowCount)) ? Number(entry.rowCount) : null,
        open: () =>
          props.onOpenPreset(entry.presetId, {
            filters: entry.filters ?? null,
            ...(entry.disabled ? { disabled: entry.disabled } : {}),
          }),
      });
    }

    for (const tpl of customTemplates) {
      out.push({
        key: `custom-${tpl.id}`,
        kind: 'custom',
        title: tpl.name,
        description: tpl.shared ? 'Общий шаблон — виден всем операторам' : '',
        summary: presetById.get(String(tpl.spec?.sourcePresetId ?? ''))?.title ?? '',
        themes: 'Мои отчёты',
        lastAt: Number(tpl.createdAt ?? 0),
        times: 0,
        rowCount: null,
        open: () => props.onOpenCustomReport(tpl.id),
      });
    }

    return out;
  }, [templatesByPreset, history, customTemplates, presetById, optionSets, historyBySignature, props]);

  const normalizedQuery = normalize(query);
  const visibleItems = useMemo(() => {
    const filtered = items
      .filter((item) => kinds[item.kind])
      .filter((item) =>
        normalizedQuery.length === 0
          ? true
          : normalize(`${item.title} ${item.description} ${item.summary} ${item.themes}`).includes(normalizedQuery),
      );
    const byRecent = (a: ShowcaseItem, b: ShowcaseItem) => b.lastAt - a.lastAt;
    return filtered.sort(
      sort === 'frequent' ? (a, b) => b.times - a.times || byRecent(a, b) : byRecent,
    );
  }, [items, kinds, normalizedQuery, sort]);

  function toggleKind(kind: ShowcaseKind) {
    setKinds((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }

  function renderCard(item: ShowcaseItem) {
    return (
      <div
        key={item.key}
        data-report-showcase-card={item.kind}
        style={{
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 10,
          display: 'grid',
          gap: 6,
          alignContent: 'start',
          background: 'var(--surface-1, #fff)',
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 800, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</span>
          <span
            style={{
              fontSize: 11,
              whiteSpace: 'nowrap',
              padding: '2px 8px',
              borderRadius: 999,
              background: KIND_TONE[item.kind],
              color: 'var(--muted)',
            }}
          >
            {KIND_LABEL[item.kind]}
          </span>
        </div>

        {item.themes ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>{item.themes}</div> : null}

        {item.description ? (
          <div data-report-showcase-description style={{ fontSize: 12, whiteSpace: 'normal' }}>
            {item.description}
          </div>
        ) : null}

        {item.summary ? (
          <div style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'normal' }}>
            {item.summary}
            {item.rowCount != null && item.rowCount >= 0 ? ` · строк: ${item.rowCount}` : ''}
          </div>
        ) : null}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>
            {item.times > 1 ? `строили ${item.times} раз · ` : ''}
            {item.lastAt > 0 ? formatMoscowDateTime(item.lastAt) : ''}
          </span>
          <Button variant="primary" onClick={item.open}>
            {item.kind === 'custom' ? 'Открыть' : 'Открыть с этими настройками'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <SectionCard
        title="Заготовки отчётов"
        actions={
          <Button variant="ghost" onClick={() => void loadAll()} disabled={busy}>
            Обновить
          </Button>
        }
      >
        <div style={{ display: 'grid', gap: 8 }}>
          <div className="ui-muted">
            Всё, что уже настроено: сохранённые наборы настроек всех отчётов, отчёты, которые вы уже строили, и «Мои
            отчёты». Щелчок открывает отчёт сразу с этими настройками.
          </div>

          <Input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Поиск по названию, описанию и настройкам"
            aria-label="Поиск заготовки отчёта"
            data-report-showcase-search
          />

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>Показывать:</span>
            {(Object.keys(KIND_LABEL) as ShowcaseKind[]).map((kind) => (
              <Button
                key={kind}
                variant={kinds[kind] ? 'primary' : 'ghost'}
                onClick={() => toggleKind(kind)}
                data-report-showcase-kind={kind}
              >
                {KIND_LABEL[kind]}
              </Button>
            ))}
            <div style={{ flex: 1 }} />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>Сначала:</span>
            <Button variant={sort === 'recent' ? 'primary' : 'ghost'} onClick={() => setSort('recent')}>
              свежие
            </Button>
            <Button variant={sort === 'frequent' ? 'primary' : 'ghost'} onClick={() => setSort('frequent')}>
              частые
            </Button>
          </div>

          {status ? (
            <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title={`Найдено: ${visibleItems.length}`}>
        {visibleItems.length === 0 ? (
          <div className="ui-muted">
            {items.length === 0
              ? 'Заготовок пока нет. Постройте отчёт или сохраните набор настроек в его карточке — он появится здесь.'
              : 'Ничего не найдено — попробуйте другое слово или включите скрытые виды.'}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: 8 }}>
            {visibleItems.map(renderCard)}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
