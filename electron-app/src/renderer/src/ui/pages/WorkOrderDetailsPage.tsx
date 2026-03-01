import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkOrderPayload, WorkOrderWorkGroup, WorkOrderWorkLine } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { Input } from '../components/Input.js';
import { SearchSelect } from '../components/SearchSelect.js';
import type { CardCloseActions } from '../cardCloseTypes.js';

type LinkOpt = { id: string; label: string };
type ServiceInfo = { id: string; name: string; unit: string; priceRub: number; partIds: string[] };
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

function toCents(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100);
}

function fromCents(value: number): number {
  return Math.round(value) / 100;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((x) => String(x || '').trim()).filter((x) => x.length > 0);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x || '').trim()).filter((x) => x.length > 0);
    } catch {
      // ignore invalid JSON
    }
  }
  return [];
}

function normalizeLine(line: any, lineNo: number): WorkOrderWorkLine {
  const qty = Math.max(0, safeNum(line?.qty, 0));
  const priceRub = Math.max(0, safeNum(line?.priceRub, 0));
  return {
    lineNo,
    serviceId: line?.serviceId ? String(line.serviceId) : null,
    serviceName: String(line?.serviceName ?? ''),
    unit: String(line?.unit ?? ''),
    qty,
    priceRub,
    amountRub: fromCents(toCents(qty * priceRub)),
  };
}

function distributeByKtu(
  totalAmountRub: number,
  crew: Array<{ ktu: number; payoutFrozen: boolean; manualPayoutRub: number }>,
): number[] {
  const totalCents = toCents(Math.max(0, safeNum(totalAmountRub, 0)));
  const frozenCentsByIndex = crew.map((member) => (member.payoutFrozen ? toCents(Math.max(0, safeNum(member.manualPayoutRub, 0))) : 0));
  const frozenTotalCents = frozenCentsByIndex.reduce((acc, value) => acc + value, 0);
  const remainingCents = Math.max(0, totalCents - frozenTotalCents);

  const unfrozen = crew
    .map((member, index) => ({ index, ktu: Math.max(0.01, safeNum(member.ktu, 1)), frozen: member.payoutFrozen }))
    .filter((entry) => !entry.frozen);
  const totalKtu = unfrozen.reduce((acc, entry) => acc + entry.ktu, 0);

  const payoutsCents = [...frozenCentsByIndex];
  if (unfrozen.length === 0 || totalKtu <= 0 || remainingCents <= 0) {
    for (const entry of unfrozen) payoutsCents[entry.index] = 0;
    return payoutsCents.map(fromCents);
  }

  const weighted = unfrozen.map((entry) => {
    const raw = (remainingCents * entry.ktu) / totalKtu;
    const floor = Math.floor(raw);
    return { index: entry.index, floor, remainder: raw - floor };
  });

  let remainder = remainingCents - weighted.reduce((acc, row) => acc + row.floor, 0);
  weighted.sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    return a.index - b.index;
  });
  for (let i = 0; i < weighted.length && remainder > 0; i += 1) {
    weighted[i].floor += 1;
    remainder -= 1;
  }

  for (const row of weighted) payoutsCents[row.index] = row.floor;
  return payoutsCents.map(fromCents);
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function recalcLocally(payload: WorkOrderPayload): WorkOrderPayload {
  const rawPayload = payload as any;
  const groupsSource: Array<{ groupId: string; partId: string | null; partName: string; lines: any[] }> = [];
  const freeSource: any[] = [];
  const hasV2Shape = Array.isArray(rawPayload.workGroups) || Array.isArray(rawPayload.freeWorks);

  if (hasV2Shape) {
    const groups = Array.isArray(rawPayload.workGroups) ? rawPayload.workGroups : [];
    for (let idx = 0; idx < groups.length; idx += 1) {
      const group = groups[idx] ?? {};
      groupsSource.push({
        groupId: String(group.groupId ?? `group-${idx + 1}`),
        partId: group.partId ? String(group.partId) : null,
        partName: String(group.partName ?? ''),
        lines: Array.isArray(group.lines) ? group.lines : [],
      });
    }
    if (Array.isArray(rawPayload.freeWorks)) freeSource.push(...rawPayload.freeWorks);
  } else {
    const legacyWorks = Array.isArray(rawPayload.works) ? rawPayload.works : [];
    const legacyPartId = rawPayload.partId ? String(rawPayload.partId) : null;
    const legacyPartName = String(rawPayload.partName ?? '');
    if (legacyPartId || legacyPartName.trim().length > 0) {
      groupsSource.push({ groupId: 'legacy-main-group', partId: legacyPartId, partName: legacyPartName, lines: legacyWorks });
    } else {
      freeSource.push(...legacyWorks);
    }
  }

  const workGroups: WorkOrderWorkGroup[] = groupsSource.map((group, idx) => ({
    groupId: group.groupId || `group-${idx + 1}`,
    partId: group.partId ? String(group.partId) : null,
    partName: String(group.partName ?? ''),
    lines: (Array.isArray(group.lines) ? group.lines : []).map((line, lineIdx) => normalizeLine(line, lineIdx + 1)),
  }));
  const freeWorks: WorkOrderWorkLine[] = freeSource.map((line, idx) => normalizeLine(line, idx + 1));

  const works = [...workGroups.flatMap((group) => group.lines), ...freeWorks].map((line, idx) => ({
    ...line,
    lineNo: idx + 1,
  }));
  const totalAmountRub = fromCents(works.reduce((acc, line) => acc + toCents(safeNum(line.amountRub, 0)), 0));
  const crew = (Array.isArray(rawPayload.crew) ? rawPayload.crew : []).map((member: any) => {
    const ktu = Math.max(0.01, safeNum(member?.ktu, 1));
    const payoutFrozen = Boolean(member?.payoutFrozen);
    const manualPayoutRub = Math.max(0, safeNum(member?.manualPayoutRub ?? member?.payoutRub, 0));
    return {
      employeeId: String(member?.employeeId ?? ''),
      employeeName: String(member?.employeeName ?? ''),
      ktu,
      payoutFrozen,
      manualPayoutRub,
    };
  });
  const payoutValues = distributeByKtu(totalAmountRub, crew);
  const payouts = crew.map((member, idx) => ({
    employeeId: member.employeeId,
    employeeName: member.employeeName,
    ktu: member.ktu,
    amountRub: payoutValues[idx] ?? 0,
  }));

  return {
    ...payload,
    version: 2,
    workGroups,
    freeWorks,
    works,
    crew: crew.map((member, idx) => ({
      ...member,
      payoutRub: payoutValues[idx] ?? 0,
      manualPayoutRub: member.payoutFrozen ? member.manualPayoutRub : undefined,
    })),
    totalAmountRub,
    basePerWorkerRub: crew.length > 0 ? fromCents(toCents(totalAmountRub / crew.length)) : 0,
    payouts,
    partId: undefined,
    partName: undefined,
  };
}

export function WorkOrderDetailsPage(props: {
  id: string;
  onClose: () => void;
  canEdit: boolean;
  onOpenPart?: (partId: string) => void;
  onOpenService?: (serviceId: string) => void;
  onOpenEmployee?: (employeeId: string) => void;
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

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const allServiceOptions: LinkOpt[] = useMemo(
    () => services.map((s) => ({ id: s.id, label: `${s.name} (${s.unit || 'ед.'}, ${money(s.priceRub)})` })),
    [services],
  );
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
            partIds: normalizeStringArray(attrs.part_ids),
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

  function servicesForPart(partId: string | null): ServiceInfo[] {
    if (!partId) return [];
    return services.filter((service) => service.partIds.length === 0 || service.partIds.includes(partId));
  }

  function serviceOptionsForPart(partId: string | null): LinkOpt[] {
    return servicesForPart(partId).map((service) => ({
      id: service.id,
      label: `${service.name} (${service.unit || 'ед.'}, ${money(service.priceRub)})`,
    }));
  }

  function applyServiceSnapshotToLines(lines: WorkOrderWorkLine[], idx: number, serviceId: string | null): WorkOrderWorkLine[] {
    if (!serviceId) {
      return lines.map((line, lineIdx) =>
        lineIdx === idx ? { ...line, serviceId: null, serviceName: '', unit: '', priceRub: 0, amountRub: 0 } : line,
      );
    }
    const service = serviceById.get(serviceId);
    if (!service) return lines;
    return lines.map((line, lineIdx) =>
      lineIdx === idx
        ? {
            ...line,
            serviceId: service.id,
            serviceName: service.name,
            unit: service.unit,
            priceRub: service.priceRub,
          }
        : line,
    );
  }

  function buildLineFromService(service: ServiceInfo, lineNo: number): WorkOrderWorkLine {
    return {
      lineNo,
      serviceId: service.id,
      serviceName: service.name,
      unit: service.unit,
      qty: 1,
      priceRub: service.priceRub,
      amountRub: fromCents(toCents(service.priceRub)),
    };
  }

  function updateGroup(groupIdx: number, updater: (group: WorkOrderWorkGroup) => WorkOrderWorkGroup) {
    if (!payload) return;
    const workGroups = payload.workGroups.map((group, idx) => (idx === groupIdx ? updater(group) : group));
    patch({ ...payload, workGroups });
  }

  function addWorkGroup() {
    if (!payload) return;
    patch({
      ...payload,
      workGroups: [...payload.workGroups, { groupId: makeId('work-group'), partId: null, partName: '', lines: [] }],
    });
  }

  function addFreeWorkLine() {
    if (!payload) return;
    patch({
      ...payload,
      freeWorks: [...payload.freeWorks, { lineNo: payload.freeWorks.length + 1, serviceId: null, serviceName: '', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0 }],
    });
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
          onClose={() => props.requestClose?.()}
        />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700 }}>Наряд №{payload.workOrderNumber}</div>
        <div style={{ color: 'var(--muted)' }}>Итог: {money(payload.totalAmountRub)}</div>
        <div style={{ color: 'var(--muted)' }}>База на человека: {money(payload.basePerWorkerRub)}</div>
        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--muted)' }}>{status}</div> : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8, alignItems: 'center' }}>
        <div style={{ color: 'var(--muted)' }}>Дата наряда</div>
        <Input
          type="date"
          value={toInputDate(payload.orderDate)}
          disabled={!props.canEdit}
          onChange={(e) => patch({ ...payload, orderDate: fromInputDate(e.target.value) ?? payload.orderDate })}
        />
      </div>

      <div style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: 10, background: 'var(--surface2)', fontWeight: 700 }}>Работы по изделиям</div>
        <div style={{ display: 'grid', gap: 10, padding: 10 }}>
          {payload.workGroups.map((group, groupIdx) => {
            const groupServiceOptions = serviceOptionsForPart(group.partId);
            return (
              <div key={group.groupId} style={{ border: '1px solid var(--border)', padding: 10, display: 'grid', gap: 8 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto auto', gap: 8, alignItems: 'center' }}>
                  <div style={{ color: 'var(--muted)' }}>Изделие</div>
                  <SearchSelect
                    value={group.partId}
                    options={partOptions}
                    disabled={!props.canEdit}
                    onChange={(next) => {
                      const part = parts.find((x) => x.id === next);
                      updateGroup(groupIdx, (current) => {
                        if (!part) return { ...current, partId: null, partName: '', lines: [] };
                        const linkedServices = servicesForPart(part.id);
                        return {
                          ...current,
                          partId: part.id,
                          partName: part.label,
                          lines: linkedServices.map((service, idx) => buildLineFromService(service, idx + 1)),
                        };
                      });
                    }}
                    placeholder="Выберите деталь"
                  />
                  {group.partId && props.onOpenPart ? (
                    <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenPart?.(group.partId as string)}>
                      Открыть
                    </Button>
                  ) : (
                    <div />
                  )}
                  {props.canEdit ? (
                    <Button
                      variant="ghost"
                      style={{ color: 'var(--danger)' }}
                      onClick={() =>
                        patch({
                          ...payload,
                          workGroups: payload.workGroups.filter((_, idx) => idx !== groupIdx),
                        })
                      }
                    >
                      Удалить блок
                    </Button>
                  ) : (
                    <div />
                  )}
                </div>
                <table className="list-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: 8 }}>Вид работ</th>
                      <th style={{ textAlign: 'left', padding: 8, width: 110 }}>Кол-во</th>
                      <th style={{ textAlign: 'left', padding: 8, width: 130 }}>Ед.</th>
                      <th style={{ textAlign: 'left', padding: 8, width: 140 }}>Цена</th>
                      <th style={{ textAlign: 'left', padding: 8, width: 140 }}>Сумма</th>
                      {props.canEdit && <th style={{ textAlign: 'left', padding: 8, width: 90 }}>Действия</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {group.lines.map((line, lineIdx) => (
                      <tr key={`${group.groupId}-line-${lineIdx}`}>
                        <td style={{ padding: 8 }}>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
                            <SearchSelect
                              value={line.serviceId}
                              options={groupServiceOptions}
                              disabled={!props.canEdit}
                              onChange={(next) =>
                                updateGroup(groupIdx, (current) => ({
                                  ...current,
                                  lines: applyServiceSnapshotToLines(current.lines, lineIdx, next),
                                }))
                              }
                              placeholder="Выберите вид работ"
                            />
                            {line.serviceId && props.onOpenService ? (
                              <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenService?.(line.serviceId as string)}>
                                Открыть
                              </Button>
                            ) : null}
                          </div>
                        </td>
                        <td style={{ padding: 8 }}>
                          <Input
                            type="number"
                            step="0.01"
                            min={0}
                            value={String(line.qty ?? 0)}
                            disabled={!props.canEdit}
                            onChange={(e) =>
                              updateGroup(groupIdx, (current) => ({
                                ...current,
                                lines: current.lines.map((currentLine, idx) =>
                                  idx === lineIdx ? ({ ...currentLine, qty: safeNum(e.target.value, 0) } as WorkOrderWorkLine) : currentLine,
                                ),
                              }))
                            }
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
                            onChange={(e) =>
                              updateGroup(groupIdx, (current) => ({
                                ...current,
                                lines: current.lines.map((currentLine, idx) =>
                                  idx === lineIdx ? ({ ...currentLine, priceRub: safeNum(e.target.value, 0) } as WorkOrderWorkLine) : currentLine,
                                ),
                              }))
                            }
                          />
                        </td>
                        <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{money(line.amountRub ?? 0)}</td>
                        {props.canEdit && (
                          <td style={{ padding: 8 }}>
                            <Button
                              variant="ghost"
                              style={{ color: 'var(--danger)' }}
                              onClick={() =>
                                updateGroup(groupIdx, (current) => ({
                                  ...current,
                                  lines: current.lines.filter((_, idx) => idx !== lineIdx),
                                }))
                              }
                            >
                              Удалить
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                    {group.lines.length === 0 && (
                      <tr>
                        <td colSpan={props.canEdit ? 6 : 5} style={{ padding: 10, color: 'var(--muted)' }}>
                          Работы для изделия не добавлены
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {props.canEdit && (
                  <div>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        updateGroup(groupIdx, (current) => ({
                          ...current,
                          lines: [...current.lines, { lineNo: current.lines.length + 1, serviceId: null, serviceName: '', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0 }],
                        }))
                      }
                    >
                      + Добавить строку работ
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          {payload.workGroups.length === 0 ? <div style={{ color: 'var(--muted)' }}>Блоки работ по изделиям не добавлены</div> : null}
          {props.canEdit && (
            <div>
              <Button variant="ghost" onClick={addWorkGroup}>
                Добавить работы по изделию +
              </Button>
            </div>
          )}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', overflow: 'hidden' }}>
        <div style={{ padding: 10, background: 'var(--surface2)', fontWeight: 700 }}>Работы без привязки к изделию</div>
        <table className="list-table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: 8 }}>Вид работ</th>
              <th style={{ textAlign: 'left', padding: 8, width: 110 }}>Кол-во</th>
              <th style={{ textAlign: 'left', padding: 8, width: 130 }}>Ед.</th>
              <th style={{ textAlign: 'left', padding: 8, width: 140 }}>Цена</th>
              <th style={{ textAlign: 'left', padding: 8, width: 140 }}>Сумма</th>
              {props.canEdit && <th style={{ textAlign: 'left', padding: 8, width: 90 }}>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {payload.freeWorks.map((line, idx) => (
              <tr key={`free-work-line-${idx}`}>
                <td style={{ padding: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
                    <SearchSelect
                      value={line.serviceId}
                      options={allServiceOptions}
                      disabled={!props.canEdit}
                      onChange={(next) =>
                        patch({
                          ...payload,
                          freeWorks: applyServiceSnapshotToLines(payload.freeWorks, idx, next),
                        })
                      }
                      placeholder="Выберите вид работ"
                    />
                    {line.serviceId && props.onOpenService ? (
                      <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenService?.(line.serviceId as string)}>
                        Открыть
                      </Button>
                    ) : null}
                  </div>
                </td>
                <td style={{ padding: 8 }}>
                  <Input
                    type="number"
                    step="0.01"
                    min={0}
                    value={String(line.qty ?? 0)}
                    disabled={!props.canEdit}
                    onChange={(e) => {
                      const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, qty: safeNum(e.target.value, 0) } : item));
                      patch({ ...payload, freeWorks });
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
                      const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, priceRub: safeNum(e.target.value, 0) } : item));
                      patch({ ...payload, freeWorks });
                    }}
                  />
                </td>
                <td style={{ padding: 8, whiteSpace: 'nowrap' }}>{money(line.amountRub ?? 0)}</td>
                {props.canEdit && (
                  <td style={{ padding: 8 }}>
                    <Button variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => patch({ ...payload, freeWorks: payload.freeWorks.filter((_, rowIdx) => rowIdx !== idx) })}>
                      Удалить
                    </Button>
                  </td>
                )}
              </tr>
            ))}
            {payload.freeWorks.length === 0 && (
              <tr>
                <td colSpan={props.canEdit ? 6 : 5} style={{ padding: 10, color: 'var(--muted)' }}>
                  Работы без изделия не добавлены
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {props.canEdit && (
          <div style={{ padding: 8 }}>
            <Button variant="ghost" onClick={addFreeWorkLine}>
              Добавить работы +
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
              <th style={{ textAlign: 'left', padding: 8, width: 140 }}>Заморозить</th>
              {props.canEdit && <th style={{ textAlign: 'left', padding: 8, width: 90 }}>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {payload.crew.map((member, idx) => (
              <tr key={`crew-${idx}-${member.employeeId}`}>
                <td style={{ padding: 8 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'start' }}>
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
                    {member.employeeId && props.onOpenEmployee ? (
                      <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenEmployee?.(member.employeeId as string)}>
                        Открыть
                      </Button>
                    ) : null}
                  </div>
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
                <td style={{ padding: 8 }}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={String(member.payoutFrozen ? member.manualPayoutRub ?? member.payoutRub ?? 0 : member.payoutRub ?? 0)}
                      disabled={!props.canEdit || !member.payoutFrozen}
                      onChange={(e) => {
                        const crew = payload.crew.map((c, i) =>
                          i === idx
                            ? {
                                ...c,
                                manualPayoutRub: Math.max(0, safeNum(e.target.value, 0)),
                              }
                            : c,
                        );
                        patch({ ...payload, crew });
                      }}
                    />
                    {!member.payoutFrozen ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>Авто: {money(member.payoutRub ?? 0)}</div> : null}
                  </div>
                </td>
                <td style={{ padding: 8 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: props.canEdit ? 'pointer' : 'default' }}>
                    <input
                      type="checkbox"
                      disabled={!props.canEdit}
                      checked={Boolean(member.payoutFrozen)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        const crew = payload.crew.map((c, i) =>
                          i === idx
                            ? {
                                ...c,
                                payoutFrozen: checked,
                                manualPayoutRub: checked ? Math.max(0, safeNum(c.manualPayoutRub ?? c.payoutRub, 0)) : undefined,
                              }
                            : c,
                        );
                        patch({ ...payload, crew });
                      }}
                    />
                    <span>{member.payoutFrozen ? 'Да' : 'Нет'}</span>
                  </label>
                </td>
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
                <td colSpan={props.canEdit ? 5 : 4} style={{ padding: 10, color: 'var(--muted)' }}>
                  Состав бригады пуст
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {props.canEdit && (
          <div style={{ padding: 8 }}>
            <Button variant="ghost" onClick={() => patch({ ...payload, crew: [...payload.crew, { employeeId: '', employeeName: '', ktu: 1, payoutFrozen: false }] })}>
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

