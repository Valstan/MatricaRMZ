import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { RepairChecklistAnswers, RepairChecklistPayload, RepairChecklistTemplate } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { AttachmentsPanel } from './AttachmentsPanel.js';
import { SearchSelect } from './SearchSelect.js';

function safeJsonStringify(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function csvEscape(s: string) {
  const t = String(s ?? '');
  if (/[",\n\r]/.test(t)) return `"${t.replaceAll('"', '""')}"`;
  return t;
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function toInputDate(ms: number) {
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
  const ms = dt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function emptyAnswersForTemplate(t: RepairChecklistTemplate): RepairChecklistAnswers {
  const ans: RepairChecklistAnswers = {};
  for (const it of t.items) {
    if (it.kind === 'text') ans[it.id] = { kind: 'text', value: '' };
    if (it.kind === 'date') ans[it.id] = { kind: 'date', value: null };
    if (it.kind === 'boolean') ans[it.id] = { kind: 'boolean', value: false };
    if (it.kind === 'table') ans[it.id] = { kind: 'table', rows: [] };
    if (it.kind === 'signature') ans[it.id] = { kind: 'signature', fio: '', position: '', signedAt: null };
  }
  return ans;
}

export function RepairChecklistPanel(props: {
  engineId: string;
  stage: string;
  canEdit: boolean;
  canEditMasterData?: boolean;
  canPrint: boolean;
  canExport: boolean;
  engineNumber?: string;
  engineBrand?: string;
  engineBrandId?: string;
  canViewFiles?: boolean;
  canUploadFiles?: boolean;
  defaultCollapsed?: boolean;
}) {
  const [status, setStatus] = useState<string>('');
  const [templates, setTemplates] = useState<RepairChecklistTemplate[]>([]);
  const [templateId, setTemplateId] = useState<string>('default');
  const [operationId, setOperationId] = useState<string | null>(null);
  const [payload, setPayload] = useState<RepairChecklistPayload | null>(null);
  const [answers, setAnswers] = useState<RepairChecklistAnswers>({});
  const [collapsed, setCollapsed] = useState<boolean>(props.defaultCollapsed === true);
  const prefillKey = useRef<string>('');
  const [employeeOptions, setEmployeeOptions] = useState<Array<{ id: string; label: string; position?: string | null }>>([]);
  const [defectOptions, setDefectOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [defectOptionsStatus, setDefectOptionsStatus] = useState<string>('');

  const activeTemplate = useMemo(() => templates.find((t) => t.id === templateId) ?? templates[0] ?? null, [templates, templateId]);
  const panelTitle = props.stage === 'defect' ? 'Лист дефектовки' : 'Контрольный лист ремонта';
  const attachmentsTitle = props.stage === 'defect' ? 'Вложения к листу дефектовки' : 'Вложения к контрольному листу';

  async function load() {
    setStatus('Загрузка чек-листа...');
    const r = await window.matrica.checklists.engineGet({ engineId: props.engineId, stage: props.stage });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    setTemplates(r.templates ?? []);
    const preferred = r.payload?.templateId ?? (r.templates?.[0]?.id ?? 'default');
    setTemplateId(preferred);
    setOperationId(r.operationId ?? null);
    setPayload(r.payload ?? null);

    const t = (r.templates ?? []).find((x) => x.id === preferred) ?? (r.templates?.[0] ?? null);
    if (r.payload?.answers) setAnswers(r.payload.answers);
    else if (t) setAnswers(emptyAnswersForTemplate(t));
    else setAnswers({});

    setStatus('');
  }

  useEffect(() => {
    void load();
  }, [props.engineId, props.stage]);

  useEffect(() => {
    let alive = true;
    void window.matrica.employees
      .list()
      .then((rows) => {
        if (!alive) return;
        const opts = (rows as any[]).map((r) => ({
          id: String(r.id),
          label: String(r.displayName ?? r.fullName ?? r.id),
          position: r.position ?? null,
        }));
        opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setEmployeeOptions(opts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    // При смене шаблона: если нет payload — инициализируем ответы под шаблон.
    if (!activeTemplate) return;
    if (payload?.templateId) return;
    setAnswers((prev) => (Object.keys(prev).length ? prev : emptyAnswersForTemplate(activeTemplate)));
  }, [activeTemplate?.id]);

  // Автоподстановка из свойств двигателя (только если поле в чек-листе пустое).
  useEffect(() => {
    if (!activeTemplate) return;
    const hasItem = (id: string) => activeTemplate.items.some((it) => it.id === id);
    const brand = String(props.engineBrand ?? '').trim();
    const num = String(props.engineNumber ?? '').trim();
    if (!brand && !num) return;
    const next = { ...answers } as RepairChecklistAnswers;
    let changed = false;
    const isDefect = props.stage === 'defect';

    if (hasItem('engine_brand') && brand) {
      const a: any = (answers as any).engine_brand;
      const current = a?.kind === 'text' ? String(a.value ?? '') : '';
      if ((isDefect && current !== brand) || (!isDefect && !current.trim())) {
        (next as any).engine_brand = { kind: 'text', value: brand };
        changed = true;
      }
    }
    if (hasItem('engine_number') && num) {
      const a: any = (answers as any).engine_number;
      const current = a?.kind === 'text' ? String(a.value ?? '') : '';
      if ((isDefect && current !== num) || (!isDefect && !current.trim())) {
        (next as any).engine_number = { kind: 'text', value: num };
        changed = true;
      }
    }
    if (!isDefect && hasItem('engine_mark_number')) {
      const a: any = (answers as any).engine_mark_number;
      const current = a?.kind === 'text' ? String(a.value ?? '') : '';
      if (!current.trim()) {
        const value = brand && num ? `${brand}, № ${num}` : brand || num;
        (next as any).engine_mark_number = { kind: 'text', value };
        changed = true;
      }
    }

    if (!changed) return;
    setAnswers(next);
    if (props.canEdit) void save(next);
  }, [activeTemplate?.id, props.engineBrand, props.engineNumber, props.stage]);

  useEffect(() => {
    if (props.stage !== 'defect') return;
    let alive = true;
    void (async () => {
      try {
        setDefectOptionsStatus('Загрузка справочников...');
        const options: Array<{ id: string; label: string }> = [];
        const partsRes = await window.matrica.parts.list({ limit: 5000, ...(props.engineBrandId ? { engineBrandId: props.engineBrandId } : {}) });
        if (partsRes && (partsRes as any).ok && Array.isArray((partsRes as any).parts)) {
          for (const p of (partsRes as any).parts) {
            const label = String(p.name ?? p.article ?? p.id);
            options.push({ id: `part:${p.id}`, label });
          }
        }
        const types = await window.matrica.admin.entityTypes.list();
        const nodeType = (types as any[]).find((t) => String(t.code) === 'engine_node');
        if (nodeType?.id) {
          const rows = await window.matrica.admin.entities.listByEntityType(String(nodeType.id));
          for (const r of rows as any[]) {
            const label = String(r.displayName ?? r.id);
            options.push({ id: `node:${r.id}`, label });
          }
        }
        if (!alive) return;
        options.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
        setDefectOptions(options);
        setDefectOptionsStatus('');
      } catch (e) {
        if (!alive) return;
        setDefectOptionsStatus(`Ошибка загрузки: ${String(e)}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.stage, props.engineBrandId]);

  async function createDefectItem(label: string) {
    const name = label.trim();
    if (!name) return null;
    const createNode = confirm('Создать как узел двигателя? (OK = узел, Отмена = деталь)');
    if (createNode) {
      const types = await window.matrica.admin.entityTypes.list();
      const nodeType = (types as any[]).find((t) => String(t.code) === 'engine_node');
      if (!nodeType?.id) return null;
      const created = await window.matrica.admin.entities.create(String(nodeType.id));
      if (!created?.ok || !created.id) return null;
      await window.matrica.admin.entities.setAttr(created.id, 'name', name);
      const opt = { id: `node:${created.id}`, label: name };
      setDefectOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
      return opt.id;
    }
    const created = await window.matrica.parts.create({ attributes: { name } }).catch(() => null);
    if (!created || !(created as any).ok || !(created as any).part?.id) return null;
    const part = (created as any).part;
    const opt = { id: `part:${part.id}`, label: name };
    setDefectOptions((prev) => [...prev, opt].sort((a, b) => a.label.localeCompare(b.label, 'ru')));
    return opt.id;
  }

  useEffect(() => {
    if (!activeTemplate) return;
    if (props.stage !== 'defect') return;
    const tableItem = activeTemplate.items.find((it) => it.kind === 'table' && it.id === 'defect_items');
    if (!tableItem) return;
    if (payload?.answers) return;
    const existing = (answers as any)[tableItem.id];
    if (existing?.kind === 'table' && Array.isArray(existing.rows) && existing.rows.length > 0) {
      prefillKey.current = `${props.engineBrandId ?? ''}:${activeTemplate.id}`;
      return;
    }
    if (!props.engineBrandId) return;
    const key = `${props.engineBrandId}:${activeTemplate.id}`;
    if (prefillKey.current === key) return;
    prefillKey.current = key;
    void (async () => {
      const r = await window.matrica.parts.list({ engineBrandId: props.engineBrandId, limit: 5000 });
      if (!r.ok) return;
      const rows = r.parts.map((p) => ({
        part_name: String(p.name ?? p.article ?? p.id),
        reinstall: false,
        replace: false,
        note: '',
      }));
      const next = { ...answers, [tableItem.id]: { kind: 'table', rows } } as RepairChecklistAnswers;
      setAnswers(next);
      if (props.canEdit) void save(next);
    })();
  }, [activeTemplate?.id, props.stage, props.engineBrandId, payload?.templateId]);

  async function save(nextAnswers: RepairChecklistAnswers) {
    if (!activeTemplate) return;
    if (!props.canEdit) return;
    setStatus('Сохранение...');
    const r = await window.matrica.checklists.engineSave({
      engineId: props.engineId,
      stage: props.stage,
      templateId: activeTemplate.id,
      operationId,
      answers: nextAnswers,
    });
    if (!r.ok) {
      setStatus(`Ошибка: ${r.error}`);
      return;
    }
    setOperationId(r.operationId);
    setStatus('Сохранено');
    // слегка “успокаиваем” статус
    setTimeout(() => setStatus(''), 700);
  }

  function exportJson() {
    if (!activeTemplate) return;
    const obj = {
      template: activeTemplate,
      engineId: props.engineId,
      stage: props.stage,
      operationId,
      answers,
      exportedAt: Date.now(),
    };
    downloadText(`repair_checklist_${props.engineId}_${props.stage}.json`, JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
  }

  function exportCsv() {
    if (!activeTemplate) return;
    const lines: string[] = [];
    lines.push(['engineId', 'stage', 'operationId', 'itemId', 'label', 'kind', 'rowIndex', 'colId', 'value'].map(csvEscape).join(','));

    for (const it of activeTemplate.items) {
      const a: any = (answers as any)[it.id];
      if (!a) {
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, it.kind, '', '', ''].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'text') {
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'text', '', '', String(a.value ?? '')].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'date') {
        const v = a.value ? new Date(a.value).toISOString() : '';
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'date', '', '', v].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'boolean') {
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'boolean', '', '', a.value ? 'true' : 'false'].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'signature') {
        const signedAt = a.signedAt ? new Date(a.signedAt).toISOString() : '';
        const value = `fio=${String(a.fio ?? '')}; position=${String(a.position ?? '')}; signedAt=${signedAt}`;
        lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'signature', '', '', value].map(csvEscape).join(','));
        continue;
      }
      if (a.kind === 'table') {
        const rows: any[] = Array.isArray(a.rows) ? a.rows : [];
        if (rows.length === 0) {
          lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, 'table', '', '', ''].map(csvEscape).join(','));
          continue;
        }
        rows.forEach((row, idx) => {
          const cols = it.columns?.map((c) => c.id) ?? Object.keys(row ?? {});
          cols.forEach((colId) => {
            lines.push(
              [props.engineId, props.stage, operationId ?? '', it.id, it.label, 'table', String(idx), colId, String((row as any)?.[colId] ?? '')]
                .map(csvEscape)
                .join(','),
            );
          });
        });
        continue;
      }
      lines.push([props.engineId, props.stage, operationId ?? '', it.id, it.label, it.kind, '', '', safeJsonStringify(a)].map(csvEscape).join(','));
    }

    downloadText(`repair_checklist_${props.engineId}_${props.stage}.csv`, lines.join('\n') + '\n', 'text/csv;charset=utf-8');
  }

  function printChecklist() {
    if (!activeTemplate) return;
    const formatBool = (val: unknown) => (val ? 'Да' : 'Нет');
    const renderTable = (it: any, a: any) => {
      const rows: any[] = Array.isArray(a?.rows) ? a.rows : [];
      const cols =
        Array.isArray(it?.columns) && it.columns.length > 0
          ? it.columns
          : rows[0]
            ? Object.keys(rows[0]).map((id) => ({ id, label: id }))
            : [{ id: 'value', label: 'Значение' }];
      const head = cols.map((c: any) => `<th>${escapeHtml(c.label ?? c.id)}</th>`).join('');
      const body =
        rows.length === 0
          ? `<tr><td colspan="${cols.length}" class="muted">Нет данных</td></tr>`
          : rows
              .map((row) => {
                const tds = cols
                  .map((c: any) => {
                    const raw = (row as any)?.[c.id];
                    const isBool = c.kind === 'boolean' || typeof raw === 'boolean';
                    const value = isBool ? formatBool(raw) : raw == null ? '—' : String(raw);
                    return `<td>${escapeHtml(value)}</td>`;
                  })
                  .join('');
                return `<tr>${tds}</tr>`;
              })
              .join('');
      return `<table class="doc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    };
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${panelTitle}</title>
  <style>
    @page { size: A4; margin: 12mm; }
    body { font-family: "Times New Roman", "Liberation Serif", serif; margin: 0; color: #0b1220; }
    h1 { margin: 0 0 6px 0; font-size: 18px; text-transform: uppercase; letter-spacing: 0.2px; }
    .doc { padding: 12mm; }
    .meta { color: #111827; margin-bottom: 12px; font-size: 12px; line-height: 1.35; }
    .doc-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    .doc-table th, .doc-table td { border: 1px solid #111827; padding: 6px 8px; font-size: 12px; vertical-align: top; }
    .doc-table th { background: #f3f4f6; font-weight: 700; }
    .muted { color: #6b7280; }
    .section-title { margin: 12px 0 6px; font-size: 13px; font-weight: 700; }
    .signature { margin-top: 10px; font-size: 12px; }
    .signature-line { display: inline-block; border-bottom: 1px solid #111827; min-width: 220px; height: 14px; vertical-align: bottom; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin:12px;">
    <button onclick="window.print()">Печать</button>
  </div>
  <div class="doc">
    <h1>${panelTitle}</h1>
    <div class="meta">
      <div><b>Двигатель:</b> ${escapeHtml(String(props.engineBrand ?? ''))} ${escapeHtml(String(props.engineNumber ?? ''))}</div>
      <div><b>Шаблон:</b> ${escapeHtml(activeTemplate.name)} (v${escapeHtml(String(activeTemplate.version))})</div>
      <div><b>Дата:</b> ${escapeHtml(new Date().toLocaleString('ru-RU'))}</div>
    </div>
    <table class="doc-table">
      <thead><tr><th style="width:40%">Поле</th><th>Значение</th></tr></thead>
      <tbody>
        ${activeTemplate.items
          .map((it) => {
            const a: any = (answers as any)[it.id];
            if (!a) return `<tr><td>${escapeHtml(it.label)}</td><td class="muted">—</td></tr>`;
            if (a.kind === 'text') return `<tr><td>${escapeHtml(it.label)}</td><td>${escapeHtml(String(a.value ?? ''))}</td></tr>`;
            if (a.kind === 'date') return `<tr><td>${escapeHtml(it.label)}</td><td>${a.value ? escapeHtml(new Date(a.value).toLocaleDateString('ru-RU')) : ''}</td></tr>`;
            if (a.kind === 'boolean') return `<tr><td>${escapeHtml(it.label)}</td><td>${formatBool(a.value)}</td></tr>`;
            if (a.kind === 'signature')
              return `<tr><td>${escapeHtml(it.label)}</td><td>ФИО: ${escapeHtml(String(a.fio ?? ''))}<br/>Должность: ${escapeHtml(
                String(a.position ?? ''),
              )}<br/>Дата: ${a.signedAt ? escapeHtml(new Date(a.signedAt).toLocaleDateString('ru-RU')) : ''}</td></tr>`;
            if (a.kind === 'table')
              return `<tr><td>${escapeHtml(it.label)}</td><td>${renderTable(it, a)}</td></tr>`;
            return `<tr><td>${escapeHtml(it.label)}</td><td class="muted">—</td></tr>`;
          })
          .join('\n')}
      </tbody>
    </table>
    <div class="signature">
      <div>Подпись: <span class="signature-line"></span></div>
    </div>
  </div>
</body>
</html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.focus(), 200);
  }

  return (
    <div style={{ marginTop: 14, border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: 14, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <strong>{panelTitle}</strong>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => setCollapsed((v) => !v)}>
          {collapsed ? 'Развернуть' : 'Свернуть'}
        </Button>
        <Button variant="ghost" onClick={() => void load()}>
          Обновить
        </Button>
        {props.canExport && (
          <>
            <Button variant="ghost" onClick={exportJson}>
              Экспорт JSON
            </Button>
            <Button variant="ghost" onClick={exportCsv}>
              Экспорт CSV
            </Button>
          </>
        )}
        {props.canPrint && (
          <Button variant="ghost" onClick={printChecklist}>
            Печать
          </Button>
        )}
      </div>

      {!collapsed && (
      <div style={{ marginTop: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 420 }}>
          <div style={{ fontSize: 12, color: '#334155', marginBottom: 4 }}>Шаблон</div>
          <select
            value={templateId}
            onChange={(e) => {
              const id = e.target.value;
              setTemplateId(id);
              const t = templates.find((x) => x.id === id) ?? null;
              if (t && (!payload || payload.templateId !== id)) setAnswers(emptyAnswersForTemplate(t));
            }}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 12, border: '1px solid rgba(15, 23, 42, 0.25)' }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} (v{t.version})
              </option>
            ))}
            {templates.length === 0 && <option value="default">(нет шаблонов)</option>}
          </select>
        </div>
        <div style={{ color: '#64748b', fontSize: 12 }}>
          stage: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{props.stage}</span>
        </div>
        <div style={{ flex: 1 }} />
        {status && <div style={{ color: '#64748b', fontSize: 12 }}>{status}</div>}
      </div>
      )}

      {!collapsed && !activeTemplate ? (
        <div style={{ marginTop: 10, color: '#64748b' }}>Нет доступных шаблонов.</div>
      ) : null}
      {!collapsed && activeTemplate ? (
        <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '340px 1fr', gap: 10, alignItems: 'center' }}>
          {activeTemplate.items.map((it) => {
            const a: any = (answers as any)[it.id];
            return (
              <React.Fragment key={it.id}>
                <div style={{ color: '#334155' }}>
                  {it.label} {it.required ? <span style={{ color: '#b91c1c' }}>*</span> : null}
                </div>
                <div>
                  {it.kind === 'text' && (
                    <Input
                      value={a?.kind === 'text' ? a.value : ''}
                      disabled={!props.canEdit || (props.stage === 'defect' && (it.id === 'engine_brand' || it.id === 'engine_number'))}
                      onChange={(e) => {
                        if (props.stage === 'defect' && (it.id === 'engine_brand' || it.id === 'engine_number')) return;
                        const next = { ...answers, [it.id]: { kind: 'text', value: e.target.value } } as RepairChecklistAnswers;
                        setAnswers(next);
                      }}
                      onBlur={() => void save(answers)}
                    />
                  )}

                  {it.kind === 'date' && (
                    <Input
                      type="date"
                      value={a?.kind === 'date' && a.value ? toInputDate(a.value) : ''}
                      disabled={!props.canEdit}
                      onChange={(e) => {
                        const nextVal = fromInputDate(e.target.value);
                        const next = { ...answers, [it.id]: { kind: 'date', value: nextVal } } as RepairChecklistAnswers;
                        setAnswers(next);
                        void save(next);
                      }}
                    />
                  )}

                  {it.kind === 'boolean' && (
                    <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={a?.kind === 'boolean' ? !!a.value : false}
                        disabled={!props.canEdit}
                        onChange={(e) => {
                          const next = { ...answers, [it.id]: { kind: 'boolean', value: e.target.checked } } as RepairChecklistAnswers;
                          setAnswers(next);
                          void save(next);
                        }}
                      />
                      <span style={{ color: '#64748b', fontSize: 12 }}>{a?.kind === 'boolean' && a.value ? 'да' : 'нет'}</span>
                    </label>
                  )}

                  {it.kind === 'signature' && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: 8 }}>
                      {(() => {
                        const fioValue = a?.kind === 'signature' ? String(a.fio ?? '') : '';
                        const inList = fioValue ? employeeOptions.some((opt) => opt.label === fioValue || opt.id === fioValue) : false;
                        const extra = fioValue && !inList ? [{ id: fioValue, label: fioValue, position: a?.position ?? null }] : [];
                        const options = [...employeeOptions, ...extra];
                        const valueId =
                          fioValue && inList
                            ? employeeOptions.find((opt) => opt.label === fioValue || opt.id === fioValue)?.id ?? fioValue
                            : fioValue || null;
                        return (
                      <SearchSelect
                        value={valueId}
                        options={options}
                        disabled={!props.canEdit}
                        placeholder="ФИО"
                        onChange={(next) => {
                          if (!props.canEdit) return;
                          const prev = a?.kind === 'signature' ? a : { fio: '', position: '', signedAt: null };
                          const chosen = options.find((opt) => opt.id === next) ?? null;
                          const fio = chosen?.label ?? '';
                          const position = chosen?.position ?? prev.position ?? '';
                          const nextAnswers = {
                            ...answers,
                            [it.id]: { kind: 'signature', fio, position, signedAt: prev.signedAt },
                          } as RepairChecklistAnswers;
                          setAnswers(nextAnswers);
                          void save(nextAnswers);
                        }}
                      />
                        );
                      })()}
                      <Input
                        value={a?.kind === 'signature' ? String(a.position ?? '') : ''}
                        disabled
                        placeholder="Должность"
                      />
                      <Input
                        type="date"
                        value={a?.kind === 'signature' && a.signedAt ? toInputDate(a.signedAt) : ''}
                        disabled={!props.canEdit}
                        onChange={(e) => {
                          const prev = a?.kind === 'signature' ? a : { fio: '', position: '', signedAt: null };
                          const nextVal = fromInputDate(e.target.value);
                          const next = { ...answers, [it.id]: { kind: 'signature', fio: prev.fio, position: prev.position, signedAt: nextVal } } as RepairChecklistAnswers;
                          setAnswers(next);
                          void save(next);
                        }}
                      />
                    </div>
                  )}

                  {it.kind === 'table' && (
                    <TableEditor
                      canEdit={props.canEdit}
                      columns={it.columns ?? []}
                      rows={a?.kind === 'table' ? (a.rows ?? []) : []}
                      cellRenderers={
                        props.stage === 'defect' && it.id === 'defect_items'
                          ? {
                              part_name: ({ rowIdx, columnId, value, setValue }) => {
                                const current = String(value ?? '');
                                const match = defectOptions.find((o) => o.label === current) ?? null;
                                const valueId = match?.id ?? null;
                                return (
                                  <SearchSelect
                                    value={valueId}
                                    options={defectOptions}
                                    disabled={!props.canEdit}
                                    placeholder="Выберите деталь или узел"
                                    createLabel="Добавить"
                                    onCreate={props.canEdit ? createDefectItem : undefined}
                                    onChange={(next) => {
                                      const selected = defectOptions.find((o) => o.id === next) ?? null;
                                      setValue(rowIdx, columnId, selected?.label ?? '', true);
                                    }}
                                  />
                                );
                              },
                            }
                          : undefined
                      }
                      onChange={(rows) => {
                        const next = { ...answers, [it.id]: { kind: 'table', rows } } as RepairChecklistAnswers;
                        setAnswers(next);
                      }}
                      onSave={(rows) => void save({ ...answers, [it.id]: { kind: 'table', rows } } as RepairChecklistAnswers)}
                    />
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      ) : null}

      {!collapsed && !props.canEdit && <div style={{ marginTop: 10, color: '#64748b' }}>Только просмотр (нет прав на редактирование операций).</div>}

      {!collapsed && (
        <AttachmentsPanel
          title={attachmentsTitle}
          value={(payload as any)?.attachments}
          canView={props.canViewFiles === true}
          canUpload={props.canUploadFiles === true && props.canEdit}
          onChange={async (next) => {
            if (!activeTemplate) return;
            if (!props.canEdit) return;
            setStatus('Сохранение...');
            const r = await window.matrica.checklists.engineSave({
              engineId: props.engineId,
              stage: props.stage,
              templateId: activeTemplate.id,
              operationId,
              answers,
              attachments: next,
            });
            if (!r.ok) {
              setStatus(`Ошибка: ${r.error}`);
              return { ok: false as const, error: r.error };
            }
            setOperationId(r.operationId);
            setPayload((prev) => (prev ? ({ ...prev, attachments: next } as RepairChecklistPayload) : prev));
            setStatus('Сохранено');
            setTimeout(() => setStatus(''), 700);
            return { ok: true as const };
          }}
        />
      )}

      {!collapsed && props.stage === 'defect' && defectOptionsStatus && (
        <div style={{ marginTop: 10, color: defectOptionsStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>
          {defectOptionsStatus}
        </div>
      )}
      {!collapsed && props.stage === 'defect' && !props.engineBrandId && (
        <div style={{ marginTop: 10, color: '#64748b', fontSize: 12 }}>
          Выберите марку двигателя, чтобы подставить список деталей из справочника.
        </div>
      )}
    </div>
  );
}

function TableEditor(props: {
  canEdit: boolean;
  columns: { id: string; label: string; kind?: 'text' | 'boolean' }[];
  rows: Record<string, string | boolean>[];
  cellRenderers?: Record<
    string,
    (args: {
      rowIdx: number;
      columnId: string;
      value: string | boolean;
      setValue: (rowIdx: number, columnId: string, value: string | boolean, save?: boolean) => void;
    }) => React.ReactNode
  >;
  onChange: (rows: Record<string, string | boolean>[]) => void;
  onSave: (rows: Record<string, string | boolean>[]) => void;
}) {
  const cols = props.columns.length ? props.columns : [{ id: 'value', label: 'Значение' }];
  const rows = props.rows ?? [];

  function setCell(rowIdx: number, colId: string, value: string | boolean, save = false) {
    const next = rows.map((r, i) => (i === rowIdx ? { ...r, [colId]: value } : r));
    props.onChange(next);
    if (save && props.canEdit) props.onSave(next);
  }

  return (
    <div style={{ border: '1px solid rgba(15, 23, 42, 0.18)', borderRadius: 12, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ background: 'linear-gradient(135deg, #2563eb 0%, #7c3aed 120%)', color: '#fff' }}>
            {cols.map((c) => (
              <th key={c.id} style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>
                {c.label}
              </th>
            ))}
            {props.canEdit && (
              <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10, width: 120 }}>Действия</th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx}>
              {cols.map((c) => {
                const renderer = props.cellRenderers?.[c.id];
                return (
                <td key={c.id} style={{ borderBottom: '1px solid rgba(15, 23, 42, 0.10)', padding: 8 }}>
                  {renderer ? (
                    renderer({ rowIdx: idx, columnId: c.id, value: (r as any)[c.id], setValue: setCell })
                  ) : c.kind === 'boolean' ? (
                    <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        checked={Boolean((r as any)[c.id])}
                        disabled={!props.canEdit}
                        onChange={(e) => {
                          if (!props.canEdit) return;
                          const next = rows.map((row, i) => (i === idx ? { ...row, [c.id]: e.target.checked } : row));
                          props.onChange(next);
                          props.onSave(next);
                        }}
                      />
                      <span style={{ color: '#6b7280', fontSize: 12 }}>{(r as any)[c.id] ? 'да' : 'нет'}</span>
                    </label>
                  ) : (
                    <Input
                      value={String((r as any)[c.id] ?? '')}
                      disabled={!props.canEdit}
                      onChange={(e) => setCell(idx, c.id, e.target.value)}
                      onBlur={() => props.canEdit && props.onSave(rows)}
                    />
                  )}
                </td>
                );
              })}
              {props.canEdit && (
                <td style={{ borderBottom: '1px solid rgba(15, 23, 42, 0.10)', padding: 8 }}>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const next = rows.filter((_, i) => i !== idx);
                      props.onChange(next);
                      props.onSave(next);
                    }}
                  >
                    Удалить
                  </Button>
                </td>
              )}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={cols.length + (props.canEdit ? 1 : 0)} style={{ padding: 10, color: '#64748b' }}>
                Пусто
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {props.canEdit && (
        <div style={{ padding: 10, display: 'flex', gap: 10 }}>
          <Button
            variant="ghost"
            onClick={() => {
              const next = [
                ...rows,
                Object.fromEntries(cols.map((c) => [c.id, c.kind === 'boolean' ? false : ''])),
              ];
              props.onChange(next);
              props.onSave(next);
            }}
          >
            Добавить строку
          </Button>
        </div>
      )}
    </div>
  );
}


