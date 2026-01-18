import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { RepairChecklistAnswers, RepairChecklistPayload, RepairChecklistTemplate } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { AttachmentsPanel } from './AttachmentsPanel.js';

function safeJsonStringify(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
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
    // При смене шаблона: если нет payload — инициализируем ответы под шаблон.
    if (!activeTemplate) return;
    if (payload?.templateId) return;
    setAnswers((prev) => (Object.keys(prev).length ? prev : emptyAnswersForTemplate(activeTemplate)));
  }, [activeTemplate?.id]);

  // Автоподстановка из свойств двигателя (только если поле в чек-листе пустое).
  useEffect(() => {
    if (!activeTemplate) return;
    const key = 'engine_mark_number';
    const a: any = (answers as any)[key];
    const current = a?.kind === 'text' ? String(a.value ?? '') : '';
    if (current.trim()) return;
    const brand = String(props.engineBrand ?? '').trim();
    const num = String(props.engineNumber ?? '').trim();
    if (!brand && !num) return;
    const value = brand && num ? `${brand}, № ${num}` : brand || num;
    setAnswers((prev) => ({ ...prev, [key]: { kind: 'text', value } } as RepairChecklistAnswers));
    // сохраняем сразу, если есть права на редактирование
    if (props.canEdit) {
      const next = { ...answers, [key]: { kind: 'text', value } } as RepairChecklistAnswers;
      void save(next);
    }
  }, [activeTemplate?.id, props.engineBrand, props.engineNumber]);

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
        reinstall: '',
        replace: '',
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
    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${panelTitle}</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 24px; }
    h1 { margin: 0 0 12px 0; font-size: 20px; }
    .meta { color: #444; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f5f5f5; }
    .muted { color: #666; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px;">
    <button onclick="window.print()">Печать</button>
  </div>
  <h1>${panelTitle}</h1>
  <div class="meta">
    <div><b>Двигатель:</b> ${String(props.engineBrand ?? '')} ${String(props.engineNumber ?? '')}</div>
    <div><b>Шаблон:</b> ${activeTemplate.name} (v${activeTemplate.version})</div>
    <div><b>Дата:</b> ${new Date().toLocaleString('ru-RU')}</div>
  </div>
  <table>
    <thead><tr><th style="width:40%">Поле</th><th>Значение</th></tr></thead>
    <tbody>
      ${activeTemplate.items
        .map((it) => {
          const a: any = (answers as any)[it.id];
          if (!a) return `<tr><td>${it.label}</td><td class="muted">—</td></tr>`;
          if (a.kind === 'text') return `<tr><td>${it.label}</td><td>${String(a.value ?? '')}</td></tr>`;
          if (a.kind === 'date') return `<tr><td>${it.label}</td><td>${a.value ? new Date(a.value).toLocaleDateString('ru-RU') : ''}</td></tr>`;
          if (a.kind === 'boolean') return `<tr><td>${it.label}</td><td>${a.value ? 'да' : 'нет'}</td></tr>`;
          if (a.kind === 'signature')
            return `<tr><td>${it.label}</td><td>ФИО: ${String(a.fio ?? '')}<br/>Должность: ${String(a.position ?? '')}<br/>Дата: ${
              a.signedAt ? new Date(a.signedAt).toLocaleDateString('ru-RU') : ''
            }</td></tr>`;
          if (a.kind === 'table') return `<tr><td>${it.label}</td><td><pre>${safeJsonStringify(a.rows ?? [])}</pre></td></tr>`;
          return `<tr><td>${it.label}</td><td class="muted">—</td></tr>`;
        })
        .join('\n')}
    </tbody>
  </table>
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
                      disabled={!props.canEdit}
                      onChange={(e) => {
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
                      <Input
                        value={a?.kind === 'signature' ? String(a.fio ?? '') : ''}
                        disabled={!props.canEdit}
                        placeholder="ФИО"
                        onChange={(e) => {
                          const prev = a?.kind === 'signature' ? a : { fio: '', position: '', signedAt: null };
                          const next = { ...answers, [it.id]: { kind: 'signature', fio: e.target.value, position: prev.position, signedAt: prev.signedAt } } as RepairChecklistAnswers;
                          setAnswers(next);
                        }}
                        onBlur={() => void save(answers)}
                      />
                      <Input
                        value={a?.kind === 'signature' ? String(a.position ?? '') : ''}
                        disabled={!props.canEdit}
                        placeholder="Должность"
                        onChange={(e) => {
                          const prev = a?.kind === 'signature' ? a : { fio: '', position: '', signedAt: null };
                          const next = { ...answers, [it.id]: { kind: 'signature', fio: prev.fio, position: e.target.value, signedAt: prev.signedAt } } as RepairChecklistAnswers;
                          setAnswers(next);
                        }}
                        onBlur={() => void save(answers)}
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
  columns: { id: string; label: string }[];
  rows: Record<string, string>[];
  onChange: (rows: Record<string, string>[]) => void;
  onSave: (rows: Record<string, string>[]) => void;
}) {
  const cols = props.columns.length ? props.columns : [{ id: 'value', label: 'Значение' }];
  const rows = props.rows ?? [];

  function setCell(rowIdx: number, colId: string, value: string) {
    const next = rows.map((r, i) => (i === rowIdx ? { ...r, [colId]: value } : r));
    props.onChange(next);
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
              {cols.map((c) => (
                <td key={c.id} style={{ borderBottom: '1px solid rgba(15, 23, 42, 0.10)', padding: 8 }}>
                  <Input
                    value={String((r as any)[c.id] ?? '')}
                    disabled={!props.canEdit}
                    onChange={(e) => setCell(idx, c.id, e.target.value)}
                    onBlur={() => props.canEdit && props.onSave(rows)}
                  />
                </td>
              ))}
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
              const next = [...rows, Object.fromEntries(cols.map((c) => [c.id, '']))];
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


