import React, { useCallback, useEffect, useMemo, useState } from 'react';

import {
  buildEngineVisits,
  engineVisitPayments,
  formatKopMoney,
  parseContractPayments,
  parseContractSections,
  resolveEngineVisitCustomer,
  type ContractPayments,
  type EngineReclamationDto,
} from '@matricarmz/shared';

import { formatMoscowDate } from '../utils/dateUtils.js';

/**
 * Вкладка «История заездов» карточки двигателя (владелец 19.11.2026, промт КАРМАНА #42).
 *
 * «История заезда двигателя с одним и тем же номером, скорее всего, лучше заносить в
 * одну и ту же карточку двигателя: сделать вкладку „История заездов“ и хранить данные
 * там. Но в каждом заезде могут быть разные договоры, разные поставщики и заказчики —
 * поэтому по каждому заезду это заполняется отдельно».
 *
 * Что в ленте:
 *  · **основной цикл** карточки — приход, отправка, договор и контрагент с карточки,
 *    накладные с карточки;
 *  · **рекламации** карточки — свои даты, свой дефект и акт, СВОЙ договор, контрагент
 *    и накладные (движок мог вернуться по рекламации уже по другому договору);
 *  · **старые заезды** — карточки с тем же номером, помеченные как архивные: другой
 *    заезд того же двигателя виден тут же, а не в другом списке.
 *
 * Владелец 20.11.2026 (дополнение к объёму): «ну ладно история ремонта она вобще
 * отдельно идет во вкладке история ремонта, но тут хотя бы знать когда приехал в тот
 * заезд когда уехал какой номер накладных был, сколько по контракту наверно там
 * оплачено было». Поэтому в строке заезда — ещё и накладные и оплаты по его договору.
 *
 * Разделение «текущее / вся история»: карточка («Основное») — это текущая информация,
 * здесь — вся история по движениям. Старые даты в текущие поля карточки не подставляются.
 *
 * Заказчик заезда берётся из ЕГО договора (правило `resolveEngineVisitCustomer` — то же,
 * что у карточки), и только если договора нет — из поля самой строки. Поэтому в ленте
 * один источник правды, а не две копии заказчика.
 */
export type EngineArrivalsTabProps = {
  engineId: string;
  /** Номер двигателя — по нему находятся старые заезды с тем же номером. */
  engineNumber: string;
  /** Даты и стороны основного цикла — с карточки. */
  mainArrivalDate?: number | null;
  mainShippingDate?: number | null;
  mainContractId?: string | null;
  mainCustomerId?: string | null;
  /** Накладные основного цикла — с карточки (у рекламации свои, в строке заезда). */
  mainArrivalInvoice?: string | null;
  mainShipmentInvoice?: string | null;
  /**
   * Старые заезды — карточки с тем же номером. Список приходит из подсказки о дублях
   * карточки (`dupMatches.exact`): второй запрос по парку не делается.
   */
  siblings?: Array<{
    id: string;
    engineNumber: string;
    engineBrand: string;
    arrivalDate?: number | null;
    /** Роль в группе заездов: «архивный заезд 2024 (1 из 2)». */
    roleLabel?: string | undefined;
  }>;
  /** Подписи договоров и контрагентов (из справочников карточки). */
  contractOptions?: Array<{ id: string; label: string }>;
  customerOptions?: Array<{ id: string; label: string }>;
  /** Открыть карточку другого заезда (старый заезд по тому же номеру). */
  onOpenEngine?: (engineId: string) => void;
};

/** Что известно о старом заезде (карточке с тем же номером). */
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

/** Договор заезда: контрагент (из договора) и платежи по нему. */
type ContractInfo = {
  customerId: string;
  payments: ContractPayments | null;
};

type ArrivalRow = {
  key: string;
  kind: 'main' | 'reclamation' | 'archived';
  /** Подпись заезда: «Основной цикл» / «Рекламация №1» / «Старый заезд 2024». */
  label: string;
  arrivalDate: number | null;
  shippingDate: number | null;
  contractId: string | null;
  customerId: string | null;
  arrivalInvoice: string | null;
  shipmentInvoice: string | null;
  /** Дефект по заезду (рекламация) — для истории. */
  defect: string | null;
  /** Номер акта исследования (рекламация). */
  actNumber: string | null;
  /** Карточка другого заезда — для «старых заездов». */
  siblingEngineId: string | null;
  /** Роль в группе заездов: «архивный заезд 2024 (1 из 2)». */
  roleNote: string | null;
  /** Сквозной номер заезда — по времени прихода. */
  no: number;
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
  if (ms == null) return '—';
  return formatMoscowDate(new Date(ms));
}

export function EngineArrivalsTab(props: EngineArrivalsTabProps) {
  const [reclamations, setReclamations] = useState<EngineReclamationDto[]>([]);
  const [siblings, setSiblings] = useState<SiblingVisit[]>([]);
  /** Договоры заездов: контрагент (из договора) и платежи по нему. */
  const [contractInfo, setContractInfo] = useState<Record<string, ContractInfo>>({});
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const siblingKey = (props.siblings ?? []).map((s) => `${s.id}:${s.arrivalDate ?? ''}`).join('|');

  const load = useCallback(async () => {
    if (!props.engineId) return;
    setLoading(true);
    setStatus('');
    try {
      const res = await window.matrica.engineReclamations.list(props.engineId);
      if (res.ok) setReclamations(res.rows ?? []);
      else setStatus(res.error);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
    // Старые заезды: карточку читаем по одной — из неё нужны её договор, накладные и
    // дата отправки. Нет доступа к справочнику — заезд просто покажется беднее.
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
      details.sort((a, b) => (a.arrivalDate ?? 0) - (b.arrivalDate ?? 0));
      setSiblings(details);
    } catch {
      /* старые заезды просто не покажем — лента остаётся рабочей */
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.engineId, siblingKey]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Заезды этой карточки: основной цикл + рекламации (домен `buildEngineVisits`). */
  const ownVisits = useMemo(
    () =>
      buildEngineVisits({
        mainArrivalDate: props.mainArrivalDate ?? null,
        mainShippingDate: props.mainShippingDate ?? null,
        mainContractId: props.mainContractId ?? null,
        mainCustomerId: props.mainCustomerId ?? null,
        mainArrivalInvoice: props.mainArrivalInvoice ?? null,
        mainShipmentInvoice: props.mainShipmentInvoice ?? null,
        reclamations,
      }),
    [
      props.mainArrivalDate,
      props.mainShippingDate,
      props.mainContractId,
      props.mainCustomerId,
      props.mainArrivalInvoice,
      props.mainShipmentInvoice,
      reclamations,
    ],
  );

  /** Все договоры ленты — чтобы один раз прочитать контрагента и платежи каждого. */
  const contractIds = useMemo(() => {
    const ids = new Set<string>();
    for (const visit of ownVisits) if (visit.contractId) ids.add(visit.contractId);
    for (const s of siblings) if (s.contractId) ids.add(s.contractId);
    return Array.from(ids).sort();
  }, [ownVisits, siblings]);

  useEffect(() => {
    if (contractIds.length === 0) return undefined;
    let cancelled = false;
    void (async () => {
      const map: Record<string, ContractInfo> = {};
      await Promise.all(
        contractIds.map(async (id) => {
          try {
            const contract = await window.matrica.admin.entities.get(id);
            const attrs = ((contract as { attributes?: Record<string, unknown> } | null)?.attributes ?? {}) as Record<string, unknown>;
            const sections = parseContractSections(attrs);
            // Платежи договора — строгая реплика (`contractPayments:get`), тот же источник,
            // что и вкладка «Платежи» двигателя: один счёт на две точки, цифры не разойдутся.
            const res = await window.matrica.contractPayments.get(id).catch(() => null);
            map[id] = {
              customerId: String(sections.primary.customerId ?? attrs.customer_id ?? '').trim(),
              payments: res && res.ok ? parseContractPayments(res.payments) : null,
            };
          } catch {
            /* нет доступа к справочнику — договор останется без контрагента и платежей */
          }
        }),
      );
      if (!cancelled) setContractInfo(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [contractIds]);

  const customerByContract = useMemo(
    () => new Map(Object.entries(contractInfo).map(([id, info]) => [id, info.customerId])),
    [contractInfo],
  );

  /** Строки ленты: все заезды номера по времени прихода. */
  const rows = useMemo<ArrivalRow[]>(() => {
    const out: ArrivalRow[] = [];
    ownVisits.forEach((visit, index) => {
      const reclamation = visit.reclamation;
      out.push({
        key: `own-${visit.visitNo}-${index}`,
        kind: visit.kind,
        label: visit.label,
        arrivalDate: visit.arrivalDate,
        shippingDate: visit.shippingDate,
        contractId: visit.contractId,
        customerId: visit.customerId,
        arrivalInvoice: visit.arrivalInvoice,
        shipmentInvoice: visit.shipmentInvoice,
        defect: reclamation ? (reclamation.actualDefect ?? reclamation.customerReason ?? null) : null,
        actNumber: reclamation ? reclamation.actNumber ?? null : null,
        siblingEngineId: null,
        roleNote: null,
        no: 0,
      });
    });
    for (const s of siblings) {
      const year = s.arrivalDate != null ? new Date(s.arrivalDate).getFullYear() : null;
      out.push({
        key: `sib-${s.engineId}`,
        kind: 'archived',
        label: year != null ? `Старый заезд ${year}` : 'Старый заезд',
        arrivalDate: s.arrivalDate,
        shippingDate: s.shippingDate,
        contractId: s.contractId,
        customerId: s.customerId,
        arrivalInvoice: s.arrivalInvoice,
        shipmentInvoice: s.shipmentInvoice,
        defect: null,
        actNumber: null,
        siblingEngineId: s.engineId,
        roleNote: s.roleLabel,
        no: 0,
      });
    }
    // Порядок — по времени прихода; без даты — в конец. Тот же порядок, что и «заезды не
    // пересекаются»: сначала основной цикл, потом рекламации.
    return out
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const da = a.row.arrivalDate ?? Number.POSITIVE_INFINITY;
        const db = b.row.arrivalDate ?? Number.POSITIVE_INFINITY;
        if (da !== db) return da - db;
        return a.index - b.index;
      })
      .map((entry, i) => ({ ...entry.row, no: i + 1 }));
  }, [ownVisits, siblings]);

  const contractLabel = useCallback(
    (id: string | null): string => {
      if (!id) return '—';
      return (props.contractOptions ?? []).find((o) => o.id === id)?.label ?? '—';
    },
    [props.contractOptions],
  );

  const customerLabel = useCallback(
    (contractId: string | null, customerId: string | null): string => {
      const resolved = resolveEngineVisitCustomer({ contractId, customerId }, customerByContract);
      if (!resolved.id) return '—';
      return (props.customerOptions ?? []).find((o) => o.id === resolved.id)?.label ?? '—';
    },
    [props.customerOptions, customerByContract],
  );

  /** Оплаты заезда — по слоту двигателя в его договоре (тот же счёт, что на вкладке «Платежи»). */
  const paymentsOf = useCallback(
    (contractId: string | null) => {
      const info = contractId ? contractInfo[contractId] : undefined;
      return engineVisitPayments({ contractPayments: info?.payments ?? null, engineId: props.engineId });
    },
    [contractInfo, props.engineId],
  );

  const invoicesLabel = useCallback((row: ArrivalRow): string => {
    const parts: string[] = [];
    if (row.arrivalInvoice) parts.push(`приход ${row.arrivalInvoice}`);
    if (row.shipmentInvoice) parts.push(`отгрузка ${row.shipmentInvoice}`);
    return parts.length ? parts.join(' · ') : '—';
  }, []);

  return (
    <div data-engine-arrivals-tab style={{ width: '100%', maxWidth: 1400, margin: '0 auto', display: 'grid', gap: 12 }}>
      <div className="ui-muted" style={{ fontSize: 12 }}>
        Текущая информация — на вкладке «Основное». Здесь вся история заездов: приходы, отъезды, свои договоры,
        контрагенты, накладные и оплаты по каждому заезду.
      </div>

      {status ? (
        <div style={{ fontSize: 12, color: 'var(--danger, #b91c1c)' }} data-engine-arrivals-status>
          {status}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="ui-muted" style={{ fontSize: 13 }} data-engine-arrivals-empty>
          {loading ? 'Загружаем заезды…' : 'Заездов пока нет: двигатель ещё не заезжал на завод.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table data-engine-arrivals-table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                {['№', 'Заезд', 'Приход', 'Отправка', 'Договор', 'Контрагент', 'Накладные', 'Оплачено по договору', 'Дефект и акт', ''].map((h, i) => (
                  <th
                    key={`${i}-${h}`}
                    style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const payments = paymentsOf(row.contractId);
                return (
                  <tr key={row.key} data-engine-arrival-row={row.key} data-engine-arrival-kind={row.kind}>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--subtle)' }}>{row.no}</td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontWeight: 600 }}>{row.label}</span>
                      {row.roleNote ? <div className="ui-muted" style={{ fontSize: 11 }}>{row.roleNote}</div> : null}
                    </td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{dateLabel(row.arrivalDate)}</td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>{dateLabel(row.shippingDate)}</td>
                    <td style={{ padding: '4px 8px' }}>{contractLabel(row.contractId)}</td>
                    <td style={{ padding: '4px 8px' }}>{customerLabel(row.contractId, row.customerId)}</td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }} data-engine-arrival-invoices={row.key}>
                      {invoicesLabel(row)}
                    </td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }} data-engine-arrival-paid={row.key}>
                      {payments.hasSlot ? (
                        <>
                          <div>
                            {formatKopMoney(payments.paidKop)} ₽
                            {payments.priceKop != null ? ` из ${formatKopMoney(payments.priceKop)} ₽` : ''}
                          </div>
                          {payments.lastPaymentDate ? (
                            <div className="ui-muted" style={{ fontSize: 11 }}>последний платёж {payments.lastPaymentDate}</div>
                          ) : null}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ padding: '4px 8px' }}>
                      {row.defect ? <div>{row.defect}</div> : null}
                      {row.actNumber ? <div className="ui-muted" style={{ fontSize: 11 }}>Акт {row.actNumber}</div> : null}
                      {!row.defect && !row.actNumber ? '—' : null}
                    </td>
                    <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                      {row.siblingEngineId && props.onOpenEngine ? (
                        <button
                          type="button"
                          data-engine-arrival-open={row.siblingEngineId}
                          onClick={() => props.onOpenEngine?.(row.siblingEngineId as string)}
                          style={{ fontSize: 12, background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                        >
                          Открыть карточку
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
