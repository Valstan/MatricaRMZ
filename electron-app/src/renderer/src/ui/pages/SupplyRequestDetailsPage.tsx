import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { SupplyRequestDelivery, SupplyRequestItem, SupplyRequestPayload } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { openPrintPreview } from '../utils/printPreview.js';

type LinkOpt = { id: string; label: string };

function normalizeForMatch(s: string) {
  return String(s ?? '').trim().toLowerCase();
}

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
      return 'Подписана начальником цеха';
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

function printSupplyRequest(
  p: SupplyRequestPayload,
  departmentLabel: string,
  workshopLabel: string,
  sectionLabel: string,
  mode: 'short' | 'full',
) {
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

      if (mode === 'short') {
        return `<tr>
  <td>${idx + 1}</td>
  <td>${escapeHtml(it.name ?? '')}</td>
  <td>${escapeHtml(String(it.qty ?? ''))}</td>
  <td>${escapeHtml(it.unit ?? '')}</td>
  <td>${escapeHtml(it.note ?? '')}</td>
</tr>`;
      }

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

  const headName = p.signedByHead?.username ?? '';
  const headAt = p.signedByHead?.signedAt ? new Date(p.signedByHead.signedAt).toLocaleString('ru-RU') : '';
  const dirName = p.approvedByDirector?.username ?? '';
  const dirAt = p.approvedByDirector?.signedAt ? new Date(p.approvedByDirector.signedAt).toLocaleString('ru-RU') : '';
  const supplyName = p.acceptedBySupply?.username ?? '';
  const supplyAt = p.acceptedBySupply?.signedAt ? new Date(p.acceptedBySupply.signedAt).toLocaleString('ru-RU') : '';

  const footer = `
  <div style="margin-top:18px;">
    <div><b>Подпись начальника цеха:</b> _______________ ([Ф.И.О начальника цеха или подразделения]) ${escapeHtml(headName)} ${escapeHtml(headAt)}</div>
    <div style="margin-top:8px;"><b>К исполнению. Подпись директора:</b> __________________ ([Ф.И.О директора завода или исполняющего обязанности директора]) ${escapeHtml(
      dirName,
    )} ${escapeHtml(dirAt)}</div>
    <div style="margin-top:8px;"><b>Принято снабжением:</b> _______________________ ([Ф.И.О начальника снабжения]) ${escapeHtml(supplyName)} ${escapeHtml(
      supplyAt,
    )}</div>
  </div>`;

  const mainHtml = `
    <div><b>Дата составления:</b> ${escapeHtml(new Date(p.compiledAt).toLocaleDateString('ru-RU'))}</div>
    <div><b>Статус:</b> ${escapeHtml(statusLabel(p.status))}</div>
    <div><b>Подразделение:</b> ${escapeHtml(departmentLabel || p.departmentId || '-')}</div>
    <div><b>Цех:</b> ${escapeHtml(workshopLabel || p.workshopId || '-')}</div>
    <div><b>Участок:</b> ${escapeHtml(sectionLabel || p.sectionId || '-')}</div>
    <div><b>Описание:</b> ${escapeHtml(p.title || '-')}</div>
  `;
  const headHtml =
    mode === 'short'
      ? `<tr>
  <th>№</th>
  <th>Наименование</th>
  <th>Кол-во</th>
  <th>Ед.</th>
  <th>Примечание</th>
</tr>`
      : `<tr>
  <th>№</th>
  <th>Наименование</th>
  <th>Кол-во</th>
  <th>Ед.</th>
  <th>Примечание</th>
  <th>Привезено</th>
  <th>Осталось</th>
  <th>Факт поставок</th>
</tr>`;
  const emptyRow =
    mode === 'short'
      ? '<tr><td colspan="5" class="muted">Нет позиций</td></tr>'
      : '<tr><td colspan="8" class="muted">Нет позиций</td></tr>';
  const itemsHtml = `<table>
  <thead>${headHtml}</thead>
  <tbody>${rowsHtml || emptyRow}</tbody>
</table>`;

  openPrintPreview({
    title: `Заявка ${p.requestNumber}`,
    subtitle: p.compiledAt ? `Дата: ${new Date(p.compiledAt).toLocaleDateString('ru-RU')}` : undefined,
    sections: [
      { id: 'main', title: 'Основное', html: mainHtml },
      { id: 'items', title: 'Позиции', html: itemsHtml },
      { id: 'sign', title: 'Подписи', html: footer },
    ],
  });
}

export function SupplyRequestDetailsPage(props: {
  id: string;
  canEdit: boolean;
  canSign: boolean;
  canApprove: boolean;
  canAccept: boolean;
  canFulfill: boolean;
  canPrint: boolean;
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [payload, setPayload] = useState<SupplyRequestPayload | null>(null);
  const [saveStatus, setSaveStatus] = useState<string>('');
  const [expandedLine, setExpandedLine] = useState<number | null>(null);

  const [linkLists, setLinkLists] = useState<Record<string, LinkOpt[]>>({});
  const typeIdByCode = useRef<Record<string, string>>({});
  const [productOptions, setProductOptions] = useState<Array<LinkOpt & { unit?: string }>>([]);

  const saveTimer = useRef<any>(null);
  const lastSavedJson = useRef<string>('');
  const initialSessionJson = useRef<string>('');
  const sessionHadChanges = useRef<boolean>(false);
  const payloadRef = useRef<SupplyRequestPayload | null>(null);
  const dragFromIdx = useRef<number | null>(null);

  async function load() {
    setSaveStatus('Загрузка…');
    const r = await window.matrica.supplyRequests.get(props.id);
    if (!r.ok) {
      setSaveStatus(`Ошибка: ${r.error}`);
      return;
    }
    setPayload(r.payload);
    payloadRef.current = r.payload;
    const json = JSON.stringify(r.payload);
    lastSavedJson.current = json;
    initialSessionJson.current = json;
    sessionHadChanges.current = false;
    setSaveStatus('');
  }

  async function loadLinkLists() {
    if (!props.canViewMasterData) return;
    const types = await window.matrica.admin.entityTypes.list();
    typeIdByCode.current = Object.fromEntries(types.map((t) => [String(t.code), String(t.id)]));
    const typeIdByCodeMap = new Map(types.map((t) => [t.code, t.id] as const));
    async function loadType(code: string, key: string) {
      const tid = typeIdByCodeMap.get(code);
      if (!tid) return;
      const rows = await window.matrica.admin.entities.listByEntityType(tid);
      const opts = rows.map((x) => ({ id: x.id, label: x.displayName ? `${x.displayName}` : x.id }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setLinkLists((p) => ({
        ...p,
        [key]: opts,
      }));
    }
    await loadType('department', 'departmentId');
    await loadType('workshop', 'workshopId');
    await loadType('section', 'sectionId');

    // Product suggestions (master-data)
    const productTid = typeIdByCode.get('product');
    if (productTid) {
      const rows = await window.matrica.admin.entities.listByEntityType(productTid);
      // For MVP: use displayName as label (entityService picks 'name' if present).
      // Unit can be fetched later by entity:get, keep empty for now to avoid heavy N+1 calls.
      setProductOptions(
        rows
          .map((r: any) => ({ id: String(r.id), label: String(r.displayName ?? ''), unit: '' }))
          .filter((x) => x.label.trim().length > 0),
      );
    } else {
      setProductOptions([]);
    }
  }

  useEffect(() => {
    void load();
    void loadLinkLists();
  }, [props.id]);

  useEffect(() => {
    if (!payload || productOptions.length === 0) return;
    let changed = false;
    const items = (payload.items ?? []).map((it) => {
      if (it.productId) return it;
      const match = productOptions.find((p) => normalizeForMatch(p.label) === normalizeForMatch(it.name));
      if (!match) return it;
      changed = true;
      return {
        ...it,
        productId: match.id,
        name: match.label,
        unit: it.unit || match.unit || '',
      };
    });
    if (changed || payload.version !== 2) scheduleSave({ ...payload, version: 2, items });
  }, [payload, productOptions]);

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const typeId = typeIdByCode.current[typeCode];
    if (!typeId) return null;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created.ok || !created.id) return null;
    const attrByType: Record<string, string> = {
      department: 'name',
      workshop: 'name',
      section: 'name',
    };
    const attr = attrByType[typeCode] ?? 'name';
    await window.matrica.admin.entities.setAttr(created.id, attr, label);
    await loadLinkLists();
    return created.id;
  }

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
    payloadRef.current = next;
    if (!props.canEdit) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const json = JSON.stringify(next);
      if (initialSessionJson.current && json !== initialSessionJson.current) sessionHadChanges.current = true;
      if (json === lastSavedJson.current) return;
      void saveNow(next);
    }, 450);
  }

  function diffSummaryRu(initial: any, cur: any): { fieldsChanged: string[]; summaryRu: string } {
    const fields: string[] = [];
    const push = (field: string, ru: string, a: any, b: any) => {
      const av = a == null ? '' : String(a);
      const bv = b == null ? '' : String(b);
      if (av !== bv) fields.push(ru);
    };
    push('title', 'Описание', initial?.title, cur?.title);
    push('status', 'Статус', initial?.status, cur?.status);
    push('departmentId', 'Подразделение', initial?.departmentId, cur?.departmentId);
    push('workshopId', 'Цех', initial?.workshopId, cur?.workshopId);
    push('sectionId', 'Участок', initial?.sectionId, cur?.sectionId);
    const itemsA = Array.isArray(initial?.items) ? initial.items : [];
    const itemsB = Array.isArray(cur?.items) ? cur.items : [];
    if (itemsA.length !== itemsB.length) fields.push('Позиции');
    const summaryRu = fields.length ? `Изменил: ${fields.join(', ')}` : 'Без изменений';
    return { fieldsChanged: fields, summaryRu };
  }

  async function auditEditDone(p: SupplyRequestPayload | null) {
    try {
      if (!p) return;
      if (!sessionHadChanges.current) return;
      const initial = initialSessionJson.current ? JSON.parse(initialSessionJson.current) : null;
      const diff = diffSummaryRu(initial, p);
      if (!diff.fieldsChanged.length) return;
      await window.matrica.audit.add({
        action: 'ui.supply_request.edit_done',
        entityId: String(p.operationId ?? props.id),
        tableName: 'operations',
        payload: {
          operationId: String(p.operationId ?? props.id),
          requestNumber: p.requestNumber,
          title: p.title ?? '',
          status: p.status,
          departmentId: p.departmentId ?? '',
          workshopId: p.workshopId ?? null,
          sectionId: p.sectionId ?? null,
          fieldsChanged: diff.fieldsChanged,
          summaryRu: diff.summaryRu,
        },
      });
      sessionHadChanges.current = false;
      initialSessionJson.current = JSON.stringify(p);
    } catch {
      // ignore audit failures
    }
  }

  useEffect(() => {
    return () => {
      void auditEditDone(payloadRef.current);
    };
  }, []);

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
        {props.canPrint && (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                printSupplyRequest(payload, departmentLabel, workshopLabel, sectionLabel, 'short');
              }}
            >
              Распечатать (кратко)
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                printSupplyRequest(payload, departmentLabel, workshopLabel, sectionLabel, 'full');
              }}
            >
              Распечатать (полно)
            </Button>
          </>
        )}
        <div style={{ flex: 1 }} />
        {saveStatus && <div style={{ color: saveStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{saveStatus}</div>}
        <Button variant="ghost" onClick={() => void load()}>
          Обновить
        </Button>
      </div>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 200px) 1fr', gap: 10 }}>
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
            <SearchSelectWithCreate
              value={payload.departmentId || null}
              options={linkLists.departmentId ?? []}
              disabled={!props.canEdit}
              canCreate={props.canEditMasterData}
              createLabel="Новое подразделение"
              onChange={(next) => scheduleSave({ ...payload, departmentId: next ?? '' })}
              onCreate={async (label) => createMasterDataItem('department', label)}
            />
          ) : (
            <Input value={payload.departmentId} disabled />
          )}

          <div style={{ color: '#6b7280' }}>Цех</div>
          {props.canViewMasterData ? (
            <SearchSelectWithCreate
              value={payload.workshopId ?? null}
              options={linkLists.workshopId ?? []}
              disabled={!props.canEdit}
              canCreate={props.canEditMasterData}
              createLabel="Новый цех"
              onChange={(next) => scheduleSave({ ...payload, workshopId: next ?? null })}
              onCreate={async (label) => createMasterDataItem('workshop', label)}
            />
          ) : (
            <Input value={payload.workshopId ?? ''} disabled />
          )}

          <div style={{ color: '#6b7280' }}>Участок</div>
          {props.canViewMasterData ? (
            <SearchSelectWithCreate
              value={payload.sectionId ?? null}
              options={linkLists.sectionId ?? []}
              disabled={!props.canEdit}
              canCreate={props.canEditMasterData}
              createLabel="Новый участок"
              onChange={(next) => scheduleSave({ ...payload, sectionId: next ?? null })}
              onCreate={async (label) => createMasterDataItem('section', label)}
            />
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
          <div style={{ flex: 1, color: '#6b7280' }}>Позиции заявки: наименование, количество, единица, примечание, фактические поставки.</div>
        </div>

        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'linear-gradient(135deg, #a21caf 0%, #7c3aed 120%)', color: '#fff' }}>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6, width: 34 }} />
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }}>№</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }}>Наименование</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }}>Кол-во</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }}>Ед.</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }}>Примечание</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }}>Привезено</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }}>Осталось</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 6 }} />
              </tr>
            </thead>
            <tbody>
              {(payload.items ?? []).map((it, idx) => {
                const delivered = sumDelivered(it.deliveries);
                const remaining = Math.max(0, (Number(it.qty) || 0) - delivered);
                return (
                  <React.Fragment key={idx}>
                    <tr
                      onDragOver={(e) => {
                        if (!props.canEdit) return;
                        e.preventDefault();
                      }}
                      onDrop={(e) => {
                        if (!props.canEdit) return;
                        e.preventDefault();
                        const from =
                          dragFromIdx.current ??
                          (() => {
                            try {
                              const raw = e.dataTransfer.getData('text/plain');
                              const n = Number(raw);
                              return Number.isFinite(n) ? n : null;
                            } catch {
                              return null;
                            }
                          })();
                        if (from == null) return;
                        const to = idx;
                        if (from === to) return;
                        const items = [...(payload.items ?? [])];
                        if (!items[from] || !items[to]) return;
                        const [moved] = items.splice(from, 1);
                        items.splice(to, 0, moved);
                        const renum = items.map((x, i) => ({ ...x, lineNo: i + 1 }));
                        scheduleSave({ ...payload, items: renum });
                      }}
                    >
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6, width: 34 }}>
                        <span
                          title="Перетащить строку"
                          draggable={props.canEdit}
                          onDragStart={(e) => {
                            if (!props.canEdit) return;
                            dragFromIdx.current = idx;
                            try {
                              e.dataTransfer.effectAllowed = 'move';
                              e.dataTransfer.setData('text/plain', String(idx));
                            } catch {
                              // ignore
                            }
                          }}
                          onDragEnd={() => {
                            dragFromIdx.current = null;
                          }}
                          style={{
                            cursor: props.canEdit ? 'grab' : 'default',
                            userSelect: 'none',
                            display: 'inline-block',
                            padding: '2px 6px',
                            borderRadius: 8,
                            border: '1px solid rgba(15,23,42,0.18)',
                            color: '#475569',
                            background: 'rgba(255,255,255,0.9)',
                            fontSize: 12,
                          }}
                        >
                          ⠿
                        </span>
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6 }}>{idx + 1}</td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6 }}>
                        <div style={{ display: 'grid', gap: 6 }}>
                          <SearchSelect
                            value={it.productId ?? ''}
                            options={productOptions}
                            disabled={!props.canEdit}
                            placeholder="Выберите товар…"
                            onChange={(next) => {
                              const items = [...(payload.items ?? [])];
                              const selected = productOptions.find((p) => p.id === next);
                              items[idx] = {
                                ...items[idx],
                                productId: next || null,
                                name: selected?.label ?? items[idx]?.name ?? '',
                                unit: selected?.unit ?? items[idx]?.unit ?? '',
                              };
                              scheduleSave({ ...payload, items });
                            }}
                          />
                          {!it.productId && it.name?.trim() && (
                            <span style={{ color: '#b91c1c', fontSize: 12 }}>Нет совпадения: {it.name}</span>
                          )}
                        </div>
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6, width: 110 }}>
                        <Input
                          type="number"
                          step={1}
                          inputMode="numeric"
                          value={String(it.qty ?? '')}
                          disabled={!props.canEdit}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            const items = [...(payload.items ?? [])];
                            items[idx] = { ...items[idx], qty: Number.isFinite(n) ? n : 0 };
                            scheduleSave({ ...payload, items });
                          }}
                          style={{ padding: '6px 8px', borderRadius: 10, boxShadow: 'none' }}
                        />
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6, width: 110 }}>
                        <Input value={String(it.unit ?? '')} disabled style={{ padding: '6px 8px', borderRadius: 10, boxShadow: 'none' }} />
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6 }}>
                        <Input
                          value={String(it.note ?? '')}
                          disabled={!props.canEdit}
                          onChange={(e) => {
                            const items = [...(payload.items ?? [])];
                            items[idx] = { ...items[idx], note: e.target.value };
                            scheduleSave({ ...payload, items });
                          }}
                          style={{ padding: '6px 8px', borderRadius: 10, boxShadow: 'none' }}
                        />
                      </td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6, width: 86 }}>{delivered}</td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6, width: 86 }}>{remaining}</td>
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6, width: 210 }}>
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
                        <td colSpan={9} style={{ padding: 10, background: '#f8fafc', borderBottom: '1px solid #f3f4f6' }}>
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
                                marginBottom: 6,
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
                                style={{ padding: '6px 8px', borderRadius: 10, boxShadow: 'none' }}
                              />
                              <Input
                                type="number"
                                step={1}
                                inputMode="numeric"
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
                                style={{ padding: '6px 8px', borderRadius: 10, boxShadow: 'none' }}
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
                                style={{ padding: '6px 8px', borderRadius: 10, boxShadow: 'none' }}
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

        {props.canEdit && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
            <div style={{ flex: 1 }} />
            <Button
              onClick={() => {
                const nextItem: SupplyRequestItem = {
                  lineNo: (payload.items?.length ?? 0) + 1,
                  productId: null,
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
          </div>
        )}
      </div>

      <AttachmentsPanel
        title="Вложения к заявке"
        value={payload.attachments}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEdit}
        onChange={async (next) => {
          scheduleSave({ ...payload, attachments: next });
          await saveNow({ ...payload, attachments: next });
          return { ok: true as const };
        }}
      />
    </div>
  );
}


