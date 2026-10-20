import React, { useEffect, useMemo, useState } from 'react';

import {
  ENGINE_BULK_INTAKE_MAX,
  engineBulkIntakeConflictingFields,
  engineBulkIntakeFieldList,
  engineBulkIntakeInternalNumberDuplicates,
  engineBulkIntakeMissingFields,
  engineBulkIntakeSummary,
  formatEngineInternalNumber,
  readBulkIntakeInternalNumber,
  splitEngineBulkIntakeNumbers,
  type EngineBulkIntakeAction,
  type EngineBulkIntakeField,
  type EngineBulkIntakeOffer,
  type EngineBulkIntakePreviewRow,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { EntityReferenceField } from './EntityReferenceField.js';
import { Input } from './Input.js';
import { Spinner } from './LoadingOverlay.js';
import { placeEngineIntoContractSlot } from '../utils/engineContractSlot.js';
import { mapEntityRowsToSearchOptions, type SearchableSelectOption } from '../utils/selectOptions.js';

export type EngineBulkIntakeResult = {
  created: number;
  /** Существующие карточки, в которые дописали недостающее. */
  updated: number;
  skipped: number;
  overPlan: number;
  slotErrors: number;
  /** Дата дефектовки была, а этап «Разборка/Дефектовка» не встал. */
  defectStageMissed: number;
  error?: string;
};

function toInputDate(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromInputDate(value: string): number | null {
  const v = String(value ?? '').trim();
  if (!v) return null;
  const ms = Date.parse(`${v}T12:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

function formatArrival(ms: number | null): string {
  const input = toInputDate(ms);
  if (!input) return 'дата не указана';
  const [y, m, d] = input.split('-');
  return `${d}.${m}.${y}`;
}

type RowState = { action: EngineBulkIntakeAction };

function effectiveAction(row: EngineBulkIntakePreviewRow, states: Record<string, RowState>): EngineBulkIntakeAction {
  if (!row.existing) return 'create';
  return states[row.key]?.action ?? 'skip';
}

/**
 * Пакетный приём двигателей списком («накладная»): номера вставляются из документа,
 * общие поля (марка, контрагент, договор, даты) — по желанию, на весь список.
 *
 * Решение по дублю принимает оператор: «пропустить» (двигатель уже есть),
 * «обновить» (дописать в карточку то, чего в ней нет — заполненное не трогаем) или
 * «повторный заезд» (тот же двигатель вернулся — новая карточка с флагом и
 * ссылкой на прежний заезд). Коллизию номера и рекламацию разбирают в карточке,
 * где видно весь контекст, — в списке таких путей нет.
 *
 * Внутренний номер — НЕ общее поле пачки: он уникален для двигателя (пара
 * номер+год), поэтому вводится построчно. Столбец из таблицы вставляется в первую
 * строку и расходится вниз.
 */
export function EngineBulkIntakeDialog(props: {
  open: boolean;
  canViewMasterData: boolean;
  onClose: () => void;
  /** Пачка обработана: родитель обновляет список и говорит оператору итог. */
  onCreated: (result: EngineBulkIntakeResult) => void | Promise<void>;
}) {
  const [brands, setBrands] = useState<SearchableSelectOption[]>([]);
  const [customers, setCustomers] = useState<SearchableSelectOption[]>([]);
  const [contracts, setContracts] = useState<SearchableSelectOption[]>([]);
  const [listsBusy, setListsBusy] = useState(false);
  const [brandId, setBrandId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [contractId, setContractId] = useState('');
  const [arrivalDate, setArrivalDate] = useState(toInputDate(Date.now()));
  const [defectDate, setDefectDate] = useState('');
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<EngineBulkIntakePreviewRow[]>([]);
  const [overflow, setOverflow] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, RowState>>({});
  const [internalNumbers, setInternalNumbers] = useState<Record<string, string>>({});
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const nowMs = useMemo(() => Date.now(), []);

  useEffect(() => {
    if (!props.open) return;
    setError('');
    setDraft('');
    setRows([]);
    setOverflow(0);
    setDecisions({});
    setInternalNumbers({});
    setBrandId('');
    setCustomerId('');
    setContractId('');
    setArrivalDate(toInputDate(Date.now()));
    setDefectDate('');
    if (!props.canViewMasterData) {
      setError(
        'Нет доступа к справочникам: марку, контрагента и договор выбрать не из чего. Двигатели заведутся с номерами — марку и договор дозаполните позже.',
      );
      return;
    }
    let alive = true;
    setListsBusy(true);
    void (async () => {
      try {
        const types = await window.matrica.admin.entityTypes.list();
        const byCode = new Map(types.map((t) => [String(t.code), String(t.id)] as const));
        const load = async (code: string): Promise<SearchableSelectOption[]> => {
          const typeId = byCode.get(code);
          if (!typeId) return [];
          try {
            return mapEntityRowsToSearchOptions(await window.matrica.admin.entities.listByEntityType(typeId));
          } catch {
            // Справочник в чужом разделе отказывает исключением — остальные не валим.
            return [];
          }
        };
        const [brandOptions, customerOptions, contractOptions] = await Promise.all([
          load('engine_brand'),
          load('customer'),
          load('contract'),
        ]);
        if (!alive) return;
        setBrands(brandOptions);
        setCustomers(customerOptions);
        setContracts(contractOptions);
      } catch (e) {
        if (alive) setError(`Справочники не загрузились: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (alive) setListsBusy(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [props.open, props.canViewMasterData]);

  // Превью дублей считает main: там реплика карточек, этапы и те же гейты, что у записи.
  useEffect(() => {
    if (!props.open) return;
    const text = draft.trim();
    if (!text) {
      setRows([]);
      setOverflow(0);
      setPreviewBusy(false);
      return;
    }
    let alive = true;
    setPreviewBusy(true);
    const timer = setTimeout(() => {
      void window.matrica.engines.bulkIntake
        .preview({ text })
        .then((r) => {
          if (!alive) return;
          if (r.ok) {
            setRows(r.preview.rows);
            setOverflow(r.preview.overflow);
          } else {
            setRows([]);
            setOverflow(0);
            setError(`Не удалось проверить список: ${r.error}`);
          }
        })
        .catch((e: unknown) => {
          if (alive) setError(`Не удалось проверить список: ${e instanceof Error ? e.message : String(e)}`);
        })
        .finally(() => {
          if (alive) setPreviewBusy(false);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [draft, props.open]);

  const contractOptions = useMemo(
    () => contracts.filter((o) => !customerId || (o.searchText ?? '').includes(customerId)),
    [contracts, customerId],
  );

  const items = useMemo(() => {
    const base: Omit<EngineBulkIntakeOffer, 'internalNumber' | 'internalNumberYear'> = {
      brandId: brandId || null,
      customerId: customerId || null,
      contractId: contractId || null,
      arrivalDate: fromInputDate(arrivalDate),
      defectDate: fromInputDate(defectDate),
    };
    return rows.map((row) => {
      const rawInternal = internalNumbers[row.key] ?? '';
      const internal = readBulkIntakeInternalNumber(rawInternal, nowMs);
      const offer: EngineBulkIntakeOffer = {
        ...base,
        internalNumber: internal.number,
        internalNumberYear: internal.year,
      };
      return {
        ...row,
        action: effectiveAction(row, decisions),
        rawInternal,
        internal,
        missing: (row.existing ? engineBulkIntakeMissingFields(row.existing, offer) : []) as EngineBulkIntakeField[],
        conflicts: (row.existing ? engineBulkIntakeConflictingFields(row.existing, offer) : []) as EngineBulkIntakeField[],
      };
    });
  }, [rows, decisions, internalNumbers, brandId, customerId, contractId, arrivalDate, defectDate, nowMs]);

  const summary = engineBulkIntakeSummary(items);
  const toCreate = summary.create + summary.repeat;
  const toUpdate = summary.update;
  const duplicates = items.filter((item) => item.existing);

  function setAllDuplicates(action: EngineBulkIntakeAction) {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const item of duplicates) {
        // «Обновить» имеет смысл только там, где есть чего дописывать.
        if (action === 'update' && item.missing.length === 0) continue;
        next[item.key] = { action };
      }
      return next;
    });
  }

  /** Вставка столбца из таблицы: значения расходятся по строкам ниже, занятые пропускаем. */
  function pasteInternalNumbers(startIndex: number, raw: string): boolean {
    const tokens = splitEngineBulkIntakeNumbers(raw);
    if (tokens.length < 2) return false;
    setInternalNumbers((prev) => {
      const next = { ...prev };
      for (let i = 0; i < tokens.length; i += 1) {
        const target = items[startIndex + i];
        if (!target) break;
        if (target.existing?.internalNumber) continue;
        next[target.key] = tokens[i] ?? '';
      }
      return next;
    });
    return true;
  }

  async function apply() {
    setError('');
    if (overflow > 0) {
      setError(
        `В списке ${rows.length} номеров, а за один раз принимаем не больше ${ENGINE_BULK_INTAKE_MAX}. ` +
          'Разделите список на части — иначе часть номеров молча потеряется.',
      );
      return;
    }
    if (toCreate === 0 && toUpdate === 0) {
      setError('Делать нечего: все номера уже есть в базе (или помечены «пропустить»).');
      return;
    }
    const repeatedInternal = engineBulkIntakeInternalNumberDuplicates(
      items
        .filter((item) => item.action !== 'skip' && item.internal.number)
        .map((item) => ({ number: String(item.internal.number), year: item.internal.year })),
    );
    if (repeatedInternal.length > 0) {
      setError(
        `Внутренний номер «${repeatedInternal.join('», «')}» указан у двух двигателей — в журнале пара номер+год одна. Поправьте столбец.`,
      );
      return;
    }
    setBusy(true);
    try {
      const r = await window.matrica.engines.bulkIntake.apply({
        brandId: brandId || null,
        customerId: customerId || null,
        contractId: contractId || null,
        arrivalDate: fromInputDate(arrivalDate),
        defectDate: fromInputDate(defectDate),
        rows: items
          .filter((item) => item.action !== 'skip')
          .map((item) => ({
            number: item.number,
            action: item.action,
            ...(item.action === 'repeat_arrival' && item.existing ? { previousEngineId: item.existing.id } : {}),
            ...(item.rawInternal.trim() ? { internalNumber: item.rawInternal.trim() } : {}),
          })),
      });
      const createdIds = r.ok ? r.createdIds : (r.createdIds ?? []);
      // Двигатель в договоре занимает плановое место: без этого шага он есть, а денег
      // под него в плане договора нет. Сбой слота карточку не отменяет — сообщаем итогом.
      // Дополненные карточки, которым договор дописали только сейчас, — тоже сюда.
      const slotTargets = [...createdIds, ...(r.ok ? r.contractedIds : (r.contractedIds ?? []))];
      let overPlan = 0;
      let slotErrors = 0;
      if (contractId) {
        for (const id of slotTargets) {
          const placed = await placeEngineIntoContractSlot({
            contractId,
            engineId: id,
            ...(brandId ? { engineBrandId: brandId } : {}),
          });
          if (!placed) {
            slotErrors += 1;
            continue;
          }
          if (placed.overPlan) overPlan += 1;
          if (!placed.sectionKey) continue;
          try {
            await window.matrica.engines.card.save({ id, fields: { contract_section_number: placed.sectionKey } });
          } catch {
            slotErrors += 1;
          }
        }
      }
      if (!r.ok) {
        await props.onCreated({
          created: createdIds.length,
          updated: r.updated ?? 0,
          skipped: summary.skip,
          overPlan,
          slotErrors,
          defectStageMissed: r.defectStageMissed ?? 0,
          error: r.error,
        });
        return;
      }
      // Пропущенные оператором строки в main не уходят — считаем их здесь, иначе итог
      // «пропущено: 0» выглядит как потеря номеров.
      await props.onCreated({
        created: r.created,
        updated: r.updated,
        skipped: r.skipped + summary.skip,
        overPlan,
        slotErrors,
        defectStageMissed: r.defectStageMissed,
      });
    } catch (e) {
      setError(`Не удалось завести карточки: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!props.open) return null;

  const canApply = !busy && toCreate + toUpdate > 0 && !overflow;
  const hintStyle: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #64748b)' };
  const applyLabel = busy
    ? 'Сохраняю…'
    : toCreate > 0 && toUpdate > 0
      ? `Завести ${toCreate} · дополнить ${toUpdate}`
      : toUpdate > 0
        ? `Дополнить карточки: ${toUpdate}`
        : `Завести карточки: ${toCreate}`;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(15,23,42,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        data-bulk-intake-dialog="true"
        style={{
          background: 'var(--surface, #fff)',
          borderRadius: 14,
          width: 'min(1080px, 96vw)',
          maxHeight: '92vh',
          overflow: 'auto',
          padding: 18,
          display: 'grid',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ fontWeight: 800, fontSize: 16, flex: '1 1 auto' }}>Принять двигатели списком</div>
          <Button variant="ghost" onClick={props.onClose} disabled={busy}>
            ✕ Закрыть
          </Button>
        </div>
        <div style={hintStyle}>
          Все поля ниже — по желанию: можно принять пачку только с номерами, а марку, договор, внутренние номера и даты
          дозаполнить позже тем же списком кнопкой «Обновить». Номера разделяйте пробелом, запятой, точкой с запятой
          или переводом строки.
        </div>

        {listsBusy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...hintStyle }}>
            <Spinner size={18} /> Загрузка справочников…
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={hintStyle}>Марка двигателя</span>
            <EntityReferenceField
              target="engine_brand"
              targetLabel="Марка двигателя"
              value={brandId || null}
              options={brands}
              placeholder={brands.length ? 'Начните набирать марку…' : 'Справочник марок пуст'}
              onChange={(next) => setBrandId(next ?? '')}
              disabled={busy}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={hintStyle}>Дата прихода</span>
            <Input
              type="date"
              value={arrivalDate}
              onChange={(e) => setArrivalDate(e.target.value)}
              disabled={busy}
              data-bulk-intake-arrival="true"
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={hintStyle}>Контрагент</span>
            <EntityReferenceField
              target="customer"
              targetLabel="Контрагент"
              value={customerId || null}
              options={customers}
              placeholder={customers.length ? 'Начните набирать контрагента…' : 'Справочник контрагентов пуст'}
              onChange={(next) => {
                setCustomerId(next ?? '');
                setContractId('');
              }}
              disabled={busy}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={hintStyle}>Номер договора</span>
            <EntityReferenceField
              target="contract"
              targetLabel="Договор"
              value={contractId || null}
              options={contractOptions}
              placeholder={customerId ? 'Начните набирать номер договора…' : 'Сначала выберите контрагента'}
              onChange={(next) => setContractId(next ?? '')}
              disabled={busy}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={hintStyle}>Дата дефектовки</span>
            <Input
              type="date"
              value={defectDate}
              onChange={(e) => setDefectDate(e.target.value)}
              disabled={busy}
              data-bulk-intake-defect="true"
            />
            <span style={hintStyle}>
              Ставится этапом «Разборка/Дефектовка» тем двигателям, у которых его ещё нет.
            </span>
          </label>
        </div>

        {(customers.length === 0 || contracts.length === 0) && !listsBusy && props.canViewMasterData && (
          <div style={{ fontSize: 13, color: '#b45309' }}>
            {customers.length === 0
              ? 'В базе нет контрагентов — двигатели заведутся без контрагента. Заведите его в справочнике, чтобы привязать пачку.'
              : 'В базе нет договоров — двигатели заведутся без договора. Заведите договор, чтобы пачка заняла места в плане.'}
          </div>
        )}

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={hintStyle}>Номера двигателей — вставьте список</span>
          <textarea
            data-bulk-intake-numbers="true"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            rows={6}
            placeholder={'Например:\n1234567\n7654321, 1112223\n4567890'}
            style={{
              width: '100%',
              resize: 'vertical',
              padding: 8,
              borderRadius: 8,
              border: '1px solid var(--input-border, #cbd5e1)',
              background: 'var(--input-bg, #fff)',
              fontFamily: 'monospace',
              fontSize: 13,
              lineHeight: 1.45,
            }}
          />
        </label>

        {previewBusy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...hintStyle }}>
            <Spinner size={18} /> Проверяю номера на дубли…
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>
                Номеров: <b>{rows.length}</b> · заведём: <b>{toCreate}</b> · дополним: <b>{toUpdate}</b> · пропустим:{' '}
                <b>{summary.skip}</b>
              </span>
              {duplicates.length > 0 && (
                <>
                  <span style={hintStyle}>Дубли ({duplicates.length}):</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAllDuplicates('skip')}>
                    всем «пропустить»
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAllDuplicates('update')}>
                    всем «обновить»
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAllDuplicates('repeat_arrival')}>
                    всем «повторный заезд»
                  </Button>
                </>
              )}
            </div>
            <div
              style={{
                maxHeight: 360,
                overflow: 'auto',
                border: '1px solid var(--border, #e2e8f0)',
                borderRadius: 10,
              }}
            >
              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--muted, #64748b)', fontSize: 12 }}>
                    <th style={{ padding: '6px 8px' }}>№</th>
                    <th style={{ padding: '6px 8px' }}>Номер</th>
                    <th style={{ padding: '6px 8px' }}>Внутренний номер</th>
                    <th style={{ padding: '6px 8px' }}>Что с ним</th>
                    <th style={{ padding: '6px 8px' }}>Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={`${item.key}#${index}`} style={{ borderTop: '1px solid var(--border, #e2e8f0)' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--muted, #64748b)' }}>{index + 1}</td>
                      <td style={{ padding: '6px 8px', fontFamily: 'monospace' }}>{item.number}</td>
                      <td style={{ padding: '6px 8px' }}>
                        {item.existing?.internalNumber ? (
                          <span
                            style={{ color: 'var(--muted, #64748b)' }}
                            title="В карточке уже стоит — «Обновить» его не перезапишет"
                          >
                            {formatEngineInternalNumber(item.existing.internalNumber, item.existing.internalNumberYear)}
                          </span>
                        ) : (
                          <Input
                            value={item.rawInternal}
                            placeholder="41/26"
                            disabled={busy}
                            data-bulk-intake-internal="true"
                            onChange={(e) =>
                              setInternalNumbers((prev) => ({ ...prev, [item.key]: e.target.value }))
                            }
                            onPaste={(e) => {
                              if (pasteInternalNumbers(index, e.clipboardData.getData('text'))) e.preventDefault();
                            }}
                            style={{ width: 110, fontFamily: 'monospace', fontSize: 12 }}
                          />
                        )}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {item.existing ? (
                          <span style={{ color: '#b45309' }}>
                            уже есть · приход {formatArrival(item.existing.arrivalDate)}
                            {item.existing.engineBrand ? ` · ${item.existing.engineBrand}` : ''}
                            {item.missing.length > 0 ? (
                              <div style={{ color: '#15803d' }}>
                                не хватает: {engineBulkIntakeFieldList(item.missing)}
                              </div>
                            ) : (
                              <div style={{ color: 'var(--muted, #64748b)' }}>всё уже есть</div>
                            )}
                            {item.conflicts.length > 0 && (
                              <div style={{ color: 'var(--muted, #64748b)', fontSize: 12 }}>
                                в карточке другое: {engineBulkIntakeFieldList(item.conflicts)} — не перезаписываю
                              </div>
                            )}
                          </span>
                        ) : (
                          <span style={{ color: '#15803d' }}>новый</span>
                        )}
                        {item.repeatedInBatch && (
                          <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--muted, #64748b)' }}>
                            в списке дважды
                          </span>
                        )}
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {item.existing ? (
                          <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                            <Button
                              size="sm"
                              variant={item.action === 'skip' ? 'primary' : 'ghost'}
                              disabled={busy}
                              onClick={() => setDecisions((p) => ({ ...p, [item.key]: { action: 'skip' } }))}
                            >
                              Пропустить
                            </Button>
                            <Button
                              size="sm"
                              variant={item.action === 'update' ? 'primary' : 'ghost'}
                              disabled={busy || item.missing.length === 0}
                              title={
                                item.missing.length === 0
                                  ? 'В карточке уже всё есть — дописывать нечего'
                                  : 'Дописать в карточку только то, чего в ней нет'
                              }
                              onClick={() => setDecisions((p) => ({ ...p, [item.key]: { action: 'update' } }))}
                            >
                              Обновить
                            </Button>
                            <Button
                              size="sm"
                              variant={item.action === 'repeat_arrival' ? 'primary' : 'ghost'}
                              disabled={busy}
                              onClick={() => setDecisions((p) => ({ ...p, [item.key]: { action: 'repeat_arrival' } }))}
                            >
                              Повторный заезд
                            </Button>
                          </span>
                        ) : (
                          <span style={{ color: 'var(--muted, #64748b)' }}>завести карточку</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {overflow > 0 && (
          <div style={{ fontSize: 13, color: '#b91c1c' }}>
            Номеров {rows.length} — это больше предела в {ENGINE_BULK_INTAKE_MAX} за один заход. Разделите список.
          </div>
        )}

        {error && <div style={{ fontSize: 13, color: '#b91c1c' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" disabled={busy} onClick={props.onClose}>
            Отмена
          </Button>
          <Button disabled={!canApply} onClick={() => void apply()}>
            {applyLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
