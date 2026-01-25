import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { SupplyRequestDelivery, SupplyRequestItem, SupplyRequestPayload } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { openPrintPreview } from '../utils/printPreview.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';

type LinkOpt = { id: string; label: string };

const UI_TYPE_CODE = 'ui_supply_request';

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

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
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
  mode: 'short' | 'full',
  orderedRows?: Array<[string, string]>,
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

  const mainHtml =
    orderedRows && orderedRows.length > 0
      ? keyValueTable(orderedRows)
      : `
        <div><b>Дата составления:</b> ${escapeHtml(new Date(p.compiledAt).toLocaleDateString('ru-RU'))}</div>
        <div><b>Статус:</b> ${escapeHtml(statusLabel(p.status))}</div>
        <div><b>Подразделение:</b> ${escapeHtml(departmentLabel || p.departmentId || '-')}</div>
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
  const [productOptions, setProductOptions] = useState<Array<LinkOpt & { unit?: string; name: string; kind: 'product' | 'service' }>>([]);
  const [unitOptions, setUnitOptions] = useState<LinkOpt[]>([]);
  const [uiTypeId, setUiTypeId] = useState<string>('');
  const [uiDefs, setUiDefs] = useState<AttributeDefRow[]>([]);
  const [coreDefsReady, setCoreDefsReady] = useState(false);

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
    let uiTypeId = typeIdByCodeMap.get(UI_TYPE_CODE) ?? '';
    if (!uiTypeId && props.canEditMasterData) {
      const created = await window.matrica.admin.entityTypes.upsert({ code: UI_TYPE_CODE, name: 'UI: Заявка в снабжение' });
      if (created?.ok && created?.id) uiTypeId = String(created.id);
    }
    if (uiTypeId) {
      setUiTypeId(String(uiTypeId));
      const defs = await window.matrica.admin.attributeDefs.listByEntityType(String(uiTypeId));
      setUiDefs(defs as AttributeDefRow[]);
      setCoreDefsReady(false);
    }
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

    // Product suggestions (master-data)
    const productTid = typeIdByCodeMap.get('product');
    const serviceTid = typeIdByCodeMap.get('service');
    const items: Array<LinkOpt & { unit?: string; name: string; kind: 'product' | 'service' }> = [];
    if (productTid) {
      const rows = await window.matrica.admin.entities.listByEntityType(productTid);
      rows.forEach((r: any) => {
        const name = String(r.displayName ?? '').trim();
        if (!name) return;
        items.push({ id: String(r.id), label: name, name, unit: '', kind: 'product' });
      });
    }
    if (serviceTid) {
      const rows = await window.matrica.admin.entities.listByEntityType(serviceTid);
      rows.forEach((r: any) => {
        const name = String(r.displayName ?? '').trim();
        if (!name) return;
        items.push({ id: String(r.id), label: `${name} (услуга)`, name, unit: '', kind: 'service' });
      });
    }
    items.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
    setProductOptions(items);

    const unitTypeId = typeIdByCodeMap.get('unit');
    if (unitTypeId) {
      const rows = await window.matrica.admin.entities.listByEntityType(String(unitTypeId));
      const opts = (rows as any[]).map((r) => ({ id: String(r.id), label: String(r.displayName ?? r.id) }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setUnitOptions(opts);
    } else {
      setUnitOptions([]);
    }
  }

  useEffect(() => {
    void load();
    void loadLinkLists();
  }, [props.id]);

  useEffect(() => {
    if (!props.canEditMasterData || !uiTypeId || uiDefs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'request_number', name: 'Номер заявки', dataType: 'text', sortOrder: 10 },
      { code: 'compiled_at', name: 'Дата составления', dataType: 'date', sortOrder: 20 },
      { code: 'status', name: 'Статус', dataType: 'text', sortOrder: 30 },
      { code: 'title', name: 'Описание', dataType: 'text', sortOrder: 40 },
      { code: 'department_id', name: 'Подразделение', dataType: 'link', sortOrder: 50, metaJson: JSON.stringify({ linkTargetTypeCode: 'department' }) },
    ];
    void ensureAttributeDefs(uiTypeId, desired, uiDefs).then((next) => {
      if (next.length !== uiDefs.length) setUiDefs(next);
      setCoreDefsReady(true);
    });
  }, [props.canEditMasterData, uiTypeId, uiDefs.length, coreDefsReady]);

  useEffect(() => {
    if (!payload || productOptions.length === 0) return;
    let changed = false;
    const items = (payload.items ?? []).map((it) => {
      if (it.productId) return it;
      const match = productOptions.find((p) => normalizeForMatch(p.name) === normalizeForMatch(it.name));
      if (!match) return it;
      changed = true;
      return {
        ...it,
        productId: match.id,
        name: match.name,
        unit: it.unit || match.unit || '',
      };
    });
    if (changed || payload.version !== 2) scheduleSave({ ...payload, version: 2, items });
  }, [payload, productOptions]);

  async function enrichUnitIfMissing(optionId: string) {
    const opt = productOptions.find((p) => p.id === optionId);
    if (!opt || (opt.unit && opt.unit.trim())) return opt;
    try {
      const details = await window.matrica.admin.entities.get(optionId);
      const unit = String(details?.attributes?.unit ?? '').trim();
      if (!unit) return opt;
      const nextOptions = productOptions.map((p) => (p.id === optionId ? { ...p, unit } : p));
      setProductOptions(nextOptions);
      return { ...opt, unit };
    } catch {
      return opt;
    }
  }

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const typeId = typeIdByCode.current[typeCode];
    if (!typeId) return null;
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created.ok || !created.id) return null;
    const attrByType: Record<string, string> = {
      department: 'name',
      product: 'name',
      service: 'name',
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
  if (!payload) {
    return <div style={{ color: '#6b7280' }}>{saveStatus || '...'}</div>;
  }

  const canTransitionSign = props.canSign && payload.status === 'draft';
  const canTransitionApprove = props.canApprove && payload.status === 'signed';
  const canTransitionAccept = props.canAccept && payload.status === 'director_approved';
  const canTransitionFulfill = props.canFulfill && payload.status === 'accepted';

  const mainFields = orderFieldsByDefs(
    [
      {
        code: 'request_number',
        defaultOrder: 10,
        label: 'Номер заявки',
        value: payload.requestNumber,
        render: <div style={{ fontWeight: 700 }}>{payload.requestNumber}</div>,
      },
      {
        code: 'compiled_at',
        defaultOrder: 20,
        label: 'Дата составления',
        value: toInputDate(payload.compiledAt),
        render: (
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
        ),
      },
      {
        code: 'status',
        defaultOrder: 30,
        label: 'Статус',
        value: statusLabel(payload.status),
        render: <div style={{ fontWeight: 700 }}>{statusLabel(payload.status)}</div>,
      },
      {
        code: 'title',
        defaultOrder: 40,
        label: 'Описание',
        value: payload.title ?? '',
        render: (
          <Input
            value={payload.title}
            disabled={!props.canEdit}
            onChange={(e) => scheduleSave({ ...payload, title: e.target.value })}
            onBlur={() => void saveNow(payload)}
            placeholder="Краткое описание заявки…"
          />
        ),
      },
      {
        code: 'department_id',
        defaultOrder: 50,
        label: 'Подразделение',
        value: departmentLabel || payload.departmentId || '',
        render: props.canViewMasterData ? (
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
        ),
      },
    ],
    uiDefs,
  );
  const orderedPrintRows = mainFields.map((f) => [f.label, String(f.value ?? '')] as [string, string]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {props.canPrint && (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                printSupplyRequest(payload, departmentLabel, 'short', orderedPrintRows);
              }}
            >
              Распечатать (кратко)
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                printSupplyRequest(payload, departmentLabel, 'full', orderedPrintRows);
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
        <DraggableFieldList
          items={mainFields}
          getKey={(f) => f.code}
          canDrag={props.canEditMasterData}
          onReorder={(next) => {
            if (!uiTypeId) return;
            void persistFieldOrder(
              next.map((f) => f.code),
              uiDefs,
              { entityTypeId: uiTypeId },
            ).then(() => setUiDefs([...uiDefs]));
          }}
          renderItem={(field, dragHandleProps, state) => (
            <div
              {...dragHandleProps}
              style={{
                ...dragHandleProps.style,
                display: 'grid',
                gridTemplateColumns: 'minmax(150px, 200px) 1fr',
                gap: 10,
                alignItems: 'center',
                padding: '6px 8px',
                borderRadius: 8,
                border: state.isOver ? '1px dashed #93c5fd' : '1px solid transparent',
                background: state.isDragging ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
              }}
            >
              <div style={{ color: '#6b7280' }}>{field.label}</div>
              {field.render}
            </div>
          )}
        />

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
                          <SearchSelectWithCreate
                            value={it.productId ?? ''}
                            options={productOptions}
                            disabled={!props.canEdit}
                            canCreate={props.canEditMasterData}
                            createLabel="Добавить товар или услугу"
                            onChange={(next) => {
                              const items = [...(payload.items ?? [])];
                              const selected = productOptions.find((p) => p.id === next);
                              items[idx] = {
                                ...items[idx],
                                productId: next || null,
                                name: selected?.name ?? items[idx]?.name ?? '',
                                unit: selected?.unit ?? items[idx]?.unit ?? '',
                              };
                              scheduleSave({ ...payload, items });
                              if (next) {
                                void (async () => {
                                  const enriched = await enrichUnitIfMissing(next);
                                  if (!enriched?.unit) return;
                                  const updated = [...(payload.items ?? [])];
                                  updated[idx] = { ...updated[idx], unit: enriched.unit };
                                  scheduleSave({ ...payload, items: updated });
                                })();
                              }
                            }}
                            onCreate={async (label) => {
                              const name = label.trim();
                              if (!name) return null;
                              const isService = confirm('Создать как услугу? (OK = услуга, Отмена = товар)');
                              const typeCode = isService ? 'service' : 'product';
                              const id = await createMasterDataItem(typeCode, name);
                              if (!id) return null;
                              const nextOptions = [...productOptions];
                              nextOptions.push({
                                id,
                                name,
                                label: isService ? `${name} (услуга)` : name,
                                unit: '',
                                kind: isService ? 'service' : 'product',
                              });
                              nextOptions.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
                              setProductOptions(nextOptions);
                              const items = [...(payload.items ?? [])];
                              items[idx] = {
                                ...items[idx],
                                productId: id,
                                name,
                                unit: items[idx]?.unit ?? '',
                              };
                              scheduleSave({ ...payload, items });
                              return id;
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
                      <td style={{ borderBottom: '1px solid #f3f4f6', padding: 6, width: 160 }}>
                        <SearchSelect
                          value={unitOptions.find((o) => o.label === String(it.unit ?? ''))?.id ?? null}
                          options={unitOptions}
                          disabled={!props.canEdit}
                          placeholder="Ед. измерения"
                          onChange={(next) => {
                            const label = unitOptions.find((o) => o.id === next)?.label ?? '';
                            const items = [...(payload.items ?? [])];
                            items[idx] = { ...items[idx], unit: label };
                            scheduleSave({ ...payload, items });
                          }}
                        />
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


