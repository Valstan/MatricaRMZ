import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { WorkOrderPayload, WorkOrderWorkGroup, WorkOrderWorkLine } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { Input } from '../components/Input.js';
import { RowReorderButtons } from '../components/RowReorderButtons.js';
import { SectionCard } from '../components/SectionCard.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import type { CardCloseActions } from '../cardCloseTypes.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { moveArrayItem } from '../utils/moveArrayItem.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { buildSearchOption, joinOptionHint, joinOptionSearch } from '../utils/selectOptions.js';

type LinkOpt = SearchSelectOption;
type ServiceInfo = { id: string; name: string; unit: string; priceRub: number; partIds: string[] };
type EmployeeInfo = {
  id: string;
  displayName: string;
  personnelNumber?: string | null;
  departmentName?: string | null;
  position?: string | null;
};
type EngineInfo = { id: string; engineNumber?: string; engineBrandId?: string | null; engineBrandName?: string };

function normalizeLookupValue(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replaceAll(/[^a-z0-9а-я\s_-]+/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
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
  const result: WorkOrderWorkLine = {
    lineNo,
    serviceId: line?.serviceId ? String(line.serviceId) : null,
    serviceName: String(line?.serviceName ?? ''),
    unit: String(line?.unit ?? ''),
    qty,
    priceRub,
    amountRub: fromCents(toCents(qty * priceRub)),
  };
  if (line?.productNumber) result.productNumber = String(line.productNumber);
  if (line?.engineId) result.engineId = String(line.engineId);
  if (line?.engineNumber) result.engineNumber = String(line.engineNumber);
  if (line?.engineBrandId) result.engineBrandId = String(line.engineBrandId);
  if (line?.engineBrandName) result.engineBrandName = String(line.engineBrandName);
  return result;
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
    const row = weighted[i];
    if (row) { row.floor += 1; remainder -= 1; }
  }

  for (const row of weighted) payoutsCents[row.index] = row.floor;
  return payoutsCents.map(fromCents);
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
  type CrewEntry = { employeeId: string; employeeName: string; ktu: number; payoutFrozen: boolean; manualPayoutRub: number };
  const payoutValues = distributeByKtu(totalAmountRub, crew);
  const payouts = crew.map((member: CrewEntry, idx: number) => ({
    employeeId: member.employeeId,
    employeeName: member.employeeName,
    ktu: member.ktu,
    amountRub: payoutValues[idx] ?? 0,
  }));

  const result: WorkOrderPayload = {
    ...payload,
    version: 2,
    workGroups,
    freeWorks,
    works,
    crew: crew.map((member: CrewEntry, idx: number) => ({
      ...member,
      payoutRub: payoutValues[idx] ?? 0,
      ...(member.payoutFrozen ? { manualPayoutRub: member.manualPayoutRub } : {}),
    })),
    totalAmountRub,
    basePerWorkerRub: crew.length > 0 ? fromCents(toCents(totalAmountRub / crew.length)) : 0,
    payouts,
    partId: null,
  };
  delete result.partName;
  return result;
}

export function WorkOrderDetailsPage(props: {
  id: string;
  onClose: () => void;
  canEdit: boolean;
  canEditMasterData: boolean;
  canCreateParts?: boolean;
  canCreateEmployees?: boolean;
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
  const [engines, setEngines] = useState<EngineInfo[]>([]);
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
        if (!payload) return;
        await copyToNewWorkOrder(payload);
      },
    });
    return () => { props.registerCardCloseActions?.(null); };
  }, [payload, props.registerCardCloseActions, props.id]);

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const allServiceOptions: LinkOpt[] = useMemo(
    () =>
      services.map((s) => {
        const hint = joinOptionHint([s.unit && `Ед. ${s.unit}`, `Цена ${money(s.priceRub)}`]);
        const search = joinOptionSearch([s.name, s.id, s.unit, s.priceRub, ...s.partIds]);
        return buildSearchOption({
          id: s.id,
          label: `${s.name} (${s.unit || 'ед.'}, ${money(s.priceRub)})`,
          ...(hint ? { hintText: hint } : {}),
          ...(search ? { searchText: search } : {}),
        });
      }),
    [services],
  );
  const employeeOptions: LinkOpt[] = useMemo(
    () =>
      employees.map((e) => {
        const hint = joinOptionHint([
          e.personnelNumber && `Таб. ${e.personnelNumber}`,
          e.position,
          e.departmentName,
        ]);
        const search = joinOptionSearch([e.displayName, e.id, e.personnelNumber, e.position, e.departmentName]);
        return buildSearchOption({
          id: e.id,
          label: e.displayName,
          ...(hint ? { hintText: hint } : {}),
          ...(search ? { searchText: search } : {}),
        });
      }),
    [employees],
  );
  const engineOptions: LinkOpt[] = useMemo(
    () =>
      engines.map((e) => {
        const hint = joinOptionHint([e.engineNumber, e.engineBrandName]);
        const search = joinOptionSearch([e.engineNumber || '', e.id, e.engineBrandName || '']);
        return buildSearchOption({
          id: e.id,
          label: e.engineNumber || e.id,
          ...(hint ? { hintText: hint } : {}),
          ...(search ? { searchText: search } : {}),
        });
      }),
    [engines],
  );

  async function loadRefs() {
    try {
      const emps = await window.matrica.employees.list().catch(() => [] as any[]);
      setEmployees(
        (emps as any[]).map((x) => ({
          id: String(x.id),
          displayName: String(x.displayName || x.fullName || x.id),
          personnelNumber: x.personnelNumber ? String(x.personnelNumber) : null,
          departmentName: x.departmentName ? String(x.departmentName) : null,
          position: x.position ? String(x.position) : null,
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

      // Загрузка двигателей
      const engineList = await window.matrica.engines.list().catch(() => [] as any[]);
      const engineInfo = (engineList as any[]).map((e) => ({
        id: String(e.id),
        engineNumber: String(e.engineNumber ?? ''),
        engineBrandId: e.engineBrandId ? String(e.engineBrandId) : null,
        engineBrandName: String(e.engineBrand ?? ''),
      } as EngineInfo));
      setEngines(engineInfo);
    } catch {
      setServices([]);
      setEmployees([]);
      setEngines([]);
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

  async function copyToNewWorkOrder(sourcePayload: WorkOrderPayload) {
    const created = await window.matrica.workOrders.create();
    if (!created.ok) {
      setStatus(`Ошибка копирования: ${created.error}`);
      return;
    }

    const nextNumber = Number(created.payload.workOrderNumber ?? 0);
    const copyPayload: WorkOrderPayload = {
      ...sourcePayload,
      workOrderNumber: nextNumber > 0 ? nextNumber : sourcePayload.workOrderNumber,
      orderDate: Number(created.payload.orderDate ?? Date.now()),
    };

    const saved = await window.matrica.workOrders.update({
      id: created.id,
      payload: copyPayload,
    });
    if (!saved.ok) {
      setStatus(`Ошибка копирования: ${saved.error}`);
      return;
    }
    setStatus(`Создан новый наряд №${copyPayload.workOrderNumber}`);
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

  function findExistingServiceByLabel(label: string, partId: string | null): ServiceInfo | null {
    const key = normalizeLookupValue(label);
    if (!key) return null;
    const exact = services.find((service) => normalizeLookupValue(service.name) === key);
    if (!exact) return null;
    if (!partId) return exact;
    if (exact.partIds.length === 0 || exact.partIds.includes(partId)) return exact;
    return exact;
  }

  function findExistingEmployeeByLabel(label: string): EmployeeInfo | null {
    const key = normalizeLookupValue(label);
    if (!key) return null;
    return employees.find((employee) => normalizeLookupValue(employee.displayName) === key) ?? null;
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

  async function createServiceFromWorkOrder(label: string, partId: string | null): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const clean = label.trim();
    if (!clean) return null;
    const existing = findExistingServiceByLabel(clean, partId);
    if (existing?.id) {
      setStatus(`Использована существующая услуга: ${existing.name}`);
      return existing.id;
    }
    const types = await window.matrica.admin.entityTypes.list().catch(() => [] as any[]);
    const serviceType = (types as any[]).find((x) => String(x.code) === 'service');
    if (!serviceType?.id) {
      setStatus('Справочник услуг не найден');
      return null;
    }
    const created = await window.matrica.admin.entities.create(String(serviceType.id));
    if (!created?.ok || !created?.id) {
      const err = !created?.ok && created && 'error' in created ? (created as { error: string }).error : 'unknown';
      setStatus(`Ошибка создания услуги: ${err}`);
      return null;
    }
    await window.matrica.admin.entities.setAttr(created.id, 'name', clean);
    await window.matrica.admin.entities.setAttr(created.id, 'unit', 'шт');
    await window.matrica.admin.entities.setAttr(created.id, 'price', 0);
    if (partId) {
      await window.matrica.admin.entities.setAttr(created.id, 'part_ids', [partId]);
    }
    return created.id;
  }

  async function createEmployeeFromWorkOrder(label: string): Promise<string | null> {
    if (props.canCreateEmployees !== true) return null;
    const clean = label.trim();
    if (!clean) return null;
    const existing = findExistingEmployeeByLabel(clean);
    if (existing?.id) {
      setStatus(`Использован существующий сотрудник: ${existing.displayName}`);
      return existing.id;
    }
    const created = await window.matrica.employees.create();
    if (!created?.ok || !created?.id) {
      const err = !created?.ok && created && 'error' in created ? (created as { error: string }).error : 'unknown';
      setStatus(`Ошибка создания сотрудника: ${err}`);
      return null;
    }
    const parts = clean.split(/\s+/).filter(Boolean);
    const lastName = parts[0] ?? clean;
    const firstName = parts[1] ?? '';
    const middleName = parts.slice(2).join(' ');
    await window.matrica.employees.setAttr(created.id, 'last_name', lastName);
    if (firstName) await window.matrica.employees.setAttr(created.id, 'first_name', firstName);
    if (middleName) await window.matrica.employees.setAttr(created.id, 'middle_name', middleName);
    await window.matrica.employees.setAttr(created.id, 'full_name', clean);
    setEmployees((prev) => [...prev, { id: created.id, displayName: clean }].sort((a, b) => a.displayName.localeCompare(b.displayName, 'ru')));
    return created.id;
  }

  function moveCrewMember(from: number, to: number) {
    if (!payload) return;
    patch({ ...payload, crew: moveArrayItem(payload.crew, from, to) });
  }

  function moveFreeWorkLine(from: number, to: number) {
    if (!payload) return;
    patch({
      ...payload,
      freeWorks: moveArrayItem(payload.freeWorks, from, to).map((line, idx) => ({ ...line, lineNo: idx + 1 })),
    });
  }

  function addFreeWorkLine() {
    if (!payload) return;
    patch({
      ...payload,
      freeWorks: [...payload.freeWorks, { lineNo: payload.freeWorks.length + 1, serviceId: null, serviceName: '', unit: 'шт', qty: 1, priceRub: 0, amountRub: 0, productNumber: '', engineId: null, engineNumber: '', engineBrandId: null, engineBrandName: '' }],
    });
  }

  function printWorkOrderCard(current: WorkOrderPayload) {
    const keyValueTable = (rows: Array<[string, string]>) =>
      `<table><tbody>${rows
        .map(
          ([k, v]) =>
            `<tr><th style="width:38%;white-space:nowrap;">${escapeHtml(k)}</th><td>${escapeHtml(v || '—')}</td></tr>`,
        )
        .join('')}</tbody></table>`;

    const linesTable = (lines: WorkOrderWorkLine[]) =>
      lines.length
        ? `<table><thead><tr><th>Вид работ</th><th>№ изделия</th><th>Двигатель</th><th>Марка</th><th>Кол-во</th><th>Ед.</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>${lines
            .map(
              (line) =>
                `<tr><td>${escapeHtml(line.serviceName || '—')}</td><td>${escapeHtml(line.productNumber || '—')}</td><td>${escapeHtml(
                  line.engineNumber || '—',
                )}</td><td>${escapeHtml(line.engineBrandName || '—')}</td><td>${escapeHtml(String(line.qty ?? 0))}</td><td>${escapeHtml(
                  line.unit || '—',
                )}</td><td>${escapeHtml(money(line.priceRub ?? 0))}</td><td>${escapeHtml(money(line.amountRub ?? 0))}</td></tr>`,
            )
            .join('')}</tbody></table>`
        : `<div class="muted">Нет данных</div>`;

    const crewHtml = current.crew.length
      ? `<table><thead><tr><th>Сотрудник</th><th>Таб. №</th><th>КТУ</th><th>Выплата</th><th>Заморозка</th></tr></thead><tbody>${current.crew
          .map((member) => {
            const emp = employees.find((e) => e.id === member.employeeId);
            const tabNum = emp?.personnelNumber || '';
            return `<tr><td>${escapeHtml(member.employeeName || '—')}</td><td>${escapeHtml(tabNum || '—')}</td><td>${escapeHtml(String(member.ktu ?? 1))}</td><td>${escapeHtml(
              money(member.payoutRub ?? 0),
            )}</td><td>${member.payoutFrozen ? 'Да' : 'Нет'}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : `<div class="muted">Нет данных</div>`;

    openPrintPreview({
      title: `Наряд №${current.workOrderNumber || '—'}`,
      subtitle: current.orderDate ? `Дата: ${formatMoscowDate(current.orderDate)}` : 'Дата: —',
      sections: [
        {
          id: 'main',
          title: 'Основное',
          html: keyValueTable([
            ['Номер наряда', String(current.workOrderNumber || '—')],
            ['Дата', current.orderDate ? formatMoscowDate(current.orderDate) : '—'],
            ['Итог', money(current.totalAmountRub || 0)],
            ['База на человека', money(current.basePerWorkerRub || 0)],
          ]),
        },
        { id: 'crew', title: 'Бригада и выплаты', html: crewHtml },
        { id: 'works', title: 'Виды работ', html: linesTable(current.freeWorks) },
      ],
    });
  }

  if (loading) return <div style={{ color: 'var(--muted)' }}>Загрузка…</div>;
  if (!payload) return <div style={{ color: 'var(--danger)' }}>{status || 'Карточка наряда недоступна'}</div>;

  const amountInputStyle: React.CSSProperties = { textAlign: 'right' };
  const rightCellStyle: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap' };

  const cardActionBar = (
    <CardActionBar
      canEdit={props.canEdit}
      cardLabel="Наряд"
      onCopyToNew={() => {
        void (async () => {
          if (!payload) return;
          await copyToNewWorkOrder(payload);
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
      onPrint={() => printWorkOrderCard(payload)}
      onClose={() => props.requestClose?.()}
      onDelete={() => {
        void (async () => {
          if (!confirm('Удалить наряд?')) return;
          const r = await window.matrica.workOrders.delete(props.id);
          if (!r.ok) {
            setStatus(`Ошибка удаления: ${r.error}`);
            return;
          }
          props.onClose();
        })();
      }}
      deleteLabel="Удалить наряд"
    />
  );

  const crewSection = (
    <SectionCard className="entity-card-span-full">
      <div className="list-table-wrap list-table-wrap--single">
        <table className="list-table list-table--single-mode work-order-table" style={{ width: '100%' }}>
          <colgroup>
            <col />
            <col style={{ width: '12%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '12%' }} />
            {props.canEdit ? <col style={{ width: '18%' }} /> : null}
          </colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Сотрудник</th>
              <th style={{ textAlign: 'right' }}>КТУ</th>
              <th style={{ textAlign: 'right' }}>Выплата</th>
              <th style={{ textAlign: 'right' }}>Заморозить</th>
              {props.canEdit && <th style={{ textAlign: 'center' }}>Действия</th>}
            </tr>
          </thead>
          <tbody>
            {payload.crew.map((member, idx) => (
              <tr key={`crew-${idx}-${member.employeeId}`}>
                <td>
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'start' }}>
                    <SearchSelectWithCreate
                      value={member.employeeId || null}
                      options={employeeOptions}
                      disabled={!props.canEdit}
                      canCreate={props.canCreateEmployees === true}
                      createLabel="Новый сотрудник"
                      onChange={(next) => {
                        const employee = employees.find((x) => x.id === next);
                        const crew = payload.crew.map((c, i) =>
                          i === idx ? { ...c, employeeId: employee?.id || '', employeeName: employee?.displayName || '' } : c,
                        );
                        patch({ ...payload, crew });
                      }}
                      onCreate={async (label) => {
                        const createdId = await createEmployeeFromWorkOrder(label);
                        if (!createdId) return null;
                        const employee = employees.find((x) => x.id === createdId);
                        const nextName = employee?.displayName || label.trim();
                        const crew = payload.crew.map((c, i) =>
                          i === idx ? { ...c, employeeId: createdId, employeeName: nextName } : c,
                        );
                        patch({ ...payload, crew });
                        return createdId;
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
                <td style={rightCellStyle}>
                  <Input
                    type="number"
                    min={0.01}
                    step="0.01"
                    value={String(member.ktu ?? 1)}
                    style={amountInputStyle}
                    disabled={!props.canEdit}
                    onChange={(e) => {
                      const crew = payload.crew.map((c, i) => (i === idx ? { ...c, ktu: Math.max(0.01, safeNum(e.target.value, 1)) } : c));
                      patch({ ...payload, crew });
                    }}
                  />
                </td>
                <td style={rightCellStyle}>
                  <div style={{ display: 'grid', gap: 6 }}>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={String(member.payoutFrozen ? member.manualPayoutRub ?? member.payoutRub ?? 0 : member.payoutRub ?? 0)}
                      style={amountInputStyle}
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
                  </div>
                </td>
                <td style={rightCellStyle}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, width: '100%', cursor: props.canEdit ? 'pointer' : 'default' }}>
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
                                ...(checked ? { manualPayoutRub: Math.max(0, safeNum(c.manualPayoutRub ?? c.payoutRub, 0)) } : {}),
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
                  <td style={{ textAlign: 'center' }}>
                    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <RowReorderButtons
                        canMoveUp={idx > 0}
                        canMoveDown={idx < payload.crew.length - 1}
                        onMoveUp={() => moveCrewMember(idx, idx - 1)}
                        onMoveDown={() => moveCrewMember(idx, idx + 1)}
                      />
                      <Button variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => patch({ ...payload, crew: payload.crew.filter((_, i) => i !== idx) })}>
                        Удалить
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
            {payload.crew.length === 0 && (
              <tr>
                <td colSpan={props.canEdit ? 5 : 4} style={{ color: 'var(--muted)' }}>
                  Состав бригады пуст
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {props.canEdit && (
          <Button variant="ghost" onClick={() => patch({ ...payload, crew: [...payload.crew, { employeeId: '', employeeName: '', ktu: 1, payoutFrozen: false }] })}>
            + Добавить сотрудника
          </Button>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, color: 'var(--muted)', fontSize: 13, whiteSpace: 'nowrap' }}>
          <span>Итог: {money(payload.totalAmountRub)}</span>
          <span>База на человека: {money(payload.basePerWorkerRub)}</span>
        </div>
      </div>
    </SectionCard>
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'auto' }}>
      {/* Верхняя компактная часть: реквизиты + бригада */}
      <div style={{ maxWidth: 'min(95vw, 1200px)', marginInline: 'auto', width: '100%', flexShrink: 0 }}>
        <EntityCardShell
          title=""
          layout="stack"
          cardActions={cardActionBar}
        >
      {/* Реквизиты и итоги — одна компактная строка */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        alignItems: 'center',
        padding: '8px 12px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        marginBottom: 12,
        maxWidth: 'var(--ui-content-block-max-width)',
        marginInline: 'auto',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>№</span>
          <Input value={String(payload.workOrderNumber)} disabled style={{ ...amountInputStyle, width: 60 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Дата</span>
          <Input
            type="date"
            value={toInputDate(payload.orderDate)}
            disabled={!props.canEdit}
            onChange={(e) => patch({ ...payload, orderDate: fromInputDate(e.target.value) ?? payload.orderDate })}
            style={{ width: 150 }}
          />
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>Итог</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{money(payload.totalAmountRub)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--subtle)' }}>База/чел</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>{money(payload.basePerWorkerRub)}</span>
        </div>
      </div>
      {status && !status.startsWith('Сохранено') ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--muted)', fontSize: 12, marginBottom: 8 }}>{status}</div>
      ) : null}

      {crewSection}
    </EntityCardShell>
      </div>

      {/* Виды работ — отдельный широкий блок */}
      <div style={{ maxWidth: 'min(98vw, 1600px)', marginInline: 'auto', width: '100%' }}>
        <SectionCard className="entity-card-span-full work-order-works-panel">
        <div className="list-table-wrap list-table-wrap--single">
          <table className="list-table list-table--single-mode work-order-table">
            <colgroup>
              <col />
              <col style={{ width: '100px' }} />
              <col style={{ width: '130px' }} />
              <col style={{ width: '140px' }} />
              <col style={{ width: '65px' }} />
              <col style={{ width: '50px' }} />
              <col style={{ width: '80px' }} />
              <col style={{ width: '100px' }} />
              {props.canEdit ? <col style={{ width: '140px' }} /> : null}
            </colgroup>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Вид работ</th>
                <th style={{ textAlign: 'left' }}>№ изделия</th>
                <th style={{ textAlign: 'left' }}>№ двигателя</th>
                <th style={{ textAlign: 'left' }}>Марка двигателя</th>
                <th style={{ textAlign: 'right' }}>Кол-во</th>
                <th style={{ textAlign: 'right' }}>Ед.</th>
                <th style={{ textAlign: 'right' }}>Цена</th>
                <th style={{ textAlign: 'right' }}>Сумма</th>
                {props.canEdit && <th style={{ textAlign: 'center' }}>Действия</th>}
              </tr>
            </thead>
            <tbody>
              {payload.freeWorks.map((line, idx) => {
                const engineInfo = engines.find((e) => e.id === line.engineId) || null;
                return (
                <tr key={`free-work-line-${idx}`}>
                  <td>
                    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 6, alignItems: 'start' }}>
                      <SearchSelectWithCreate
                        value={line.serviceId}
                        options={allServiceOptions}
                        disabled={!props.canEdit}
                        canCreate={props.canEditMasterData}
                        createLabel="Новая услуга"
                        onChange={(next) =>
                          patch({
                            ...payload,
                            freeWorks: applyServiceSnapshotToLines(payload.freeWorks, idx, next),
                          })
                        }
                        onCreate={async (label) => {
                          const createdId = await createServiceFromWorkOrder(label, null);
                          if (!createdId) return null;
                          patch({
                            ...payload,
                            freeWorks: applyServiceSnapshotToLines(payload.freeWorks, idx, createdId),
                          });
                          return createdId;
                        }}
                        placeholder="Выберите вид работ"
                      />
                      {line.serviceId && props.onOpenService ? (
                        <Button variant="outline" tone="neutral" size="sm" onClick={() => props.onOpenService?.(line.serviceId as string)}>
                          Открыть
                        </Button>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <Input
                      value={line.productNumber || ''}
                      disabled={!props.canEdit}
                      placeholder="№ изделия"
                      onChange={(e) => {
                        const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, productNumber: e.target.value } : item));
                        patch({ ...payload, freeWorks });
                      }}
                    />
                  </td>
                  <td>
                    <SearchSelectWithCreate
                      value={line.engineId || null}
                      options={engineOptions}
                      disabled={!props.canEdit}
                      canCreate={false}
                      createLabel=""
                      placeholder="Выберите двигатель"
                      onChange={(next) => {
                        const eng = next ? engines.find((e) => e.id === next) : null;
                        const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? {
                          ...item,
                          engineId: next || null,
                          engineNumber: eng?.engineNumber || '',
                          engineBrandId: eng?.engineBrandId || null,
                          engineBrandName: eng?.engineBrandName || '',
                        } : item));
                        patch({ ...payload, freeWorks });
                      }}
                      onCreate={async () => null}
                    />
                  </td>
                  <td>
                    <Input
                      value={engineInfo?.engineBrandName || line.engineBrandName || ''}
                      disabled
                      placeholder="—"
                    />
                  </td>
                  <td style={rightCellStyle}>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={String(line.qty ?? 0)}
                      style={amountInputStyle}
                      disabled={!props.canEdit}
                      onChange={(e) => {
                        const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, qty: safeNum(e.target.value, 0) } : item));
                        patch({ ...payload, freeWorks });
                      }}
                    />
                  </td>
                  <td style={rightCellStyle}>
                    <Input value={line.unit || ''} disabled style={amountInputStyle} />
                  </td>
                  <td style={rightCellStyle}>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={String(line.priceRub ?? 0)}
                      style={amountInputStyle}
                      disabled={!props.canEdit}
                      onChange={(e) => {
                        const freeWorks = payload.freeWorks.map((item, rowIdx) => (rowIdx === idx ? { ...item, priceRub: safeNum(e.target.value, 0) } : item));
                        patch({ ...payload, freeWorks });
                      }}
                    />
                  </td>
                  <td style={rightCellStyle}>{money(line.amountRub ?? 0)}</td>
                  {props.canEdit && (
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <RowReorderButtons
                          canMoveUp={idx > 0}
                          canMoveDown={idx < payload.freeWorks.length - 1}
                          onMoveUp={() => moveFreeWorkLine(idx, idx - 1)}
                          onMoveDown={() => moveFreeWorkLine(idx, idx + 1)}
                        />
                        <Button variant="ghost" style={{ color: 'var(--danger)' }} onClick={() => patch({ ...payload, freeWorks: payload.freeWorks.filter((_, rowIdx) => rowIdx !== idx) })}>
                          Удалить
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
                );
              })}
              {payload.freeWorks.length === 0 && (
                <tr>
                  <td colSpan={props.canEdit ? 9 : 8} style={{ color: 'var(--muted)' }}>
                    Работы не добавлены
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {props.canEdit && (
          <div>
            <Button variant="ghost" onClick={addFreeWorkLine}>
              Добавить работу +
            </Button>
          </div>
        )}
      </SectionCard>
    </div>
    </div>
  );
}

