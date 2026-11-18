import React, { useMemo, useRef, useState } from 'react';

import {
  buildEngineFinanceTable,
  contractSectionAddonToken,
  formatKopMoney,
  PRIMARY_CONTRACT_SECTION_KEY,
  type ContractPayments,
  type ContractSections,
  type EngineListItem,
  type PaymentKind,
  type PlannedSectionBrand,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { CardTable } from './CardTable.js';
import { DistributeToSelectedForm } from './DistributeToSelectedForm.js';
import { Input } from './Input.js';
import { SectionCard } from './SectionCard.js';
import { openPrintPreview } from '../utils/printPreview.js';
import { buildEngineFinancePrint } from '../utils/engineFinancePrint.js';

const TD_HEAD = { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid var(--border)' } as const;
const TD_CELL = { padding: '6px 8px', borderBottom: '1px solid var(--border)' } as const;

/**
 * Дата последней работы по двигателю: событие истории ремонта, этап работ или обновление
 * карточки. Нужна для порога «забытых карточек» — без неё отсчёт молчит (сторож
 * CountdownStale) и снова показывает все красные двигатели.
 */
function lastActivityOf(engine: EngineListItem): number | null {
  const values = [engine.lastHistoryAt, engine.lastSheetAt, engine.updatedAt].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0,
  );
  return values.length ? Math.max(...values) : null;
}

/**
 * Вкладка «Авансы и расчёт» карточки контракта (промты КАРМАНА #18/#19).
 *
 * Смысл — тот же, что у ручной ведомости владельца («Аудит по цене»): по строке
 * двигатель, по столбцам — цена по договору, аванс, долг и состояние, а внизу итоги
 * по разделам («сколь куда за что должен»). Отличие: строки берутся из данных программы
 * (план, платежи, карточки двигателей), поэтому ведомость не надо вести руками.
 *
 * Оператор здесь и работает: отмечает галочками приехавшие двигатели и разносит аванс
 * одним действием — процентом от стоимости по контракту; примечание по двигателю правится
 * прямо в строке.
 */
export function ContractEngineFinance(props: {
  contractPayments: ContractPayments;
  /** Двигатели договора. */
  engines: readonly EngineListItem[];
  /** КОММИТНЫЕ секции договора (не редактируемый стейт). */
  sections: ContractSections;
  /** План договора по разделам и маркам — цена места, которому движок ещё не достался. */
  plan?: readonly PlannedSectionBrand[];
  canEdit: boolean;
  /** Общий выбор слотов с таблицей мест — одна галочка на двигателя. */
  slotSelection?: ReadonlySet<string>;
  onToggleSlots?: (slotIds: readonly string[], checked: boolean) => void;
  onOpenEngine?: (engineId: string) => void;
  /** Разнос аванса по отмеченным слотам. */
  onDistribute?: (
    payload: { mode: 'amount'; amountKop: number } | { mode: 'percent'; percent: number },
    kind: PaymentKind,
    date: string,
    note: string,
    slotIds: readonly string[],
  ) => void;
  /** Сохранить примечание по двигателю (то же поле `engine_note`, что и в карточке). */
  onSaveNote?: (engineId: string, note: string) => void | Promise<void>;
  /** Срок ремонта по договору, дней. */
  repairDays: number;
  /** Ставка НДС по разделам, % (в разделе без ставки — НДС не считаем). */
  vatPercentBySection?: ReadonlyMap<string, number>;
  /** Заказчик — в шапке печатной формы. */
  customerName?: string;
}) {
  const [distributeOpen, setDistributeOpen] = useState(false);
  const advancePercent = 50;

  const sectionLabels = useMemo(() => {
    const map = new Map<string, string>();
    const primaryNumber = String(props.sections.primary.number ?? '').trim();
    map.set(PRIMARY_CONTRACT_SECTION_KEY, primaryNumber ? `Основной договор № ${primaryNumber}` : 'Основной договор');
    for (const addon of props.sections.addons) {
      const token = contractSectionAddonToken(addon.seq);
      const number = String(addon.number ?? '').trim();
      map.set(token, number ? `ДС ${addon.seq} (№ ${number})` : `ДС ${addon.seq}`);
    }
    return map;
  }, [props.sections]);

  const table = useMemo(
    () =>
      buildEngineFinanceTable({
        contractPayments: props.contractPayments,
        engines: props.engines.map((e) => ({
          id: e.id,
          ...(e.engineNumber ? { engineNumber: e.engineNumber } : {}),
          ...(e.engineBrand ? { engineBrand: e.engineBrand } : {}),
          ...(e.engineBrandId ? { engineBrandId: e.engineBrandId } : {}),
          ...(e.contractSectionNumber ? { contractSectionNumber: e.contractSectionNumber } : {}),
          ...(e.statusFlags ? { statusFlags: e.statusFlags } : {}),
          ...(e.arrivalDate != null ? { arrivalDate: e.arrivalDate } : {}),
          // Дата последней работы: без неё порог «забытых карточек» молчит (сторож
          // CountdownStale) — и отсчёт снова станет бесполезным.
          ...(lastActivityOf(e) != null ? { lastActivityAt: lastActivityOf(e) as number } : {}),
          ...(e.engineNote ? { engineNote: e.engineNote } : {}),
        })),
        ...(props.plan ? { plan: props.plan } : {}),
        ...(props.vatPercentBySection ? { vatPercentBySection: props.vatPercentBySection } : {}),
        sectionLabels,
        advancePercent,
        repairDays: props.repairDays,
      }),
    [props.contractPayments, props.engines, props.plan, props.repairDays, props.vatPercentBySection, sectionLabels],
  );

  const selectedSlotIds = useMemo(() => {
    const ids = new Set<string>();
    for (const section of table.sections) {
      for (const row of section.rows) {
        if (row.slotId && props.slotSelection?.has(row.slotId)) ids.add(row.slotId);
      }
    }
    return [...ids];
  }, [table.sections, props.slotSelection]);

  const money = (kop: number) => (kop === 0 ? '—' : `${formatKopMoney(kop)} ₽`);
  const moneyOrDash = (kop: number | null) => (kop == null ? '—' : `${formatKopMoney(kop)} ₽`);

  function printAudit() {
    openPrintPreview({
      title: 'Аудит по цене',
      subtitle: `Контракт № ${String(props.sections.primary.number ?? '') || '—'}`,
      orientation: 'landscape',
      sections: buildEngineFinancePrint({
        contractNumber: String(props.sections.primary.number ?? ''),
        customerName: props.customerName ?? '',
        sections: table.sections,
        totals: table.totals,
        advancePercent,
        dateIso: new Date().toLocaleDateString('ru-RU'),
      }),
    });
  }

  const headCount = props.onToggleSlots ? 13 : 12;

  return (
    <SectionCard
      className="entity-card-span-full"
      title="Авансы и расчёт по двигателям"
      style={{ borderRadius: 0, padding: 16 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
          Двигателей и мест: {table.totals.count} · цена по договору {money(table.totals.priceKop)} · внесено{' '}
          {money(table.totals.paidAdvanceKop)} · долг {money(table.totals.dueKop)}
          {table.totals.vatKop != null ? ` · НДС ${money(table.totals.vatKop)}` : ''}
          {table.totals.vatUnknownCount > 0 ? ` · без ставки НДС: ${table.totals.vatUnknownCount} строк` : ''}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="outline" tone="neutral" size="sm" onClick={printAudit}>
            Напечатать «аудит по цене»
          </Button>
          {props.canEdit && selectedSlotIds.length > 0 ? (
            <Button variant="outline" tone="neutral" size="sm" onClick={() => setDistributeOpen((v) => !v)}>
              Разнести аванс по отмеченным ({selectedSlotIds.length})
            </Button>
          ) : null}
        </div>
      </div>
      {distributeOpen && props.onDistribute ? (
        <DistributeToSelectedForm
          selectedCount={selectedSlotIds.length}
          contractPayments={props.contractPayments}
          slotIds={selectedSlotIds}
          onApply={(payload, kind, date, note) => {
            props.onDistribute?.(payload, kind, date, note, selectedSlotIds);
            setDistributeOpen(false);
          }}
          onCancel={() => setDistributeOpen(false)}
        />
      ) : null}
      <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
        <CardTable className="list-table">
          <colgroup>
            {props.onToggleSlots ? <col style={{ width: 34 }} /> : <col />}
            <col style={{ width: 42 }} />
            <col style={{ width: '14%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '11%' }} />
            <col style={{ width: '14%' }} />
            <col />
          </colgroup>
          <thead>
            <tr>
              {props.onToggleSlots ? <th style={TD_HEAD} /> : null}
              <th style={TD_HEAD} data-col-kind="num">№</th>
              <th style={TD_HEAD} data-col-kind="name">Номер двигателя</th>
              <th style={TD_HEAD} data-col-kind="name">Модель</th>
              <th style={TD_HEAD} data-col-kind="num" title="Цена по договору (с НДС)">Цена, ₽</th>
              <th style={TD_HEAD} data-col-kind="num" title="Цена без НДС — по ставке раздела">Без НДС, ₽</th>
              <th style={TD_HEAD} data-col-kind="num" title="НДС внутри цены">НДС, ₽</th>
              <th style={TD_HEAD} data-col-kind="num">Аванс {advancePercent}%, ₽</th>
              <th style={TD_HEAD} data-col-kind="num">Внесено, ₽</th>
              <th style={TD_HEAD} data-col-kind="num">Долг, ₽</th>
              <th style={TD_HEAD} data-col-kind="num">Окончат. расчёт, ₽</th>
              <th style={TD_HEAD} data-col-kind="text">Примечание</th>
              <th style={TD_HEAD} data-col-kind="text">Состояние</th>
            </tr>
          </thead>
          <tbody>
            {table.sections.map((section) => {
              let rowNumber = 0;
              return (
                <React.Fragment key={section.sectionKey}>
                  <tr>
                    <td
                      colSpan={headCount}
                      style={{ padding: '10px 8px 4px', fontWeight: 700, borderBottom: '1px solid var(--border)' }}
                    >
                      {section.label}
                    </td>
                  </tr>
                  {section.rows.map((row) => {
                    rowNumber += 1;
                    const checked = Boolean(row.slotId && props.slotSelection?.has(row.slotId));
                    return (
                      <tr key={row.key}>
                        {props.onToggleSlots ? (
                          <td style={TD_CELL}>
                            {row.slotId ? (
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => props.onToggleSlots?.([row.slotId as string], e.target.checked)}
                              />
                            ) : null}
                          </td>
                        ) : null}
                        <td className="num" data-col-kind="num" style={TD_CELL}>
                          {rowNumber}
                        </td>
                        <td data-col-kind="name" style={TD_CELL}>
                          {row.engineId && props.onOpenEngine ? (
                            <button
                              type="button"
                              onClick={() => props.onOpenEngine?.(row.engineId as string)}
                              style={{ padding: 0, border: 'none', background: 'transparent', color: 'var(--info)', cursor: 'pointer', font: 'inherit' }}
                            >
                              {row.engineNumber || '—'}
                            </button>
                          ) : (
                            <span style={{ color: 'var(--subtle)' }}>{row.engineNumber || '—'}</span>
                          )}
                        </td>
                        <td data-col-kind="name" style={TD_CELL}>{row.brandLabel || '—'}</td>
                        <td className="num" data-col-kind="num" style={TD_CELL}>
                          {money(row.priceKop)}
                          {row.priceFromPlan ? (
                            <span style={{ color: 'var(--subtle)' }} title="Цена по плану — место движку ещё не назначено"> (по плану)</span>
                          ) : null}
                        </td>
                        <td className="num" data-col-kind="num" style={TD_CELL}>{moneyOrDash(row.netKop)}</td>
                        <td className="num" data-col-kind="num" style={TD_CELL}>{moneyOrDash(row.vatKop)}</td>
                        <td className="num" data-col-kind="num" style={TD_CELL}>{money(row.plannedAdvanceKop)}</td>
                        <td className="num" data-col-kind="num" style={TD_CELL}>{money(row.paidAdvanceKop)}</td>
                        <td
                          className="num"
                          data-col-kind="num"
                          style={{ ...TD_CELL, color: row.dueKop > 0 ? 'var(--danger)' : 'inherit', fontWeight: row.dueKop > 0 ? 700 : 400 }}
                        >
                          {money(row.dueKop)}
                        </td>
                        <td className="num" data-col-kind="num" style={TD_CELL}>{money(row.paidFinalKop)}</td>
                        <td data-col-kind="text" style={TD_CELL}>
                          {row.engineId && props.canEdit && props.onSaveNote ? (
                            <EngineNoteCell engineId={row.engineId} value={row.note} onSave={props.onSaveNote} />
                          ) : (
                            <span style={{ color: 'var(--subtle)' }}>{row.note || '—'}</span>
                          )}
                        </td>
                        <td data-col-kind="text" style={TD_CELL}>
                          {row.statusLabel}
                          {row.countdownLabel ? (
                            <span style={{ color: 'var(--subtle)' }}> · {row.countdownLabel}</span>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                  <tr style={{ fontWeight: 700 }}>
                    <td colSpan={props.onToggleSlots ? 4 : 3} style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      Итого по разделу
                    </td>
                    <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      {money(section.totals.priceKop)}
                    </td>
                    <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      {moneyOrDash(section.totals.netKop)}
                    </td>
                    <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      {moneyOrDash(section.totals.vatKop)}
                    </td>
                    <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      {money(section.totals.plannedAdvanceKop)}
                    </td>
                    <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      {money(section.totals.paidAdvanceKop)}
                    </td>
                    <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      {money(section.totals.dueKop)}
                    </td>
                    <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }}>
                      {money(section.totals.paidFinalKop)}
                    </td>
                    <td colSpan={2} style={{ ...TD_CELL, borderTop: '1px solid var(--border)' }} />
                  </tr>
                </React.Fragment>
              );
            })}
            <tr style={{ fontWeight: 700 }}>
              <td colSpan={props.onToggleSlots ? 4 : 3} style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                Итого по договору
              </td>
              <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                {money(table.totals.priceKop)}
              </td>
              <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                {moneyOrDash(table.totals.netKop)}
              </td>
              <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                {moneyOrDash(table.totals.vatKop)}
              </td>
              <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                {money(table.totals.plannedAdvanceKop)}
              </td>
              <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                {money(table.totals.paidAdvanceKop)}
              </td>
              <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                {money(table.totals.dueKop)}
              </td>
              <td className="num" data-col-kind="num" style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }}>
                {money(table.totals.paidFinalKop)}
              </td>
              <td colSpan={2} style={{ ...TD_CELL, borderTop: '2px solid var(--border)' }} />
            </tr>
          </tbody>
        </CardTable>
      </div>
    </SectionCard>
  );
}

/**
 * Ячейка примечания по двигателю: правится прямо в сводке и пишется тем же полем
 * `engine_note`, что и в карточке двигателя (одна запись — одна дверь).
 */
function EngineNoteCell(props: {
  engineId: string;
  value: string;
  onSave: (engineId: string, note: string) => void | Promise<void>;
}) {
  const [text, setText] = useState(props.value);
  const [saving, setSaving] = useState(false);
  /**
   * Правка оператора — главная: пока он правит это поле, внешнее значение не затирает его.
   * Список движков читает EAV, а он догоняет запись после цикла синка (как и любое другое
   * поле движка), поэтому «подхватить» оттуда сразу после сохранения — значило бы стереть
   * только что введённое. Внешнее значение придёт при следующем открытии карточки.
   */
  const editedRef = useRef(false);
  React.useEffect(() => {
    if (editedRef.current) return;
    setText(props.value);
  }, [props.value]);
  const commit = async () => {
    const next = text.trim();
    if (next === (props.value ?? '').trim()) return;
    setSaving(true);
    try {
      await props.onSave(props.engineId, next);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Input
      value={text}
      disabled={saving}
      placeholder="—"
      title="Примечание по двигателю"
      onChange={(e) => {
        editedRef.current = true;
        setText(e.target.value);
      }}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit();
      }}
      style={{ width: '100%' }}
    />
  );
}
