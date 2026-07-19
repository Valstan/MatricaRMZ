import React, { useEffect, useMemo, useState } from 'react';
import {
  CUSTOM_REPORT_AGG_LABELS_RU,
  CUSTOM_REPORT_OP_LABELS_RU,
  customReportOpsForKind,
  isCustomReportSourcePresetId,
  type CustomReportAgg,
  type CustomReportFilter,
  type CustomReportOp,
  type CustomReportSpecV1,
  type CustomReportTemplate,
  type ReportCellValue,
  type ReportColumn,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { theme } from '../theme.js';

const selectStyle: React.CSSProperties = {
  fontSize: 13,
  padding: 6,
  borderRadius: 6,
  border: `1px solid ${theme.colors.border}`,
  background: 'var(--panel, transparent)',
  color: theme.colors.text,
  maxWidth: '100%',
};

type RunResult = Extract<Awaited<ReturnType<typeof window.matrica.reports.customRun>>, { ok: true }>;

function formatCell(value: ReportCellValue): string {
  if (value == null) return '';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  return String(value);
}

function downloadText(content: string, fileName: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * «Мои отчёты»: конструктор отчётов поверх пресетов. Источник данных — готовый
 * пресет (локальная реплика, права наследуются), надстройка — произвольные
 * фильтры по колонкам, состав/порядок колонок, сортировка, итоги. Рецепт
 * сохраняется в личный шаблон (settingsStore per-user, как шаблоны фильтров).
 */
export function CustomReportsPage() {
  const [sources, setSources] = useState<Array<{ presetId: string; title: string }>>([]);
  const [templates, setTemplates] = useState<CustomReportTemplate[]>([]);
  const [userId, setUserId] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);

  const [sourcePresetId, setSourcePresetId] = useState('');
  const [sourceColumns, setSourceColumns] = useState<ReportColumn[]>([]);
  const [pickedColumns, setPickedColumns] = useState<string[]>([]);
  const [filters, setFilters] = useState<CustomReportFilter[]>([]);
  const [sortKey, setSortKey] = useState('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [groupBy, setGroupBy] = useState('');
  const [aggs, setAggs] = useState<Record<string, CustomReportAgg>>({});
  const [limit, setLimit] = useState(1000);
  const [title, setTitle] = useState('');

  const [result, setResult] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState('');
  const [shareTemplate, setShareTemplate] = useState(false);

  const notify = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 4000);
  };

  const columnByKey = useMemo(() => new Map(sourceColumns.map((c) => [c.key, c])), [sourceColumns]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [src, status] = await Promise.all([window.matrica.reports.customSources(), window.matrica.auth.status()]);
      if (!alive) return;
      if (src.ok) setSources(src.sources);
      else notify(src.error);
      const uid = String(status?.user?.id ?? '');
      setUserId(uid);
      const role = String(status?.user?.role ?? '').toLowerCase();
      setIsAdmin(role === 'admin' || role === 'superadmin');
      const tpl = await window.matrica.reports.customTemplatesList({ userId: uid });
      if (alive && tpl.ok) setTemplates(tpl.templates);
    })();
    return () => {
      alive = false;
    };
  }, []);

  function buildSpec(): CustomReportSpecV1 | null {
    if (!isCustomReportSourcePresetId(sourcePresetId)) return null;
    return {
      version: 1,
      sourcePresetId,
      columns: pickedColumns,
      filters: filters.filter((f) => f.key && (f.op === 'empty' || f.op === 'not_empty' || (f.value ?? '') !== '')),
      ...(title.trim() ? { title: title.trim() } : {}),
      ...(sortKey ? { sort: { key: sortKey, dir: sortDir } } : {}),
      ...(groupBy ? { groupBy } : {}),
      ...(Object.keys(aggs).length > 0 ? { aggs } : {}),
      limit,
    };
  }

  async function selectSource(presetId: string) {
    setSourcePresetId(presetId);
    setSourceColumns([]);
    setPickedColumns([]);
    setFilters([]);
    setSortKey('');
    setGroupBy('');
    setAggs({});
    setResult(null);
    if (!isCustomReportSourcePresetId(presetId)) return;
    setBusy(true);
    try {
      // Короткий прогон за каталогом колонок (limit 1 — строки не нужны).
      const res = await window.matrica.reports.customRun({
        spec: { version: 1, sourcePresetId: presetId, columns: [], filters: [], limit: 1 },
      });
      if (!res.ok) {
        notify(res.error);
        return;
      }
      setSourceColumns(res.sourceColumns);
      setPickedColumns(res.sourceColumns.map((c) => c.key));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    const spec = buildSpec();
    if (!spec) {
      notify('Выберите источник данных');
      return;
    }
    setBusy(true);
    try {
      const res = await window.matrica.reports.customRun({ spec });
      if (!res.ok) {
        notify(res.error);
        return;
      }
      setResult(res);
    } finally {
      setBusy(false);
    }
  }

  async function print() {
    const spec = buildSpec();
    if (!spec) return;
    const res = await window.matrica.reports.customPrint({ spec });
    if (!res.ok) notify(res.error);
  }

  async function exportCsv() {
    const spec = buildSpec();
    if (!spec) return;
    const res = await window.matrica.reports.customCsv({ spec });
    if (!res.ok) {
      notify(res.error);
      return;
    }
    downloadText(res.csv, res.fileName, res.mime);
  }

  async function saveTemplate() {
    const spec = buildSpec();
    if (!spec) {
      notify('Выберите источник данных');
      return;
    }
    const name = templateName.trim() || title.trim();
    if (!name) {
      notify('Укажите имя шаблона');
      return;
    }
    const existing = templates.find((t) => t.name === name && Boolean(t.shared) === shareTemplate);
    const res = await window.matrica.reports.customTemplateSave({
      userId,
      template: { ...(existing ? { id: existing.id } : {}), name, spec, shared: shareTemplate },
    });
    if (!res.ok) {
      notify(res.error);
      return;
    }
    setTemplates(res.templates);
    notify(`Шаблон «${name}» сохранён`);
  }

  async function applyTemplate(tpl: CustomReportTemplate) {
    setTitle(tpl.spec.title ?? tpl.name);
    setTemplateName(tpl.name);
    setShareTemplate(tpl.shared === true);
    setSourcePresetId(tpl.spec.sourcePresetId);
    setFilters(tpl.spec.filters);
    setSortKey(tpl.spec.sort?.key ?? '');
    setSortDir(tpl.spec.sort?.dir ?? 'asc');
    setGroupBy(tpl.spec.groupBy ?? '');
    setAggs(tpl.spec.aggs ?? {});
    setLimit(tpl.spec.limit ?? 1000);
    setResult(null);
    setBusy(true);
    try {
      const res = await window.matrica.reports.customRun({ spec: tpl.spec });
      if (!res.ok) {
        notify(res.error);
        return;
      }
      setSourceColumns(res.sourceColumns);
      setPickedColumns(tpl.spec.columns.length > 0 ? tpl.spec.columns : res.sourceColumns.map((c) => c.key));
      setResult(res);
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(id: string) {
    const res = await window.matrica.reports.customTemplateDelete({ userId, templateId: id });
    if (!res.ok) {
      notify(res.error);
      return;
    }
    setTemplates(res.templates);
  }

  function toggleColumn(key: string) {
    setPickedColumns((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function moveColumn(key: string, dir: -1 | 1) {
    setPickedColumns((prev) => {
      const i = prev.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      const [moved] = next.splice(i, 1);
      next.splice(j, 0, moved as string);
      return next;
    });
  }

  function updateFilter(index: number, patch: Partial<CustomReportFilter>) {
    setFilters((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  }

  const orderedPicked = pickedColumns.filter((k) => columnByKey.has(k));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={sourcePresetId} onChange={(e) => void selectSource(e.target.value)} style={selectStyle}>
          <option value="">— источник данных —</option>
          {sources.map((s) => (
            <option key={s.presetId} value={s.presetId}>
              {s.title}
            </option>
          ))}
        </select>
        <Input placeholder="Название отчёта" value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 180 }} />
        <Button onClick={() => void run()} disabled={busy || !sourcePresetId}>
          Сформировать
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void print()} disabled={busy || !result}>
          🖨 Печать
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void exportCsv()} disabled={busy || !result}>
          ⬇ CSV
        </Button>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Input
            placeholder="Имя шаблона"
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            style={{ width: 160 }}
          />
          <label style={{ fontSize: 12, color: theme.colors.muted, display: 'inline-flex', gap: 4, alignItems: 'center' }} title="Общий шаблон видят все операторы; изменить или удалить его может автор или администратор">
            <input type="checkbox" checked={shareTemplate} onChange={(e) => setShareTemplate(e.target.checked)} />
            общий
          </label>
          <Button size="sm" variant="ghost" onClick={() => void saveTemplate()} disabled={busy || !sourcePresetId}>
            💾 Сохранить шаблон
          </Button>
        </span>
        {toast ? <span style={{ fontSize: 13, color: theme.colors.muted }}>{toast}</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ flex: '0 0 340px', overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {templates.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(
                [
                  { label: 'Мои шаблоны', list: templates.filter((t) => !t.shared) },
                  { label: 'Общие шаблоны', list: templates.filter((t) => t.shared) },
                ] as const
              )
                .filter((s) => s.list.length > 0)
                .map((s) => (
                  <div key={s.label}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{s.label}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {s.list.map((tpl) => (
                        <div key={tpl.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <a
                            style={{ fontSize: 13, cursor: 'pointer', flex: 1, color: theme.colors.text, textDecoration: 'underline' }}
                            onClick={() => void applyTemplate(tpl)}
                          >
                            {tpl.name}
                          </a>
                          {!tpl.shared || tpl.ownerId === userId || isAdmin ? (
                            <Button size="sm" variant="ghost" tone="danger" onClick={() => void deleteTemplate(tpl.id)} title="Удалить шаблон">
                              ✕
                            </Button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: theme.colors.muted }}>
              Шаблонов пока нет. Соберите отчёт (источник → фильтры → колонки) и сохраните его под своим именем — он появится здесь.
            </div>
          )}

          {sourceColumns.length > 0 ? (
            <>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Фильтры (все условия сразу)</div>
                {filters.map((f, i) => {
                  const kind = columnByKey.get(f.key)?.kind;
                  const ops = customReportOpsForKind(kind);
                  const needsValue = f.op !== 'empty' && f.op !== 'not_empty';
                  return (
                    <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      <select
                        value={f.key}
                        onChange={(e) => {
                          const key = e.target.value;
                          const newOps = customReportOpsForKind(columnByKey.get(key)?.kind);
                          updateFilter(i, { key, op: newOps.includes(f.op) ? f.op : (newOps[0] as CustomReportOp) });
                        }}
                        style={{ ...selectStyle, flex: '1 1 120px' }}
                      >
                        {sourceColumns.map((c) => (
                          <option key={c.key} value={c.key}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                      <select value={f.op} onChange={(e) => updateFilter(i, { op: e.target.value as CustomReportOp })} style={selectStyle}>
                        {ops.map((op) => (
                          <option key={op} value={op}>
                            {CUSTOM_REPORT_OP_LABELS_RU[op]}
                          </option>
                        ))}
                      </select>
                      {needsValue ? (
                        <Input
                          value={f.value ?? ''}
                          onChange={(e) => updateFilter(i, { value: e.target.value })}
                          placeholder={kind === 'date' || kind === 'datetime' ? 'дд.мм.гггг' : 'значение'}
                          style={{ width: 110 }}
                        />
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setFilters((prev) => prev.filter((_, j) => j !== i))}>
                        ✕
                      </Button>
                    </div>
                  );
                })}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setFilters((prev) => [
                      ...prev,
                      { key: sourceColumns[0]?.key ?? '', op: customReportOpsForKind(sourceColumns[0]?.kind)[0] as CustomReportOp, value: '' },
                    ])
                  }
                >
                  + Условие
                </Button>
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Сортировка и лимит</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select value={sortKey} onChange={(e) => setSortKey(e.target.value)} style={selectStyle}>
                    <option value="">— без сортировки —</option>
                    {sourceColumns.map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                  <select value={sortDir} onChange={(e) => setSortDir(e.target.value as 'asc' | 'desc')} style={selectStyle}>
                    <option value="asc">по возрастанию</option>
                    <option value="desc">по убыванию</option>
                  </select>
                  <label style={{ fontSize: 12, color: theme.colors.muted, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    строк ≤
                    <Input
                      type="number"
                      min={1}
                      max={10000}
                      value={limit}
                      onChange={(e) => setLimit(Math.max(1, Math.min(10000, Math.floor(Number(e.target.value) || 1000))))}
                      style={{ width: 80 }}
                    />
                  </label>
                </div>
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Группировка</div>
                <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={selectStyle}>
                  <option value="">— без группировки —</option>
                  {sourceColumns.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
                {groupBy ? (
                  <div style={{ fontSize: 12, color: theme.colors.muted, marginTop: 4 }}>
                    Строки группируются по значению колонки, у каждой группы — подытоги по числовым колонкам.
                  </div>
                ) : null}
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  Колонки ({orderedPicked.length} из {sourceColumns.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {[...orderedPicked, ...sourceColumns.map((c) => c.key).filter((k) => !pickedColumns.includes(k))].map((key) => {
                    const col = columnByKey.get(key);
                    if (!col) return null;
                    const checked = pickedColumns.includes(key);
                    return (
                      <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                        <input type="checkbox" checked={checked} onChange={() => toggleColumn(key)} id={`col_${key}`} />
                        <label htmlFor={`col_${key}`} style={{ flex: 1, cursor: 'pointer' }}>
                          {col.label}
                        </label>
                        {checked && col.kind === 'number' ? (
                          <select
                            value={aggs[key] ?? 'sum'}
                            onChange={(e) => {
                              const fn = e.target.value as CustomReportAgg;
                              setAggs((prev) => {
                                const next = { ...prev };
                                if (fn === 'sum') delete next[key];
                                else next[key] = fn;
                                return next;
                              });
                            }}
                            style={{ ...selectStyle, fontSize: 12, padding: '2px 4px' }}
                            title="Итог по колонке (и подытоги групп)"
                          >
                            {(Object.keys(CUSTOM_REPORT_AGG_LABELS_RU) as CustomReportAgg[]).map((fn) => (
                              <option key={fn} value={fn}>
                                {CUSTOM_REPORT_AGG_LABELS_RU[fn]}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {checked ? (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => moveColumn(key, -1)} title="Выше">
                              ↑
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => moveColumn(key, 1)} title="Ниже">
                              ↓
                            </Button>
                          </>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          ) : sourcePresetId ? (
            <div style={{ fontSize: 12, color: theme.colors.muted }}>Загрузка колонок…</div>
          ) : (
            <div style={{ fontSize: 12, color: theme.colors.muted }}>
              Выберите источник данных — появятся его колонки и фильтры. Отчёт строится из локальной базы и учитывает ваши права.
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0 }}>
          {result ? (
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{result.title}</div>
              <div style={{ fontSize: 12, color: theme.colors.muted, marginBottom: 8 }}>{result.subtitle}</div>
              <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
                <thead>
                  <tr>
                    {result.columns.map((c) => (
                      <th
                        key={c.key}
                        style={{
                          border: `1px solid ${theme.colors.border}`,
                          padding: '4px 6px',
                          textAlign: c.align === 'right' ? 'right' : 'left',
                          position: 'sticky',
                          top: 0,
                          background: 'var(--panel, #fff)',
                          cursor: 'pointer',
                        }}
                        title="Сортировать по этой колонке"
                        onClick={() => {
                          if (sortKey === c.key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                          else {
                            setSortKey(c.key);
                            setSortDir('asc');
                          }
                          window.setTimeout(() => void run(), 0);
                        }}
                      >
                        {c.label}
                        {sortKey === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(result.groups
                    ? result.groups.flatMap((g, gi) => [
                        <tr key={`g${gi}`}>
                          <td
                            colSpan={result.columns.length}
                            style={{
                              border: `1px solid ${theme.colors.border}`,
                              padding: '4px 6px',
                              fontWeight: 700,
                              background: 'var(--panel, #e2e8f0)',
                            }}
                          >
                            {result.groupByLabel}: {g.value} ({g.count})
                          </td>
                        </tr>,
                        ...g.rows.map((row, i) => (
                          <tr key={`g${gi}r${i}`}>
                            {result.columns.map((c) => (
                              <td
                                key={c.key}
                                style={{
                                  border: `1px solid ${theme.colors.border}`,
                                  padding: '4px 6px',
                                  textAlign: c.align === 'right' ? 'right' : 'left',
                                }}
                              >
                                {formatCell(row[c.key] ?? null)}
                              </td>
                            ))}
                          </tr>
                        )),
                        ...(g.totals
                          ? [
                              <tr key={`g${gi}t`}>
                                <td
                                  colSpan={result.columns.length}
                                  style={{
                                    border: `1px solid ${theme.colors.border}`,
                                    padding: '4px 6px',
                                    fontStyle: 'italic',
                                    color: theme.colors.muted,
                                  }}
                                >
                                  Итого по группе:{' '}
                                  {result.columns
                                    .filter((c) => g.totals && g.totals[c.key] != null)
                                    .map((c) => {
                                      const fn = result.aggs?.[c.key] ?? 'sum';
                                      const suffix = fn === 'sum' ? '' : ` (${CUSTOM_REPORT_AGG_LABELS_RU[fn]})`;
                                      return `${c.label}${suffix}: ${g.totals![c.key]}`;
                                    })
                                    .join(' · ')}
                                </td>
                              </tr>,
                            ]
                          : []),
                      ])
                    : result.rows.map((row, i) => (
                        <tr key={i}>
                          {result.columns.map((c) => (
                            <td
                              key={c.key}
                              style={{
                                border: `1px solid ${theme.colors.border}`,
                                padding: '4px 6px',
                                textAlign: c.align === 'right' ? 'right' : 'left',
                              }}
                            >
                              {formatCell(row[c.key] ?? null)}
                            </td>
                          ))}
                        </tr>
                      ))) as React.ReactNode}
                </tbody>
              </table>
              {result.rows.length === 0 ? (
                <div style={{ fontSize: 13, color: theme.colors.muted, padding: 8 }}>Нет данных под эти условия.</div>
              ) : null}
              {result.totals ? (
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 8 }}>
                  Итого:{' '}
                  {result.columns
                    .filter((c) => result.totals && result.totals[c.key] != null)
                    .map((c) => {
                      const fn = result.aggs?.[c.key] ?? 'sum';
                      const suffix = fn === 'sum' ? '' : ` (${CUSTOM_REPORT_AGG_LABELS_RU[fn]})`;
                      return `${c.label}${suffix}: ${result.totals![c.key]}`;
                    })
                    .join(' · ')}
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: theme.colors.muted, padding: 16 }}>
              Здесь появится таблица отчёта. Соберите рецепт слева и нажмите «Сформировать».
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CustomReportsPage;
