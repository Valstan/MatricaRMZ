import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { formatServicePriceOrderLabel, type ServicePriceHistoryDto, type ServicePriceOrderDto } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';
import { FormField } from '../components/FormField.js';
import { FormGrid } from '../components/FormGrid.js';
import { Input } from '../components/Input.js';
import { SearchSelect, type SearchSelectOption } from '../components/SearchSelect.js';
import { SectionCard } from '../components/SectionCard.js';

type OrderRow = ServicePriceOrderDto & { linesCount: number };
type LineRow = ServicePriceHistoryDto & { nomenclatureName: string | null; nomenclatureCode: string | null };

type OrderDraft = {
  orderNumber: string;
  orderDate: string;
  title: string;
  effectiveFrom: string;
  issuedByEmployeeId: string | null;
  documentLink: string;
  notes: string;
  status: 'active' | 'cancelled';
};

function toInputDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fromInputDate(v: string): number | null {
  if (!v) return null;
  const [y, m, d] = v.split('-').map((x) => Number(x));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

function fmtDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

function money(v: number): string {
  return `${Math.round((Number(v) || 0) * 100) / 100} ₽`;
}

function todayInput(): string {
  return toInputDate(Date.now());
}

const EMPTY_DRAFT: OrderDraft = {
  orderNumber: '',
  orderDate: todayInput(),
  title: '',
  effectiveFrom: todayInput(),
  issuedByEmployeeId: null,
  documentLink: '',
  notes: '',
  status: 'active',
};

function draftFromOrder(o: ServicePriceOrderDto): OrderDraft {
  return {
    orderNumber: o.orderNumber,
    orderDate: toInputDate(o.orderDate),
    title: o.title,
    effectiveFrom: toInputDate(o.effectiveFrom),
    issuedByEmployeeId: o.issuedByEmployeeId,
    documentLink: o.documentLink ?? '',
    notes: o.notes ?? '',
    status: o.status === 'cancelled' ? 'cancelled' : 'active',
  };
}

/**
 * Приказы о ценах на услуги. Приказ — документ директора (номер, дата, с какого числа); его
 * строки — цена конкретной услуги. Вступившая в силу строка сразу переносится в карточку
 * услуги (поле «Цена»), которым пользуются наряды; будущие строки ждут своей даты.
 * Данные живут на сервере (REST), в реплику не синхронизируются — без связи страница пуста.
 */
export function ServicePriceOrdersPage(props: { canEdit: boolean; onOpenService?: (id: string) => void }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<OrderDraft>(EMPTY_DRAFT);
  const [isNew, setIsNew] = useState(false);
  const [lines, setLines] = useState<LineRow[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');

  const [services, setServices] = useState<SearchSelectOption[]>([]);
  const [employees, setEmployees] = useState<SearchSelectOption[]>([]);

  const [lineService, setLineService] = useState<string | null>(null);
  const [linePrice, setLinePrice] = useState('');
  const [lineNotes, setLineNotes] = useState('');

  const { confirm } = useConfirm();

  const refreshOrders = useCallback(async () => {
    const res = await window.matrica.servicePricing.orders.list();
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setOrders(res.rows);
  }, []);

  const refreshLines = useCallback(async (orderId: string | null) => {
    if (!orderId) {
      setLines([]);
      return;
    }
    const res = await window.matrica.servicePricing.history.list({ orderId });
    if (!res.ok) {
      setStatus(`Ошибка: ${res.error}`);
      return;
    }
    setLines(res.rows);
  }, []);

  useEffect(() => {
    void (async () => {
      setStatus('Загрузка...');
      await refreshOrders();
      setStatus('');
    })();
  }, [refreshOrders]);

  useEffect(() => {
    void (async () => {
      const [svc, emp] = await Promise.all([
        window.matrica.warehouse.nomenclatureList({ directoryKind: 'service', limit: 1000, offset: 0 }).catch(() => null),
        window.matrica.employees.list().catch(() => []),
      ]);
      if (svc?.ok) {
        setServices(
          (svc.rows ?? []).map((r: any) => ({
            id: String(r.id),
            label: String(r.name ?? ''),
            ...(r.code ? { hintText: String(r.code) } : {}),
            searchText: `${r.name ?? ''} ${r.code ?? ''}`,
          })),
        );
      }
      const empRows = Array.isArray(emp) ? (emp as Array<{ id: string; fullName?: string; position?: string }>) : [];
      setEmployees(
        empRows.map((e) => ({
          id: String(e.id),
          label: String(e.fullName ?? '').trim() || String(e.id),
          ...(e.position ? { hintText: String(e.position) } : {}),
        })),
      );
    })();
  }, []);

  const selected = useMemo(() => orders.find((o) => o.id === selectedId) ?? null, [orders, selectedId]);

  function select(order: OrderRow) {
    setSelectedId(order.id);
    setIsNew(false);
    setDraft(draftFromOrder(order));
    setLineService(null);
    setLinePrice('');
    setLineNotes('');
    void refreshLines(order.id);
  }

  function startNew() {
    setSelectedId(null);
    setIsNew(true);
    setDraft({ ...EMPTY_DRAFT, orderDate: todayInput(), effectiveFrom: todayInput() });
    setLines([]);
  }

  async function saveOrder() {
    const orderDate = fromInputDate(draft.orderDate);
    const effectiveFrom = fromInputDate(draft.effectiveFrom);
    if (!draft.orderNumber.trim()) return setStatus('Укажите номер приказа');
    if (!draft.title.trim()) return setStatus('Укажите название приказа');
    if (orderDate == null) return setStatus('Укажите дату приказа');
    if (effectiveFrom == null) return setStatus('Укажите, с какого числа действуют цены');
    setBusy(true);
    try {
      const res = await window.matrica.servicePricing.orders.upsert({
        ...(selectedId ? { id: selectedId } : {}),
        orderNumber: draft.orderNumber.trim(),
        orderDate,
        title: draft.title.trim(),
        effectiveFrom,
        issuedByEmployeeId: draft.issuedByEmployeeId,
        documentLink: draft.documentLink.trim() || null,
        notes: draft.notes.trim() || null,
        status: draft.status,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refreshOrders();
      setSelectedId(res.id);
      setIsNew(false);
      setStatus('Приказ сохранён');
      void refreshLines(res.id);
    } finally {
      setBusy(false);
    }
  }

  async function removeOrder() {
    if (!selectedId || !selected) return;
    const ok = await confirm({
      title: 'Удалить приказ?',
      detail: `Приказ ${formatServicePriceOrderLabel(selected)} и все его строки (${lines.length}) будут удалены. Цены в карточках услуг при этом не меняются.`,
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.servicePricing.orders.delete(selectedId);
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setSelectedId(null);
      setIsNew(false);
      setLines([]);
      await refreshOrders();
      setStatus('Приказ удалён');
    } finally {
      setBusy(false);
    }
  }

  async function addLine() {
    if (!selectedId) return;
    const price = Number(String(linePrice).replace(',', '.').trim());
    if (!lineService) return setStatus('Выберите услугу');
    if (!Number.isFinite(price) || price < 0) return setStatus('Цена должна быть числом не меньше нуля');
    setBusy(true);
    try {
      const res = await window.matrica.servicePricing.history.set({
        nomenclatureId: lineService,
        orderId: selectedId,
        price: Math.round(price),
        notes: lineNotes.trim() || null,
      });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refreshLines(selectedId);
      await refreshOrders();
      setLineService(null);
      setLinePrice('');
      setLineNotes('');
      setStatus(
        res.applied
          ? `Строка сохранена, в карточке услуги теперь ${money(res.appliedPrice ?? 0)}`
          : `Строка сохранена; карточка услуги не изменена${res.applyReason ? ` (${res.applyReason})` : ''}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeLine(line: LineRow) {
    const ok = await confirm({
      title: 'Убрать услугу из приказа?',
      detail: `${line.nomenclatureName ?? line.nomenclatureId}: ${money(line.price)}. В карточке услуги останется цена предыдущего действующего приказа, если он есть.`,
      confirmLabel: 'Убрать',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await window.matrica.servicePricing.history.delete(line.id);
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refreshLines(selectedId);
      await refreshOrders();
      setStatus(res.applied ? `Строка убрана, в карточке услуги теперь ${money(res.appliedPrice ?? 0)}` : 'Строка убрана');
    } finally {
      setBusy(false);
    }
  }

  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) => `${o.orderNumber} ${o.title}`.toLowerCase().includes(q));
  }, [orders, query]);

  const now = Date.now();
  const canEdit = props.canEdit;
  const canEditLines = canEdit && !!selectedId && !isNew;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 16, alignItems: 'start' }}>
      <SectionCard title="Приказы">
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Поиск по номеру или названию" style={{ flex: 1 }} />
          {canEdit ? (
            <Button variant="primary" onClick={startNew} disabled={busy}>
              + Приказ
            </Button>
          ) : null}
        </div>
        {filteredOrders.length === 0 ? (
          <div style={{ color: 'var(--muted)' }}>{orders.length === 0 ? 'Приказов пока нет.' : 'Ничего не найдено.'}</div>
        ) : (
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Приказ</th>
                <th>Действует с</th>
                <th style={{ textAlign: 'right' }}>Услуг</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((o) => {
                const active = o.id === selectedId;
                const future = o.effectiveFrom > now;
                return (
                  <tr
                    key={o.id}
                    onClick={() => select(o)}
                    style={{ cursor: 'pointer', background: active ? 'var(--accent-soft, rgba(0,0,0,0.06))' : undefined, opacity: o.status === 'cancelled' ? 0.6 : 1 }}
                  >
                    <td>
                      <div>{formatServicePriceOrderLabel(o)}</div>
                      <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                        {o.title}
                        {o.status === 'cancelled' ? ' · отменён' : ''}
                      </div>
                    </td>
                    <td>
                      {fmtDate(o.effectiveFrom)}
                      {future ? <div style={{ color: 'var(--muted)', fontSize: 12 }}>ещё не наступило</div> : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>{o.linesCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SectionCard>

      <div style={{ display: 'grid', gap: 16 }}>
        {!selectedId && !isNew ? (
          <SectionCard title="Приказ о ценах">
            <div style={{ color: 'var(--muted)' }}>
              Выберите приказ слева{canEdit ? ' или создайте новый' : ''}. Цена услуги меняется только приказом: строка приказа с наступившей
              датой попадает в карточку услуги, и наряды считают по ней.
            </div>
          </SectionCard>
        ) : (
          <SectionCard title={isNew ? 'Новый приказ' : `Приказ ${selected ? formatServicePriceOrderLabel(selected) : ''}`}>
            <FormGrid>
              <FormField label="Номер приказа">
                <Input value={draft.orderNumber} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, orderNumber: e.target.value })} placeholder="17" />
              </FormField>
              <FormField label="Дата приказа">
                <Input type="date" value={draft.orderDate} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, orderDate: e.target.value })} />
              </FormField>
              <FormField label="Цены действуют с">
                <Input type="date" value={draft.effectiveFrom} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, effectiveFrom: e.target.value })} />
              </FormField>
              <FormField label="Название">
                <Input
                  value={draft.title}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  placeholder="Об утверждении цен на услуги по ремонту"
                />
              </FormField>
              <FormField label="Кем издан">
                <SearchSelect
                  value={draft.issuedByEmployeeId}
                  options={employees}
                  disabled={!canEdit}
                  placeholder="Сотрудник"
                  showAllWhenEmpty
                  onChange={(next) => setDraft({ ...draft, issuedByEmployeeId: next })}
                />
              </FormField>
              <FormField label="Ссылка на документ">
                <Input value={draft.documentLink} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, documentLink: e.target.value })} placeholder="скан приказа, папка на диске" />
              </FormField>
              <FormField label="Статус">
                <select className="input" value={draft.status} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, status: e.target.value === 'cancelled' ? 'cancelled' : 'active' })}>
                  <option value="active">Действует</option>
                  <option value="cancelled">Отменён</option>
                </select>
              </FormField>
              <FormField label="Примечание">
                <Input value={draft.notes} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              </FormField>
            </FormGrid>
            {canEdit ? (
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <Button variant="primary" onClick={() => void saveOrder()} disabled={busy}>
                  Сохранить приказ
                </Button>
                {selectedId ? (
                  <Button variant="ghost" tone="danger" onClick={() => void removeOrder()} disabled={busy}>
                    Удалить
                  </Button>
                ) : null}
              </div>
            ) : null}
          </SectionCard>
        )}

        {selectedId && !isNew ? (
          <SectionCard title="Цены по приказу">
            {canEditLines ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 2fr) 120px minmax(160px, 1fr) auto', gap: 8, alignItems: 'end', marginBottom: 12 }}>
                <FormField label="Услуга">
                  <SearchSelect value={lineService} options={services} placeholder="Выберите услугу" showAllWhenEmpty onChange={setLineService} />
                </FormField>
                <FormField label="Цена, ₽">
                  <Input value={linePrice} onChange={(e) => setLinePrice(e.target.value)} inputMode="decimal" placeholder="0" />
                </FormField>
                <FormField label="Примечание">
                  <Input value={lineNotes} onChange={(e) => setLineNotes(e.target.value)} />
                </FormField>
                <Button variant="primary" onClick={() => void addLine()} disabled={busy}>
                  Добавить
                </Button>
              </div>
            ) : null}
            {lines.length === 0 ? (
              <div style={{ color: 'var(--muted)' }}>В приказе пока нет услуг.</div>
            ) : (
              <table className="table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Услуга</th>
                    <th style={{ textAlign: 'right' }}>Цена</th>
                    <th>Действует с</th>
                    <th>Примечание</th>
                    {canEditLines ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {props.onOpenService ? (
                          <a href="#" onClick={(e) => { e.preventDefault(); props.onOpenService?.(l.nomenclatureId); }}>
                            {l.nomenclatureName ?? l.nomenclatureId}
                          </a>
                        ) : (
                          l.nomenclatureName ?? l.nomenclatureId
                        )}
                        {l.nomenclatureCode ? <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>{l.nomenclatureCode}</span> : null}
                      </td>
                      <td style={{ textAlign: 'right' }}>{money(l.price)}</td>
                      <td>
                        {fmtDate(l.effectiveFrom)}
                        {l.effectiveFrom > now ? <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 12 }}>ещё не наступило</span> : null}
                      </td>
                      <td>{l.notes ?? ''}</td>
                      {canEditLines ? (
                        <td style={{ textAlign: 'right' }}>
                          <Button variant="ghost" onClick={() => void removeLine(l)} disabled={busy}>
                            Убрать
                          </Button>
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>
        ) : null}

        {status ? <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger, #b00)' : 'var(--muted)' }}>{status}</div> : null}
      </div>
    </div>
  );
}
