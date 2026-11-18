import { useState } from 'react';

import {
  PAYMENT_KIND_LABELS,
  advancePercentShares,
  formatKopMoney,
  parseMoneyToKop,
  type ContractPayments,
  type PaymentKind,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { FormField } from './FormField.js';
import { Input } from './Input.js';

// Форма «Разнести аванс» на ОТМЕЧЕННЫЕ галочками слоты.
// Раньше спрашивалось «на слотов (из N)» и деньги ложились на первые N слотов секции по
// порядку массива — выбрать конкретную марку было нельзя. Кейс владельца ровно обратный:
// «аванс пришёл за 10 двигателей вот этой марки».
//
// Два способа задать сумму (владелец 13.11.2026): своей суммой — когда известно, сколько
// пришло, и процентом от стоимости по контракту — когда известно «50% аванса по этим
// двигателям». Оба раскладываются по ОТМЕЧЕННЫМ слотам.
//
// Форма вынесена в отдельный файл: ею пользуются и список мест в карточке контракта, и
// новая вкладка «Авансы и расчёт» — одна форма на оба места, иначе правила разноса
// разъедутся.
export function DistributeToSelectedForm(props: {
  selectedCount: number;
  /** Платежи договора — нужны цены слотов для разноса по проценту. */
  contractPayments?: ContractPayments | undefined;
  /** Отмеченные слоты (для разноса по проценту). */
  slotIds?: readonly string[];
  onApply: (
    payload: { mode: 'amount'; amountKop: number } | { mode: 'percent'; percent: number },
    kind: PaymentKind,
    date: string,
    note: string,
  ) => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<'amount' | 'percent'>('amount');
  const [amountText, setAmountText] = useState('');
  const [percentText, setPercentText] = useState('');
  const [kind, setKind] = useState<PaymentKind>('advance');
  const [date, setDate] = useState(todayIsoDate());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const amountKop = parseMoneyToKop(amountText);
  const percent = Number.parseFloat(percentText.replace(',', '.'));
  const percentOk = Number.isFinite(percent) && percent > 0;
  // Живой расчёт: бухгалтер видит, что получит каждый двигатель, до нажатия кнопки.
  const preview =
    mode === 'amount'
      ? amountKop != null && amountKop > 0 && props.selectedCount > 0
        ? (() => {
            const per = Math.floor(amountKop / props.selectedCount);
            const rest = amountKop - per * props.selectedCount;
            return `по ${formatKopMoney(per)} ₽ на ${props.selectedCount} поз.${
              rest > 0 ? `, остаток ${formatKopMoney(rest)} ₽ — первой` : ''
            }`;
          })()
        : ''
      : percentOk && props.contractPayments && (props.slotIds ?? []).length > 0
        ? (() => {
            const shares = advancePercentShares(props.contractPayments, props.slotIds ?? [], percent);
            const total = shares.reduce((s, x) => s + x.amountKop, 0);
            return shares.length === 0
              ? 'у отмеченных двигателей нет цены по контракту — процент не от чего считать'
              : `${percent}% от суммы по ${shares.length} поз. — всего ${formatKopMoney(total)} ₽`;
          })()
        : '';
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap', padding: '8px 0' }}>
      <FormField label="Как считать">
        <div style={{ display: 'flex', gap: 6 }} data-distribute-mode>
          {(
            [
              { key: 'amount', label: 'Суммой' },
              { key: 'percent', label: '% от суммы двигателя' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              data-distribute-mode-option={opt.key}
              onClick={() => {
                setMode(opt.key);
                setError('');
              }}
              style={{
                padding: '6px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: mode === opt.key ? 'rgba(37, 99, 235, 0.15)' : 'var(--surface)',
                fontWeight: mode === opt.key ? 700 : 400,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </FormField>
      {mode === 'amount' ? (
        <FormField label="Сумма, ₽">
          <Input value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0,00" style={{ width: 130, textAlign: 'right' }} />
        </FormField>
      ) : (
        <FormField label="Процент, %">
          <Input
            value={percentText}
            onChange={(e) => setPercentText(e.target.value)}
            placeholder="50"
            inputMode="decimal"
            style={{ width: 90, textAlign: 'right' }}
          />
        </FormField>
      )}
      <FormField label="Вид платежа">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as PaymentKind)}
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--input-border)', fontSize: 13 }}
        >
          {(['advance', 'extra_advance', 'final'] as PaymentKind[]).map((k) => (
            <option key={k} value={k}>
              {PAYMENT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Дата оплаты">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 140 }} />
      </FormField>
      <FormField label="Примечание">
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="п/п №…" style={{ width: 160 }} />
      </FormField>
      <Button
        size="sm"
        onClick={() => {
          if (props.selectedCount === 0) {
            setError('Отметьте двигатели галочками');
            return;
          }
          if (mode === 'amount') {
            if (amountKop == null || amountKop <= 0) {
              setError('Укажите сумму');
              return;
            }
            props.onApply({ mode: 'amount', amountKop }, kind, date, note);
            return;
          }
          if (!percentOk) {
            setError('Укажите процент');
            return;
          }
          props.onApply({ mode: 'percent', percent }, kind, date, note);
        }}
      >
        Разнести на {props.selectedCount}
      </Button>
      <Button variant="ghost" tone="neutral" size="sm" onClick={props.onCancel}>
        Отмена
      </Button>
      {preview ? <span style={{ color: 'var(--subtle)', fontSize: 12 }}>{preview}</span> : null}
      {error ? <span style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</span> : null}
    </div>
  );
}

function todayIsoDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
