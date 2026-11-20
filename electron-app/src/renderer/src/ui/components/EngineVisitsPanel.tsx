import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  buildEngineHistoryFeed,
  buildEngineVisitViews,
  buildEngineVisits,
  engineVisitPayments,
  engineVisitToneBackground,
  formatKopMoney,
  resolveEngineVisitCustomer,
  splitEngineHistoryByVisits,
  type ContractPayments,
  type EngineHistoryFeedItem,
  type EngineVisit,
  type EngineVisitView,
} from '@matricarmz/shared';

import { formatMoscowDate } from '../utils/dateUtils.js';

/**
 * РАЗДЕЛЫ ЗАЕЗДОВ в карточке двигателя (владелец 20.11.2026).
 *
 * «Сделать заезды в виде разделов во вкладке „Основное“, там как бы раскрывающиеся
 * разделы „Заезд 1“, Заезд 2 и так далее, самые свежие последние заезды самые верхние. И
 * каждый заезд состоит из карточки вкладки „Основное“… рекламации пусть на голубоватом
 * фоне, история ремонта показывается от прихода до отгрузки, а остальные заезды, ну самый
 * свежий заезд на белом фоне, а чем старее заезд тем как бы серее и коричневее фон».
 *
 * Что внутри раздела:
 *  · **реквизиты заезда** — свои даты, свой договор, свой контрагент, свои накладные;
 *    у заезда по рекламации — свой дефект и акт;
 *  · **своя история ремонта** — этапы этого заезда (от прихода до отгрузки);
 *  · для ТЕКУЩЕГО заезда — редактируемая карточка (`renderCurrentCard`): править
 *    прошлое нельзя, а править можно только то, что правится сейчас.
 *
 * Правила (текущий/прошлый заезд, тон, разбивка истории) живут в домене
 * `shared/src/domain/engineVisits.ts` — интерфейс, фильтры и отчёты читают одни и те же.
 */
export type EngineVisitsPanelProps = {
  engineId: string;
  /**
   * Право читать операции (`operations.view`).
   *
   * История ремонта — те же данные, что во вкладке «История ремонта», а та вкладка
   * операционная: её не видно без права на операции. Разделы заездов живут в «Основном»,
   * которую видят и без этого права, — значит историю внутри разделов надо закрыть тем же
   * гейтом. По умолчанию — закрыто: забытый флаг не должен открыть лишнее.
   */
  canViewOperations?: boolean;
  /** Основной цикл карточки — его даты и стороны. */
  mainArrivalDate?: number | null;
  mainShippingDate?: number | null;
  mainContractId?: string | null;
  mainCustomerId?: string | null;
  mainArrivalInvoice?: string | null;
  mainShipmentInvoice?: string | null;
  /** Прежние заезды — карточки с тем же номером (архивные «повторные заезды»). */
  siblings?: Array<{
    id: string;
    engineNumber: string;
    engineBrand: string;
    arrivalDate?: number | null;
    roleLabel?: string | undefined;
  }>;
  /** Подписи договоров и контрагентов (из справочников карточки). */
  contractOptions?: Array<{ id: string; label: string }>;
  customerOptions?: Array<{ id: string; label: string }>;
  /** Карточка текущего заезда (редактируемая форма). */
  renderCurrentCard?: () => React.ReactNode;
  /** Открыть карточку прежнего заезда (другую карточку того же номера). */
  onOpenEngine?: (engineId: string) => void;
};

type SiblingVisit = {
  engineId: string;
  engineNumber: string;
  engineBrand: string;
  arrivalDate: number | null;
  shippingDate: number | null;
  contractId: string | null;
  customerId: string | null;
  arrivalInvoice: string | null;
  shipmentInvoice: string | null;
  roleLabel: string | null;
};

function toMs(value: unknown): number | null {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function toId(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return v ? v : null;
}

function dateLabel(ms: number | null): string {
  return ms == null ? '—' : formatMoscowDate(new Date(ms));
}

export function EngineVisitsPanel(props: EngineVisitsPanelProps) {
  const [reclamations, setReclamations] = useState<Parameters<typeof buildEngineVisits>[0]['reclamations']>([]);
  const [siblingVisits, setSiblingVisits] = useState<SiblingVisit[]>([]);
  const [feed, setFeed] = useState<EngineHistoryFeedItem[]>([]);
  const [contractCustomers, setContractCustomers] = useState<Record<string, string>>({});
  const [contractPayments, setContractPayments] = useState<Record<string, ContractPayments | null>>({});
  const [status, setStatus] = useState('');

  const siblingKey = (props.siblings ?? []).map((s) => `${s.id}:${s.arrivalDate ?? ''}`).join('|');

  const load = useCallback(async () => {
    if (!props.engineId) return;
    setStatus('');
    try {
      // История ремонта — операционные данные: без права на операции её не читаем вовсе
      // (IPC всё равно откажет, но и лишнего запроса, и лишней ошибки в консоли не надо).
      const [recl, ops] = await Promise.all([
        window.matrica.engineReclamations.list(props.engineId).catch(() => null),
        props.canViewOperations
          ? window.matrica.operations.list(props.engineId).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (recl && recl.ok) setReclamations(recl.rows ?? []);
      if (Array.isArray(ops)) setFeed(buildEngineHistoryFeed(ops as never[]));
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
    // Прежние заезды — карточки с тем же номером: из каждой нужны свои даты, договор,
    // контрагент и накладные.
    const list = props.siblings ?? [];
    try {
      const details: SiblingVisit[] = [];
      await Promise.all(
        list.map(async (candidate) => {
          const card = await window.matrica.admin.entities.get(candidate.id).catch(() => null);
          const attrs = ((card as { attributes?: Record<string, unknown> } | null)?.attributes ?? {}) as Record<string, unknown>;
          details.push({
            engineId: candidate.id,
            engineNumber: String(attrs.engine_number ?? candidate.engineNumber ?? ''),
            engineBrand: String(attrs.engine_brand ?? candidate.engineBrand ?? ''),
            arrivalDate: toMs(attrs.arrival_date) ?? candidate.arrivalDate ?? null,
            shippingDate: toMs(attrs.status_customer_sent_date),
            contractId: toId(attrs.contract_id),
            customerId: toId(attrs.customer_id),
            arrivalInvoice: toId(attrs.arrival_invoice),
            shipmentInvoice: toId(attrs.shipment_invoice),
            roleLabel: candidate.roleLabel ?? null,
          });
        }),
      );
      setSiblingVisits(details);
    } catch {
      /* прежние заезды просто не покажем */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.engineId, siblingKey, props.canViewOperations]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Все заезды номера: основной цикл, рекламации и прежние карточки. */
  const visits = useMemo<EngineVisit[]>(() => {
    const own = buildEngineVisits({
      mainArrivalDate: props.mainArrivalDate ?? null,
      mainShippingDate: props.mainShippingDate ?? null,
      mainContractId: props.mainContractId ?? null,
      mainCustomerId: props.mainCustomerId ?? null,
      mainArrivalInvoice: props.mainArrivalInvoice ?? null,
      mainShipmentInvoice: props.mainShipmentInvoice ?? null,
      reclamations,
    });
    const archived: EngineVisit[] = siblingVisits.map((s, i) => ({
      visitNo: own.length + i + 1,
      reclamation: null,
      kind: 'archived',
      arrivalDate: s.arrivalDate,
      shippingDate: s.shippingDate,
      contractId: s.contractId,
      customerId: s.customerId,
      arrivalInvoice: s.arrivalInvoice,
      shipmentInvoice: s.shipmentInvoice,
      label: s.engineNumber ? `Прежний заезд ${s.engineNumber}` : 'Прежний заезд',
    }));
    return [...own, ...archived];
  }, [
    props.mainArrivalDate,
    props.mainShippingDate,
    props.mainContractId,
    props.mainCustomerId,
    props.mainArrivalInvoice,
    props.mainShipmentInvoice,
    reclamations,
    siblingVisits,
  ]);

  const views = useMemo(() => buildEngineVisitViews(visits), [visits]);

  /** Договоры заездов — их контрагенты и платежи (одна и та же правда, что на вкладке «Платежи»). */
  const contractIds = useMemo(() => {
    const ids = new Set<string>();
    for (const v of views) if (v.contractId) ids.add(v.contractId);
    return Array.from(ids).sort();
  }, [views]);

  useEffect(() => {
    if (contractIds.length === 0) return undefined;
    let cancelled = false;
    void (async () => {
      const customers: Record<string, string> = {};
      const payments: Record<string, ContractPayments | null> = {};
      await Promise.all(
        contractIds.map(async (id) => {
          try {
            const contract = await window.matrica.admin.entities.get(id);
            const attrs = ((contract as { attributes?: Record<string, unknown> } | null)?.attributes ?? {}) as Record<string, unknown>;
            const sections = (attrs.contract_sections ?? {}) as { primary?: { customerId?: string | null } };
            customers[id] = String(sections.primary?.customerId ?? attrs.customer_id ?? '').trim();
          } catch {
            /* нет доступа к справочнику — договор останется без контрагента */
          }
          try {
            const res = await window.matrica.contractPayments.get(id).catch(() => null);
            payments[id] = res && res.ok ? (res.payments as ContractPayments) : null;
          } catch {
            payments[id] = null;
          }
        }),
      );
      if (!cancelled) {
        setContractCustomers(customers);
        setContractPayments(payments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [contractIds]);

  /** Этапы по заездам: «история ремонта от прихода до отгрузки». */
  const feedByVisit = useMemo(() => splitEngineHistoryByVisits(feed, views), [feed, views]);

  const contractLabel = useCallback(
    (id: string | null): string => {
      if (!id) return '—';
      return (props.contractOptions ?? []).find((o) => o.id === id)?.label ?? '—';
    },
    [props.contractOptions],
  );

  const customerLabel = useCallback(
    (view: EngineVisitView): string => {
      const resolved = resolveEngineVisitCustomer(view, new Map(Object.entries(contractCustomers)));
      if (!resolved.id) return '—';
      return (props.customerOptions ?? []).find((o) => o.id === resolved.id)?.label ?? '—';
    },
    [props.customerOptions, contractCustomers],
  );

  if (views.length === 0) {
    // Заездов ещё нет (двигатель не заезжал) — карточка движка всё равно нужна:
    // без неё оператор не смог бы завести первый приход.
    return (
      <div style={{ display: 'grid', gap: 10 }} data-engine-visits-empty>
        {props.renderCurrentCard ? props.renderCurrentCard() : null}
        <div className="ui-muted" style={{ fontSize: 13 }}>
          {status || 'Заездов пока нет: двигатель ещё не заезжал на завод.'}
        </div>
      </div>
    );
  }

  return (
    <div data-engine-visits style={{ display: 'grid', gap: 10 }}>
      {views.map((view) => {
        const items = feedByVisit.get(view.visitNo) ?? [];
        const payments = view.contractId
          ? engineVisitPayments({ contractPayments: contractPayments[view.contractId] ?? null, engineId: props.engineId })
          : null;
        const background = engineVisitToneBackground(view.tone);
        return (
          <details
            key={view.visitNo}
            open={view.role === 'current'}
            data-engine-visit={view.visitNo}
            data-engine-visit-role={view.role}
            data-engine-visit-tone={view.tone}
            style={{ background, borderRadius: 10, border: '1px solid var(--border)', padding: '8px 10px' }}
          >
            <summary style={{ cursor: 'pointer', fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
              <b>{view.title}</b>
              <span className="ui-muted">{view.subtitle}</span>
              <span>
                {dateLabel(view.arrivalDate)} — {dateLabel(view.shippingDate)}
              </span>
              <span className="ui-muted" style={{ fontSize: 11 }}>
                {view.role === 'current' ? 'текущий заезд' : 'прошлый заезд'}
              </span>
              {view.isReclamation ? (
                <span className="ui-muted" style={{ fontSize: 11 }}>рекламация</span>
              ) : null}
            </summary>

            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              {view.role === 'current' && props.renderCurrentCard ? props.renderCurrentCard() : null}

              {/* Реквизиты ЗАЕЗДА — свои для каждого заезда (свой договор, свой контрагент,
                  свои накладные). У карточки движка они свои — текущее состояние; путать их
                  нельзя, поэтому подписи здесь с «заезда». */}
              <div style={{ display: 'grid', gap: 4, fontSize: 13 }}>
                <div>
                  <span className="ui-muted">Договор заезда: </span>
                  {contractLabel(view.contractId)}
                </div>
                <div>
                  <span className="ui-muted">Контрагент заезда: </span>
                  {customerLabel(view)}
                </div>
                <div>
                  <span className="ui-muted">Накладные заезда: </span>
                  {view.arrivalInvoice || view.shipmentInvoice
                    ? `приход ${view.arrivalInvoice ?? '—'} · отгрузка ${view.shipmentInvoice ?? '—'}`
                    : '—'}
                </div>
              </div>

              {payments && payments.hasSlot ? (
                <div style={{ fontSize: 13 }}>
                  <span className="ui-muted">Оплачено по договору: </span>
                  {formatKopMoney(payments.paidKop)} ₽
                  {payments.priceKop != null ? ` из ${formatKopMoney(payments.priceKop)} ₽` : ''}
                  {payments.lastPaymentDate ? ` (последний платёж ${payments.lastPaymentDate})` : ''}
                </div>
              ) : null}

              <div style={{ fontSize: 13 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>История ремонта заезда</div>
                {!props.canViewOperations ? (
                  <div className="ui-muted" style={{ fontSize: 12 }}>
                    История ремонта доступна с правом на операции.
                  </div>
                ) : items.length === 0 ? (
                  <div className="ui-muted" style={{ fontSize: 12 }}>По этому заезду этапов не записано.</div>
                ) : (
                  <table className="engine-visit-table" style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr>
                        {['Дата', 'Этап', 'Цех', 'Примечание', 'Кто'].map((h) => (
                          <th key={h} style={{ textAlign: 'left', padding: '3px 6px', borderBottom: '1px solid var(--border)' }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id}>
                          <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>{dateLabel(item.at)}</td>
                          <td style={{ padding: '3px 6px' }}>{item.title}</td>
                          <td style={{ padding: '3px 6px' }}>{item.workshopName || '—'}</td>
                          <td style={{ padding: '3px 6px' }}>{item.note || item.reason || '—'}</td>
                          <td style={{ padding: '3px 6px' }}>{item.by || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}
