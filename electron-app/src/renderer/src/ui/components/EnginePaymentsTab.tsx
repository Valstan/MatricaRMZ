import React, { useEffect, useMemo, useState } from 'react';

import {
  CONTRACT_PAYMENTS_ATTR_CODE,
  PAYMENT_KIND_LABELS,
  REPAIR_COUNTDOWN_DAYS,
  countdownStatus,
  findSlotForEngine,
  formatKopMoney,
  parseContractPayments,
  parseMoneyToKop,
  slotTotals,
  type ContractPayments,
  type PaymentKind,
  type PaymentRow,
  type PaymentSlot,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SectionCard } from './SectionCard.js';
import { ensureAttributeDefs, type AttributeDefRow } from '../utils/fieldOrder.js';

// Вкладка «Платежи» карточки двигателя (план engine-payments-2026-07, этап 1).
// Источник истины — контрактный EAV-атрибут contract_payments: здесь читаем/пишем
// слот этого двигателя через контракт (read-modify-write с пере-чтением перед записью).

const PAYMENT_KIND_OPTIONS: { value: PaymentKind; label: string }[] = (
  ['advance', 'extra_advance', 'final'] as PaymentKind[]
).map((value) => ({ value, label: PAYMENT_KIND_LABELS[value] }));

type RowDraft = {
  id: string;
  date: string;
  amountText: string;
  kind: PaymentKind;
  note: string;
  countdownStart: boolean;
};

function rowToDraft(row: PaymentRow): RowDraft {
  return {
    id: row.id,
    date: row.date,
    amountText: row.amountKop ? formatKopMoney(row.amountKop) : '',
    kind: row.kind,
    note: row.note ?? '',
    countdownStart: row.countdownStart === true,
  };
}

function draftToRow(d: RowDraft): PaymentRow | null {
  const amountKop = parseMoneyToKop(d.amountText);
  if (amountKop == null || amountKop <= 0) return null;
  return {
    id: d.id,
    date: d.date,
    amountKop,
    kind: d.kind,
    ...(d.note.trim() ? { note: d.note.trim() } : {}),
    ...(d.countdownStart ? { countdownStart: true } : {}),
  };
}

function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function EnginePaymentsTab(props: {
  engineId: string;
  contractId: string;
  /** contract_section_number двигателя ('' → primary). */
  sectionKey: string;
  engineBrandId?: string;
  /** Двигатель отремонтирован — отсчёт 90 дней погашен. */
  engineRepaired: boolean;
  canEdit: boolean;
  onOpenContract?: (contractId: string) => void;
}) {
  const sectionKey = props.sectionKey.trim() || 'primary';
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [priceText, setPriceText] = useState('');
  const [rows, setRows] = useState<RowDraft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRows([]);
    setPriceText('');
    setDirty(false);
    setSaveStatus('');
    setLoadError('');
    if (!props.contractId) return;
    setLoading(true);
    void (async () => {
      try {
        const contract = (await window.matrica.admin.entities.get(props.contractId)) as {
          attributes?: Record<string, unknown>;
        } | null;
        const cp = parseContractPayments(contract?.attributes?.[CONTRACT_PAYMENTS_ATTR_CODE]);
        const slot = findSlotForEngine(cp, props.engineId);
        if (slot) {
          setRows(slot.payments.filter((p) => p.kind !== 'contract_price').map(rowToDraft));
          setPriceText(slot.contractPriceKop != null ? formatKopMoney(slot.contractPriceKop) : '');
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [props.contractId, props.engineId]);

  const draftSlot: PaymentSlot = useMemo(() => {
    const payments = rows.map(draftToRow).filter((r): r is PaymentRow => r != null);
    const priceKop = parseMoneyToKop(priceText);
    return {
      id: 'draft',
      sectionKey,
      engineId: props.engineId,
      ...(priceKop != null && priceKop > 0 ? { contractPriceKop: priceKop } : {}),
      payments,
    };
  }, [rows, priceText, sectionKey, props.engineId]);

  const totals = useMemo(() => slotTotals(draftSlot), [draftSlot]);
  const countdown = useMemo(
    () => countdownStatus(draftSlot, todayIso(), props.engineRepaired),
    [draftSlot, props.engineRepaired],
  );

  function markDirty() {
    setDirty(true);
    setSaveStatus('');
  }

  function updateRow(id: string, patch: Partial<RowDraft>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.id !== id) return patch.countdownStart ? { ...r, countdownStart: false } : r;
        return { ...r, ...patch };
      }),
    );
    markDirty();
  }

  function addRow() {
    setRows((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        date: todayIso(),
        amountText: '',
        kind: prev.length === 0 ? 'advance' : 'extra_advance',
        note: '',
        // Первый аванс по умолчанию — старт отсчёта 90 дней.
        countdownStart: prev.length === 0,
      },
    ]);
    markDirty();
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((r) => r.id !== id));
    markDirty();
  }

  async function ensureContractPaymentsDef(): Promise<void> {
    const types = (await window.matrica.admin.entityTypes.list()) as Array<{ id: string; code: string }>;
    const contractType = (types ?? []).find((t) => t.code === 'contract');
    if (!contractType) return;
    const defs = (await window.matrica.admin.attributeDefs.listByEntityType(contractType.id)) as AttributeDefRow[];
    await ensureAttributeDefs(
      contractType.id,
      [{ code: CONTRACT_PAYMENTS_ATTR_CODE, name: 'Платежи по двигателям', dataType: 'json', sortOrder: 7 }],
      defs ?? [],
    );
  }

  async function save() {
    if (!props.contractId || saving) return;
    const invalid = rows.find((r) => draftToRow(r) == null);
    if (invalid) {
      setSaveStatus('Ошибка: у платежа не заполнена сумма');
      return;
    }
    setSaving(true);
    setSaveStatus('Сохранение…');
    try {
      await ensureContractPaymentsDef();
      // Пере-чтение перед записью: чужие слоты контракта не затираем.
      const contract = (await window.matrica.admin.entities.get(props.contractId)) as {
        attributes?: Record<string, unknown>;
      } | null;
      const cp = parseContractPayments(contract?.attributes?.[CONTRACT_PAYMENTS_ATTR_CODE]);
      const payments = rows.map(draftToRow).filter((r): r is PaymentRow => r != null);
      const priceKop = parseMoneyToKop(priceText);
      const existing = findSlotForEngine(cp, props.engineId);
      let next: ContractPayments;
      if (existing) {
        next = {
          version: 1,
          slots: cp.slots.map((s) => {
            if (s.id !== existing.id) return s;
            const { contractPriceKop: _drop, ...rest } = s;
            return {
              ...rest,
              payments: [...s.payments.filter((p) => p.kind === 'contract_price'), ...payments],
              ...(priceKop != null && priceKop > 0 ? { contractPriceKop: priceKop } : {}),
            };
          }),
        };
      } else {
        const slot: PaymentSlot = {
          id: crypto.randomUUID(),
          sectionKey,
          engineId: props.engineId,
          ...(props.engineBrandId ? { engineBrandId: props.engineBrandId } : {}),
          ...(priceKop != null && priceKop > 0 ? { contractPriceKop: priceKop } : {}),
          payments,
        };
        next = { version: 1, slots: [...cp.slots, slot] };
      }
      const r = (await window.matrica.admin.entities.setAttr(props.contractId, CONTRACT_PAYMENTS_ATTR_CODE, next)) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (r && r.ok === false) {
        setSaveStatus(`Ошибка: ${r.error ?? 'не удалось сохранить'}`);
        return;
      }
      setDirty(false);
      setSaveStatus('Сохранено');
    } catch (e) {
      setSaveStatus(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (!props.contractId) {
    return (
      <SectionCard title="Платежи">
        <div style={{ color: '#6b7280', fontSize: 13 }}>
          Двигатель не привязан к контракту. Укажите контракт на вкладке «Основное» — платежи ведутся в контракте
          (в том числе авансы по ещё не приехавшим двигателям).
        </div>
      </SectionCard>
    );
  }

  const deltaColor = totals.deltaKop > 0 ? '#b45309' : totals.deltaKop < 0 ? '#b91c1c' : '#15803d';
  const countdownLabel =
    countdown.state === 'none'
      ? props.engineRepaired
        ? 'Отсчёт погашен: двигатель отремонтирован'
        : 'Отсчёт не начат (нет аванса с датой)'
      : `Прошло ${countdown.daysElapsed} дн. из ${REPAIR_COUNTDOWN_DAYS}, осталось ${countdown.daysLeft} дн.`;
  const countdownColor = countdown.state === 'danger' ? '#b91c1c' : countdown.state === 'warning' ? '#b45309' : '#374151';

  const thStyle: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', fontSize: 12, color: '#6b7280', fontWeight: 600 };
  const tdStyle: React.CSSProperties = { padding: '4px 8px', verticalAlign: 'middle' };

  return (
    <SectionCard title="Платежи по двигателю">
      {loading ? <div style={{ color: '#6b7280', fontSize: 13 }}>Загрузка…</div> : null}
      {loadError ? <div style={{ color: '#b91c1c', fontSize: 13 }}>Ошибка загрузки: {loadError}</div> : null}
      {!loading && !loadError ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              Стоимость по контракту, ₽
              <Input
                value={priceText}
                onChange={(e) => {
                  setPriceText(e.target.value);
                  markDirty();
                }}
                disabled={!props.canEdit}
                placeholder="0,00"
                style={{ width: 140, textAlign: 'right' }}
              />
            </label>
            {props.onOpenContract ? (
              <Button variant="outline" onClick={() => props.onOpenContract?.(props.contractId)}>
                Открыть контракт
              </Button>
            ) : null}
          </div>

          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                <th style={thStyle}>Дата</th>
                <th style={thStyle}>Сумма, ₽</th>
                <th style={thStyle}>Вид платежа</th>
                <th style={thStyle} title={`Старт отсчёта ${REPAIR_COUNTDOWN_DAYS} дней на ремонт`}>
                  Старт отсчёта
                </th>
                <th style={thStyle}>Примечание</th>
                <th style={thStyle} />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ ...tdStyle, color: '#6b7280', fontSize: 13 }}>
                    Платежей пока нет.
                  </td>
                </tr>
              ) : null}
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={tdStyle}>
                    <Input
                      type="date"
                      value={r.date}
                      onChange={(e) => updateRow(r.id, { date: e.target.value })}
                      disabled={!props.canEdit}
                      style={{ width: 140 }}
                    />
                  </td>
                  <td style={tdStyle}>
                    <Input
                      value={r.amountText}
                      onChange={(e) => updateRow(r.id, { amountText: e.target.value })}
                      disabled={!props.canEdit}
                      placeholder="0,00"
                      style={{ width: 130, textAlign: 'right' }}
                    />
                  </td>
                  <td style={tdStyle}>
                    <select
                      value={r.kind}
                      onChange={(e) => updateRow(r.id, { kind: e.target.value as PaymentKind })}
                      disabled={!props.canEdit}
                      style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #d1d5db', fontSize: 13 }}
                    >
                      {PAYMENT_KIND_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'center' }}>
                    <input
                      type="radio"
                      name={`countdown-start-${props.engineId}`}
                      checked={r.countdownStart}
                      onChange={() => updateRow(r.id, { countdownStart: true })}
                      disabled={!props.canEdit}
                    />
                  </td>
                  <td style={tdStyle}>
                    <Input
                      value={r.note}
                      onChange={(e) => updateRow(r.id, { note: e.target.value })}
                      disabled={!props.canEdit}
                      style={{ width: '100%', minWidth: 120 }}
                    />
                  </td>
                  <td style={tdStyle}>
                    {props.canEdit ? (
                      <Button variant="outline" onClick={() => removeRow(r.id)} title="Удалить платёж">
                        ✕
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {props.canEdit ? (
            <div>
              <Button variant="outline" onClick={addRow}>
                + Добавить платёж
              </Button>
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 13, borderTop: '1px solid #e5e7eb', paddingTop: 10 }}>
            <div>
              Оплачено всего: <b>{formatKopMoney(totals.paidKop)} ₽</b>
            </div>
            <div>
              {totals.deltaKop >= 0 ? 'Переплата' : 'Осталось доплатить'}:{' '}
              <b style={{ color: deltaColor }}>{formatKopMoney(Math.abs(totals.deltaKop))} ₽</b>
            </div>
            {totals.lastPaymentDate ? <div>Последний платёж: {totals.lastPaymentDate.split('-').reverse().join('.')}</div> : null}
            <div style={{ color: countdownColor }}>{countdownLabel}</div>
          </div>

          {props.canEdit ? (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <Button onClick={() => void save()} disabled={!dirty || saving}>
                Сохранить платежи
              </Button>
              {saveStatus ? (
                <span style={{ fontSize: 13, color: saveStatus.startsWith('Ошибка') ? '#b91c1c' : '#15803d' }}>{saveStatus}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </SectionCard>
  );
}
