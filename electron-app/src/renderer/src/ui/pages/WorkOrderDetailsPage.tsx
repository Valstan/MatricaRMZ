import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkOrderPayload, WorkOrderWorkLine } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import type { CardCloseActions } from '../cardCloseTypes.js';

type LinkOpt = { id: string; label: string };
type ServiceInfo = { id: string; name: string; unit: string; priceRub: number };
type EmployeeInfo = { id: string; displayName: string };
type PartInfo = { id: string; label: string };

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
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function money(v: number) {
  return `${Math.round((Number(v) || 0) * 100) / 100} ₽`;
}

function safeNum(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function recalcLocally(payload: WorkOrderPayload): WorkOrderPayload {
  const works = (payload.works ?? []).map((line, idx) => {
    const qty = Math.max(0, safeNum(line.qty, 0));
    const priceRub = Math.max(0, safeNum(line.priceRub, 0));
    const amountRub = Math.round(qty * priceRub * 100) / 100;
    return { ...line, lineNo: idx + 1, qty, priceRub, amountRub };
  });
  const totalAmountRub = Math.round(works.reduce((acc, x) => acc + safeNum(x.amountRub, 0), 0) * 100) / 100;
  const crew = (payload.crew ?? []).map((c) => ({ ...c, ktu: Math.max(0.01, safeNum(c.ktu, 1)) }));
  const basePerWorkerRub = crew.length > 0 ? Math.round((totalAmountRub / crew.length) * 100) / 100 : 0;
  const payouts = crew.map((c) => ({
    employeeId: c.employeeId,
    employeeName: c.employeeName,
    ktu: c.ktu,
    amountRub: Math.round(basePerWorkerRub * c.ktu * 100) / 100,
  }));
  return {
    ...payload,
    works,
    crew: crew.map((c) => {
      const p = payouts.find((x) => x.employeeId === c.employeeId);
      return { ...c, payoutRub: p?.amountRub ?? 0 };
    }),
    totalAmountRub,
    basePerWorkerRub,
    payouts,
  };
}

export function WorkOrderDetailsPage(props: {
  id: string;
  onClose: () => void;
  canEdit: boolean;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
  requestClose?: () => void;
}) {
  const [payload, setPayload] = useState<WorkOrderPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [services, setServices] = useState<ServiceInfo[]>([]);
  const [employees, setEmployees] = useState<EmployeeInfo[]>([]);
  const [parts, setParts] = useState<PartInfo[]>([]);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        if (payload && props.canEdit) {
          await flushSave(payload);
        }
        dirtyRef.current = false;
      },
      reset: async () => {
        await refresh();
        dirtyRef.current = false;
      },
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      copyToNew: async () => {
        const r = await window.matrica.workOrders.create();
        if (r?.ok && r.id && payload) {
          await window.matrica.workOrders.update({
            id: r.id,
            payload: { ...payload, workOrderNumber: 0 },
          });
        }
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [payload, props.registerCardCloseActions, props.id]);

  const serviceOptions: LinkOpt[] = useMemo(() => services.map((s) => ({ id: s.id, label: `${s.name} (${s.unit || 'ед.'}, ${money(s.priceRub)})` })), [services]);
  const employeeOptions: LinkOpt[] = useMemo(() => employees.map((e) => ({ id: e.id, label: e.displayName })), [employees]);
  const partOptions: LinkOpt[] = useMemo(() => parts.map((p) => ({ id: p.id, label: p.label })), [parts]);

  async function loadRefs() {
    try {
      const [emps, partRes] = await Promise.all([
        window.matrica.employees.list().catch(() => [] as any[]),
        window.matrica.parts.list({ limit: 2000 }).catch(() => ({ ok: false as const, parts: [] as any[] })),
      ]);
      setEmployees((emps as any[]).map((x) => ({ id: String(x.id), displayName: String(x.displayName || x.fullName || x.id) })));
      setParts(
        (partRes.ok ? partRes.parts : []).map((p: any) => ({
          id: String(p.id),
          label: String(p.name || p.article || p.id),
        })),
      );

      const et = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
      const serviceType = (et as any[]).find((x) => String(x.code) === 'service');
      if (!serviceType?.id) {
        setServices([]);
        return;
      }
      const list = await window.matrica.admin.entities.listByEntityType(String(serviceType.id)).catch(() => [] as any[]);
      const details = await Promise.all(
        (list as any[]).slice(0, 2000).map(async (row) => {
          const d = await window.matrica.admin.entities.get(String(row.id)).catch(() => null);
          const attrs = (d as any)?.attributes ?? {};
          return {
            id: String(row.id),
            name: String(attrs.name || row.displayName || row.id),
            unit: String(attrs.unit || 'шт'),
            priceRub: Math.max(0, safeNum(attrs.price, 0)),
          } as ServiceInfo;
        }),
      );
      setServices(details.filter((x) => x.name.trim().length > 0));
    } catch {
      setServices([]);
      setEmployees([]);
      setParts([]);
    }
  }

  async function refresh() {
    setLoading(true);
    const r = await window.matrica.workOrders.get(props.id);
    if (!r.ok) {
      setStatus(`Ошибка загрузки: ${r.error}`);
      setPayload(null);
      setLoading(false);
      return;
    }
    setPayload(recalcLocally(r.payload));
    setStatus('');
    setLoading(false);
    dirtyRef.current = false;
  }

  useEffect(() => {
    void Promise.all([refresh(), loadRefs()]);
  }, [props.id]);

  async function flushSave(next: WorkOrderPayload) {
    if (!props.canEdit) return;
    const r = await window.matrica.workOrders.update({ id: props.id, payload: recalcLocally(next) });
    if (!r.ok) {
      setStatus(`Ошибка сохранения: ${r.error}`);
      return;
    }
    setStatus('Сохранено');
    dirtyRef.current = false;
  }

  function patch(next: WorkOrderPayload) {
    const normalized = recalcLocally(next);
    dirtyRef.current = true;
    setPayload(normalized);
  }

  async function applyServiceSnapshot(idx: number, serviceId: string | null) {
    if (!payload) return;
    const line = payload.works[idx];
    if (!line) return;
    if (!serviceId) {
      const works = payload.works.map((x, i) => (i === idx ? { ...x, serviceId: null, serviceName: '', unit: '', priceRub: 0 } : x));
      patch({ ...payload, works });
      return;
    }
    const svc = services.find((s) => s.id === serviceId);
    if (!svc) return;
    const works = payload.works.map((x, i) =>
      i === idx
        ? {
            ...x,
            serviceId,
            serviceName: svc.name,
            unit: svc.unit,
            priceRub: svc.priceRub,
          }
        : x,
    );
    patch({ ...payload, works });
  }

  if (loading) return <div style={{ color: 'var(--muted)' }}>Загрузка…</div>;
  if (!payload) return <div style={{ color: 'var(--danger)' }}>{status || 'Карточка наряда недоступна'}</div>;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ borderBottom: '1px solid var(--border)', marginBottom: 4 }}>
        <CardActionBar
          canEdit={props.canEdit}
          onCopyToNew={() => {
            void (async () => {
              const r = await window.matrica.workOrders.create();
              if (r?.ok && r.id && payload) {
                await window.matrica.workOrders.update({
                  id: r.id,
                  payload: { ...payload, workOrderNumber: 0 },
                });
              }
            })();
          }}
          onSaveAndClose={() => {
            void (async () => {
              if (payload && props.canEdit) await flushSave(payload);
              dirtyRef.current = false;
              props.onClose();
            })();
          }}
          onReset={() => {
            void refresh().then(() => {
              dirtyRef.current = false;
            });
          }}
          onCloseWithoutSave={() => {
            dirtyRef.current = false;
            props.onClose();
          }}
          onClose={() => props.requestClose?.()}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700 }}>Наряд №{payload.workOrderNumber}</div>
        <div style={{ color: 'var(--muted)' }}>Итог: {money(payload.totalAmountRub)}</div>
        <div style={{ color: 'var(--muted)' }}>База на человека: {money(payload.basePerWorkerRub)}</div>
        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--muted)' }}>{status}</div> : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr 220px 1fr', gap: 8, alignItems: 'center' }}>
        <div style={{ color: 'var(--muted)' }}>Дата наряда</div>
        <Input
          type="date"
          value={toInputDate(payload.orderDate)}
          disabled={!props.canEdit}
          onChange={(e) => patch({ ...payload, orderDate: fromInputDate(e.target.value) ?? payload.orderDate })}
        />
        <div style={{ color: 'var(--muted)' }}>Изделие</div>
        <SearchSelect
          value={payload.partId}
          options={partOptions}
          disabled={!props.canEdit}
          onChange={(next) => {
            const p = parts.find((x) => x.id === next);
            patch({ ...payload, partId: p?.id ?? null, partName: p?.label ?? '' });
          }}
          placeholder="Выберите деталь"
        />
      </div>

      <div style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: 10, background: 'var(--surface2)', fontWeight: 700 }}>Работы в наряде</div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 8 }}>Услуга</th>
              <th style={{ textAlign: 'left', padding: 8, width: 110 }}>Кол-во</th>
              <th style={{ textAlign: 'left', padding: 8, width: 130 }}>Ед.</th>
              <th style={{ textAlign: 'left', padding: 8, width: 140 }}>Цена</th>
              <th style={{ textAlign: 'left', padding: 8, width: 140 }}>Сумма</th>
              {props.canEdit && <th style={{ textAlign: 'left', padding: 8, width: 90 }}>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {payload.works.map((line, idx) => (
              <tr key={`work-line-${idx}`}>
                <td style={{ padding: 8 }}>
                  <SearchSelect
                    value={line.serviceId}
                    options={serviceOptions}
                    disabled={!props.canEdit}
                    onChange={(next) => void applyServiceSnapshot(idx, next)}
                    placeholder="Выберите услугу"
                  />
                </td>
                <td style={{ padding: 8 }}>
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={String(line.qty ?? 0)}
                    disabled={!props.canEdit}
                    onChange={(e) => {
                      const works = payload.works.map((x, i) => (i === idx ? ({ ...x, qty: safeNum(e.target.value, 0) } as WorkOrderWorkLine) : x));
                      patch({ ...payload, works });
                    }}
                  />
                </td>
                <td style={{ padding: 8 }}>
                  <Input value={line.unit || ''} disabled />
                </td>
                <td style={{ padding: 8 }}>
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={String(line.priceRub ?? 0)}
                    disabled={!props.canEdit}
                    onChange={(e) => {
                      const works = payload.works.map((x, i) => (i === idx ? ({ ...x, priceRub: safeNum(e.target.value, 0) } as WorkOrderWorkLine) : x));
                      patch({ ...payload, works });
                    }}
                  />
                </td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{money(line.amountRub ?? 0)}</td>
                {props.canEdit && (
                  <td style={{ padding: 8 }}>
                    <Button variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => patch({ ...payload, works: payload.works.filter((_, i) => i !== idx) })}>
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {payload.works.length === 0 && (
              <tr>
                <td colSpan={props.canEdit ? 6 : 5} style={{ padding: 10, color: 'var(--muted)' }}>Работы не добавлены</td>
              </tr>
            )}
          </tbody>
        </table>
        {props.canEdit && (
          <div style={{ padding: 8 }}>
            <Button
              variant="ghost"
              onClick={() =>
                patch({
                  ...payload,
                  works: [
                    ...payload.works,
                    { lineNo: payload.works.length + 1, serviceId: null, serviceName: '', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0 },
                  ],
                })
              }
            >
              + Добавить работу
            </Button>
          </div>
        )}
      </div>

      <div style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: 10, background: 'var(--surface2)', fontWeight: 700 }}>Состав бригады и КТУ</div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 8 }}>Сотрудник</th>
              <th style={{ textAlign: 'left', padding: 8, width: 130 }}>КТУ</th>
              <th style={{ textAlign: 'left', padding: 8, width: 180 }}>Выплата</th>
              {props.canEdit && <th style={{ textAlign: 'left', padding: 8, width: 90 }}>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {payload.crew.map((member, idx) => (
              <tr key={`crew-${idx}-${member.employeeId}`}>
                <td style={{ padding: 8 }}>
                  <SearchSelect
                    value={member.employeeId || null}
                    options={employeeOptions}
                    disabled={!props.canEdit}
                    onChange={(next) => {
                      const e = employees.find((x) => x.id === next);
                      const crew = payload.crew.map((c, i) => (i === idx ? { ...c, employeeId: e?.id || '', employeeName: e?.displayName || '' } : c));
                      patch({ ...payload, crew });
                    }}
                    placeholder="Выберите сотрудника"
                  />
                </td>
                <td style={{ padding: 8 }}>
                  <Input
                    type="number"
                    min={0.01}
                    step="0.01"
                    value={String(member.ktu ?? 1)}
                    disabled={!props.canEdit}
                    onChange={(e) => {
                      const crew = payload.crew.map((c, i) => (i === idx ? { ...c, ktu: Math.max(0.01, safeNum(e.target.value, 1)) } : c));
                      patch({ ...payload, crew });
                    }}
                  />
                </td>
                <td style={{ padding: 8 }}>{money(member.payoutRub ?? 0)}</td>
                {props.canEdit && (
                  <td style={{ padding: 8 }}>
                    <Button variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => patch({ ...payload, crew: payload.crew.filter((_, i) => i !== idx) })}>
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {payload.crew.length === 0 && (
              <tr>
                <td colSpan={props.canEdit ? 4 : 3} style={{ padding: 10, color: 'var(--muted)' }}>Состав бригады пуст</td>
              </tr>
            )}
          </tbody>
        </table>
        {props.canEdit && (
          <div style={{ padding: 8 }}>
            <Button variant="ghost" onClick={() => patch({ ...payload, crew: [...payload.crew, { employeeId: '', employeeName: '', ktu: 1 }] })}>
              + Добавить сотрудника
            </Button>
          </div>
        )}
      </div>

      {props.canEdit && (
        <div style={{ display: 'flex', gap: 8 }}>
          <Button onClick={() => void flushSave(payload)}>Сохранить сейчас</Button>
          <Button
            variant="ghost"
            style={{ color: 'var(--danger)' }}
            onClick={async () => {
              if (!confirm('Удалить наряд?')) return;
              const r = await window.matrica.workOrders.delete(props.id);
              if (!r.ok) {
                setStatus(`Ошибка удаления: ${r.error}`);
                return;
              }
              props.onClose();
            }}
          >
            Удалить наряд
          </Button>
        </div>
      )}
    </div>
  );
}

