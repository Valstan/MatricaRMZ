import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { SupplyRequestDelivery, SupplyRequestItem, SupplyRequestPayload } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type LinkOpt = { id: string; label: string };

function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function statusLabel(s: string): string {
  switch (s) {
    case 'draft':
      return 'Черновик';
    case 'signed':
      return 'Подписана начальником';
    case 'director_approved':
      return 'Одобрена директором';
    case 'accepted':
      return 'Принята к исполнению';
    case 'fulfilled_full':
      return 'Исполнена полностью';
    case 'fulfilled_partial':
      return 'Исполнена частично';
    default:
      return s;
  }
}

function toInputDate(ms: number | null | undefined) {
  if (!ms) return '';
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

function sumDelivered(deliveries: SupplyRequestDelivery[] | undefined): number {
  if (!Array.isArray(deliveries)) return 0;
  return deliveries.reduce((acc, d) => acc + (Number(d?.qty) || 0), 0);
}

function printSupplyRequest(p: SupplyRequestPayload, departmentLabel: string, workshopLabel: string, sectionLabel: string) {
  const items = p.items ?? [];
  const rowsHtml = items
    .map((it, idx) => {
      const delivered = sumDelivered(it.deliveries);
      const remaining = (Number(it.qty) || 0) - delivered;
      const deliveriesHtml = (it.deliveries ?? [])
        .map((d) => {
          const dt = d.deliveredAt ? new Date(d.deliveredAt).toLocaleDateString('ru-RU') : '-';
          return `<div>${escapeHtml(dt)}: ${escapeHtml(String(d.qty ?? ''))} ${escapeHtml(it.unit ?? '')}${
            d.note ? ` (${escapeHtml(d.note)})` : ''
          }</div>`;
        })
        .join('');
      return `<tr>
  <td>${idx + 1}</td>
  <td>${escapeHtml(it.name ?? '')}</td>
  <td>${escapeHtml(String(it.qty ?? ''))}</td>
  <td>${escapeHtml(it.unit ?? '')}</td>
  <td>${escapeHtml(it.note ?? '')}</td>
  <td>${escapeHtml(String(delivered))}</td>
  <td>${escapeHtml(String(Math.max(0, remaining)))}</td>
  <td>${deliveriesHtml || '<span style="color:#666">—</span>'}</td>
</tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Заявка ${escapeHtml(p.requestNumber)}</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 24px; }
    h1 { margin: 0 0 12px 0; font-size: 20px; }
    .meta { margin-bottom: 14px; color: #111; }
    .meta div { margin: 4px 0; }
    table { width: 100%; border-collapse: collapse; }
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
  <h1>Заявка в снабжение: ${escapeHtml(p.requestNumber)}</h1>
  <div class="meta">
    <div><b>Дата составления:</b> ${escapeHtml(new Date(p.compiledAt).toLocaleDateString('ru-RU'))}</div>
    <div><b>Статус:</b> ${escapeHtml(statusLabel(p.status))}</div>
    <div><b>Подразделение:</b> ${escapeHtml(departmentLabel || p.departmentId || '-')}</div>
    <div><b>Цех:</b> ${escapeHtml(workshopLabel || p.workshopId || '-')}</div>
    <div><b>Участок:</b> ${escapeHtml(sectionLabel || p.sectionId || '-')}</div>
    <div><b>Описание:</b> ${escapeHtml(p.title || '-')}</div>
  </div>
  <table>
    <thead>
      <tr>
        <th>№</th>
        <th>Наименование</th>
        <th>Кол-во</th>
        <th>Ед.</th>
        <th>Примечание</th>
        <th>Привезено</th>
        <th>Осталось</th>
        <th>Факт поставок</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="8" class="muted">Нет позиций</td></tr>'}
    </tbody>
  </table>

  <div style="margin-top:18px;">
    <div><b>Подпись начальника:</b> ${escapeHtml(p.signedByHead?.username ?? '')} ${p.signedByHead?.signedAt ? escapeHtml(new Date(p.signedByHead.signedAt).toLocaleString('ru-RU')) : ''}</div>
    <div><b>Одобрение директора:</b> ${escapeHtml(p.approvedByDirector?.username ?? '')} ${p.approvedByDirector?.signedAt ? escapeHtml(new Date(p.approvedByDirector.signedAt).toLocaleString('ru-RU')) : ''}</div>
    <div><b>Принято снабжением:</b> ${escapeHtml(p.acceptedBySupply?.username ?? '')} ${p.acceptedBySupply?.signedAt ? escapeHtml(new Date(p.acceptedBySupply.signedAt).toLocaleString('ru-RU')) : ''}</div>
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

export function SupplyRequestDetailsPage(props: {
  id: string;
  onBack: () => void;
  canEdit: boolean;
  canSign: boolean;
  canApprove: boolean;
  canAccept: boolean;
  canFulfill: boolean;
  canPrint: boolean;
  canViewMasterData: boolean;
}) {
  const [payload, setPayload] = useState<SupplyRequestPayload | null>(null);
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [expandedLine, setExpandedLine] = useState<number | null>(null);

  const [linkLists, setLinkLists] = useState<Record<string, LinkOpt[]>>({});

  const saveTimer = useRef<any>(null);
  const lastSavedJson = useRef<string>('');

  async function load() {
    setSaveStatus('Загрузка…');
    const r = await window.matrica.supplyRequests.get(props.id);
    if (!r.ok) {
      setSaveStatus(`Ошибка: ${r.error}`);
      return;
    }
    setPayload(r.payload);
    lastSavedJson.current = JSON.stringify(r.payload);
    setSaveStatus('');
  }

  async function loadLinkLists() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    const typeIdByCode = new Map(types.map((t) => [t.code, t.id] as const));
    async function loadType(code: string, key: string) {
      const tid = typeIdByCode.get(code);
      if (!tid) return;
      const rows = await window.matrica.admin.entities.listByEntityType(tid);
      setLinkLists((p) => ({
        ...p,
        [key]: rows.map((x) => ({ id: x.id, label: x.displayName ? `${x.displayName}` : x.id })),
      }));
    }
    await loadType('department', 'departmentId');
    await loadType('workshop', 'workshopId');
    await loadType('section', 'sectionId');
  }

  useEffect(() => {
    void load();
    void loadLinkLists();
  }, [props.id]);

  async function saveNow(next: SupplyRequestPayload) {
    if (!props.canEdit) return;
    try {
      setSaveStatus('Сохраняю…');
      const r = await window.matrica.supplyRequests.update({ id: props.id, payload: next });
      if (!r.ok) {
        setSaveStatus(`Ошибка: ${r.error}`);
        return;
      }
      lastSavedJson.current = JSON.stringify(next);
      setSaveStatus('Сохранено');
      setTimeout(() => setSaveStatus(''), 700);
    } catch (e) {
      setSaveStatus(`Ошибка: ${String(e)}`);
    }
  }

  function scheduleSave(next: SupplyRequestPayload) {
    setPayload(next);
    if (!props.canEdit) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const json = JSON.stringify(next);
      if (json === lastSavedJson.current) return;
      void saveNow(next);
    }, 450);
  }

  const departmentLabel = useMemo(() => {
    if (!payload) return '';
    const v = payload.departmentId || '';
    const opt = (linkLists.departmentId ?? []).find((x) => x.id === v);
    return opt?.label ?? '';
  }, [payload, linkLists.departmentId]);
  const workshopLabel = useMemo(() => {
    if (!payload) return '';
    const v = payload.workshopId || '';
    const opt = (linkLists.workshopId ?? []).find((x) => x.id === v);
    return opt?.label ?? '';
  }, [payload, linkLists.workshopId]);
  const sectionLabel = useMemo(() => {
    if (!payload) return '';
    const v = payload.sectionId || '';
    const opt = (linkLists.sectionId ?? []).find((x) => x.id === v);
    return opt?.label ?? '';
  }, [payload, linkLists.sectionId]);

  if (!payload) {
    return <div style={{ color: '#6b7280' }}>{saveStatus || '...'}</div>;
  }

  const canTransitionSign = props.canSign && payload.status === 'draft';
  const canTransitionApprove = props.canApprove && payload.status === 'signed';
  const canTransitionAccept = props.canAccept && payload.status === 'director_approved';
  const canTransitionFulfill = props.canFulfill && payload.status === 'accepted';

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button variant="ghost" onClick={props.onBack}>
          ← Назад
        </Button>
        {props.canPrint && (
          <Button
            variant="ghost"
            onClick={() => {
              printSupplyRequest(payload, departmentLabel, workshopLabel, sectionLabel);
            }}
          >
            Печать
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {saveStatus && <div style={{ color: saveStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{saveStatus}</div>}
        <Button variant="ghost" onClick={() => void load()}>
          Обновить
        </Button>
      </div>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 10 }}>
          <div style={{ color: '#6b7280' }}>Номер заявки</div>
          <div style={{ fontWeight: 700 }}>{payload.requestNumber}</div>

          <div style={{ color: '#6b7280' }}>Дата составления</div>
          <Input
            type="date"
            value={toInputDate(payload.compiledAt)}
            disabled={!props.canEdit}
            onChange={(e) => {
              const ms = fromInputDate(e.target.value);
              if (!ms) return;
              scheduleSave({ ...payload, compiledAt: ms });
            }}
          />

          <div style={{ color: '#6b7280' }}>Статус</div>
          <div style={{ fontWeight: 700 }}>{statusLabel(payload.status)}</div>

          <div style={{ color: '#6b7280' }}>Описание</div>
          <Input
            value={payload.title}
            disabled={!props.canEdit}
            onChange={(e) => scheduleSave({ ...payload, title: e.target.value })}
            onBlur={() => void saveNow(payload)}
            placeholder="Краткое описание заявки…"
          />

          <div style={{ color: '#6b7280' }}>Подразделение</div>
          {props.canViewMasterData ? (
            <select
              value={payload.departmentId}
              disabled={!props.canEdit}
              onFocus={() => {
                if (!linkLists.departmentId) void loadLinkLists();
              }}
              onChange={(e) => scheduleSave({ ...payload, departmentId: e.target.value })}
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
            >
              <option value="">(не выбрано)</option>
              {(linkLists.departmentId ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <Input value={payload.departmentId} disabled />
          )}

          <div style={{ color: '#6b7280' }}>Цех</div>
          {props.canViewMasterData ? (
            <select
              value={payload.workshopId ?? ''}
              disabled={!props.canEdit}
              onFocus={() => {
                if (!linkLists.workshopId) void loadLinkLists();
              }}
              onChange={(e) => scheduleSave({ ...payload, workshopId: e.target.value || null })}
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
            >
              <option value="">(не выбрано)</option>
              {(linkLists.workshopId ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <Input value={payload.workshopId ?? ''} disabled />
          )}

          <div style={{ color: '#6b7280' }}>Участок</div>
          {props.canViewMasterData ? (
            <select
              value={payload.sectionId ?? ''}
              disabled={!props.canEdit}
              onFocus={() => {
                if (!linkLists.sectionId) void loadLinkLists();
              }}
              onChange={(e) => scheduleSave({ ...payload, sectionId: e.target.value || null })}
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
            >
              <option value="">(не выбрано)</option>
              {(linkLists.sectionId ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <Input value={payload.sectionId ?? ''} disabled />
          )}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {canTransitionSign && (
            <Button
              onClick={async () => {
                const r = await window.matrica.supplyRequests.transition({ id: props.id, action: 'sign' });
                if (!r.ok) {
                  setSaveStatus(`Ошибка: ${r.error}`);
                  return;
                }
                setPayload(r.payload);
              }}
            >
              Подписать (начальник)
            </Button>
          )}
          {canTransitionApprove && (
            <Button
              onClick={async () => {
                const r = await window.matrica.supplyRequests.transition({ id: props.id, action: 'director_approve' });
                if (!r.ok) {
                  setSaveStatus(`Ошибка: ${r.error}`);
                  return;
                }
                setPayload(r.payload);
              }}
            >
              Одобрить (директор)
            </Button>
          )}
          {canTransitionAccept && (
            <Button
              onClick={async () => {
                const r = await window.matrica.supplyRequests.transition({ id: props.id, action: 'accept' });
                if (!r.ok) {
                  setSaveStatus(`Ошибка: ${r.error}`);
                  return;
                }
                setPayload(r.payload);
              }}
            >
              Принять к исполнению (снабжение)
            </Button>
          )}
          {canTransitionFulfill && (
            <>
              <Button
                onClick={async () => {
                  const r = await window.matrica.supplyRequests.transition({ id: props.id, action: 'fulfill_full' });
                  if (!r.ok) {
                    setSaveStatus(`Ошибка: ${r.error}`);
                    return;
                  }
                  setPayload(r.payload);
                }}
              >
                Исполнена полностью
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  const r = await window.matrica.supplyRequests.transition({ id: props.id, action: 'fulfill_partial' });
                  if (!r.ok) {
                    setSaveStatus(`Ошибка: ${r.error}`);
                    return;
                  }
                  setPayload(r.payload);
                }}
              >
                Исполнена частично
              </Button>
            </>
          )}

          <div style={{ flex: 1 }} />
          {props.canEdit && <div style={{ color: '#64748b', fontSize: 12 }}>Автосохранение: изменения сохраняются автоматически.</div>}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <h2 style={{ margin: '8px 0' }}>Список товаров</h2>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
          <div style={{ flex: 1, color: '#6b7280' }}>
            Позиции заявки: наименование, количество, единица, примечание, фактические поставки.
          </div>
          {props.canEdit && (
            <Button
              onClick={() => {
                const nextItem: SupplyRequestItem = {
                  lineNo: (payload.items?.length ?? 0) + 1,
                  name: '',
                  qty: 1,
                  unit: 'шт',
                  note: '',
                  deliveries: [],
                };
                scheduleSave({ ...payload, items: [...(payload.items ?? []), nextItem] });
              }}
            >
              Добавить позицию
            </Button>
          )}
        </div>

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'linear-gradient(135deg, #a21caf 0%, #7c3aed 120%)', color: '#fff' }}>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>№</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Наименование</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Кол-во</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Ед.</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Примечание</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Привезено</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Осталось</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }} />
              </tr>
            </thead>
            <tbody>
              {(payload.items ?? []).map((it, idx) => {
                const delivered = sumDelivered(it.deliveries);
                const remaining = Math.max(0, (Number(it.qty) || 0) - delivered);
                return (
                  <React.Fragment key={idx}>
                    <tr>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{idx + 1}</td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                        <Input
                          value={it.name}
                          disabled={!props.canEdit}
                          onChange={(e) => {
                            const items = [...(payload.items ?? [])];
                            items[idx] = { ...items[idx], name: e.target.value };
                            scheduleSave({ ...payload, items });
                          }}
                          placeholder="Наименование товара…"
                        />
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, width: 120 }}>
                        <Input
                          value={String(it.qty ?? '')}
                          disabled={!props.canEdit}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            const items = [...(payload.items ?? [])];
                            items[idx] = { ...items[idx], qty: Number.isFinite(n) ? n : 0 };
                            scheduleSave({ ...payload, items });
                          }}
                        />
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, width: 120 }}>
                        <Input
                          value={String(it.unit ?? '')}
                          disabled={!props.canEdit}
                          onChange={(e) => {
                            const items = [...(payload.items ?? [])];
                            items[idx] = { ...items[idx], unit: e.target.value };
                            scheduleSave({ ...payload, items });
                          }}
                        />
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                        <Input
                          value={String(it.note ?? '')}
                          disabled={!props.canEdit}
                          onChange={(e) => {
                            const items = [...(payload.items ?? [])];
                            items[idx] = { ...items[idx], note: e.target.value };
                            scheduleSave({ ...payload, items });
                          }}
                        />
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, width: 90 }}>{delivered}</td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, width: 90 }}>{remaining}</td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10, width: 210 }}>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <Button
                            variant="ghost"
                            onClick={() => setExpandedLine((v) => (v === idx ? null : idx))}
                          >
                            Поставки
                          </Button>
                          {props.canEdit && (
                            <Button
                              variant="ghost"
                              onClick={() => {
                                const items = [...(payload.items ?? [])];
                                items.splice(idx, 1);
                                const renum = items.map((x, i) => ({ ...x, lineNo: i + 1 }));
                                scheduleSave({ ...payload, items: renum });
                                setExpandedLine((v) => (v === idx ? null : v));
                              }}
                            >
                              Удалить
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {expandedLine === idx && (
                      <tr>
                        <td colSpan={8} style={{ padding: 12, background: '#f8fafc', borderBottom: '1px solid #f3f4f6' }}>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 10 }}>
                            <div style={{ fontWeight: 700 }}>Фактические поставки</div>
                            <div style={{ flex: 1 }} />
                            {props.canEdit && (
                              <Button
                                onClick={() => {
                                  const items = [...(payload.items ?? [])];
                                  const cur = items[idx];
                                  const deliveries = [...(cur.deliveries ?? [])];
                                  deliveries.push({ deliveredAt: Date.now(), qty: 0, note: '' });
                                  items[idx] = { ...cur, deliveries };
                                  scheduleSave({ ...payload, items });
                                }}
                              >
                                Добавить поставку
                              </Button>
                            )}
                          </div>

                          {(it.deliveries ?? []).length === 0 && <div style={{ color: '#6b7280' }}>Поставок пока нет.</div>}

                          {(it.deliveries ?? []).map((d, di) => (
                            <div
                              key={di}
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '160px 120px 1fr 120px',
                                gap: 10,
                                alignItems: 'center',
                                marginBottom: 8,
                              }}
                            >
                              <Input
                                type="date"
                                value={toInputDate(d.deliveredAt)}
                                disabled={!props.canEdit}
                                onChange={(e) => {
                                  const ms = fromInputDate(e.target.value);
                                  if (!ms) return;
                                  const items = [...(payload.items ?? [])];
                                  const cur = items[idx];
                                  const deliveries = [...(cur.deliveries ?? [])];
                                  deliveries[di] = { ...deliveries[di], deliveredAt: ms };
                                  items[idx] = { ...cur, deliveries };
                                  scheduleSave({ ...payload, items });
                                }}
                              />
                              <Input
                                value={String(d.qty ?? '')}
                                disabled={!props.canEdit}
                                onChange={(e) => {
                                  const n = Number(e.target.value);
                                  const items = [...(payload.items ?? [])];
                                  const cur = items[idx];
                                  const deliveries = [...(cur.deliveries ?? [])];
                                  deliveries[di] = { ...deliveries[di], qty: Number.isFinite(n) ? n : 0 };
                                  items[idx] = { ...cur, deliveries };
                                  scheduleSave({ ...payload, items });
                                }}
                              />
                              <Input
                                value={String(d.note ?? '')}
                                disabled={!props.canEdit}
                                onChange={(e) => {
                                  const items = [...(payload.items ?? [])];
                                  const cur = items[idx];
                                  const deliveries = [...(cur.deliveries ?? [])];
                                  deliveries[di] = { ...deliveries[di], note: e.target.value };
                                  items[idx] = { ...cur, deliveries };
                                  scheduleSave({ ...payload, items });
                                }}
                                placeholder="Примечание…"
                              />
                              {props.canEdit ? (
                                <Button
                                  variant="ghost"
                                  onClick={() => {
                                    const items = [...(payload.items ?? [])];
                                    const cur = items[idx];
                                    const deliveries = [...(cur.deliveries ?? [])];
                                    deliveries.splice(di, 1);
                                    items[idx] = { ...cur, deliveries };
                                    scheduleSave({ ...payload, items });
                                  }}
                                >
                                  Удалить
                                </Button>
                              ) : (
                                <div />
                              )}
                            </div>
                          ))}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}

              {(payload.items ?? []).length === 0 && (
                <tr>
                  <td style={{ padding: 12, color: '#6b7280' }} colSpan={8}>
                    Позиции не добавлены
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


