import React, { useEffect, useMemo, useState } from 'react';

import {
  ENGINE_BULK_INTAKE_MAX,
  engineBulkIntakeSummary,
  type EngineBulkIntakeAction,
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
  skipped: number;
  overPlan: number;
  slotErrors: number;
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
 * Пакетный приём двигателей списком («накладная»): одна марка, контрагент, договор и
 * дата прихода — на весь вставленный список номеров.
 *
 * Решение по дублю принимает оператор: «пропустить» (двигатель уже есть, заводить
 * второй нельзя) или «повторный заезд» (тот же двигатель вернулся — карточка
 * заводится с флагом и ссылкой на прежний заезд). Третьего пути в списке нет:
 * коллизию номера и рекламацию разбирают в карточке, где видно весь контекст.
 */
export function EngineBulkIntakeDialog(props: {
  open: boolean;
  canViewMasterData: boolean;
  onClose: () => void;
  /** Пачка заведена: родитель обновляет список и говорит оператору итог. */
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
  const [draft, setDraft] = useState('');
  const [rows, setRows] = useState<EngineBulkIntakePreviewRow[]>([]);
  const [overflow, setOverflow] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, RowState>>({});
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setError('');
    setDraft('');
    setRows([]);
    setOverflow(0);
    setDecisions({});
    setBrandId('');
    setCustomerId('');
    setContractId('');
    setArrivalDate(toInputDate(Date.now()));
    if (!props.canViewMasterData) {
      setError('Нет доступа к справочникам: марку, контрагента и договор выбрать не из чего. Обратитесь к администратору.');
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

  // Превью дублей считает main: там реплика карточек и те же гейты, что у записи.
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

  const items = useMemo(
    () => rows.map((row) => ({ ...row, action: effectiveAction(row, decisions) })),
    [rows, decisions],
  );
  const summary = engineBulkIntakeSummary(items);
  const toCreate = summary.create + summary.repeat;
  const duplicates = items.filter((item) => item.existing);

  function setAllDuplicates(action: EngineBulkIntakeAction) {
    setDecisions((prev) => {
      const next = { ...prev };
      for (const item of duplicates) next[item.key] = { action };
      return next;
    });
  }

  async function apply() {
    setError('');
    const arrivalMs = fromInputDate(arrivalDate);
    if (!brandId) {
      setError('Выберите марку двигателя — карточка без марки не заводится.');
      return;
    }
    if (!customerId) {
      setError('Не выбран контрагент: двигатели некуда добавить. Создайте контрагента в справочнике и вернитесь.');
      return;
    }
    if (!contractId) {
      setError('Не выбран договор: двигатели некуда добавить. Сначала заведите договор, потом принимайте двигатели.');
      return;
    }
    if (!arrivalMs) {
      setError('Укажите дату прихода — она ставится всем двигателям пачки.');
      return;
    }
    if (overflow > 0) {
      setError(
        `В списке ${rows.length} номеров, а за один раз принимаем не больше ${ENGINE_BULK_INTAKE_MAX}. ` +
          'Разделите список на части — иначе часть номеров молча потеряется.',
      );
      return;
    }
    if (toCreate === 0) {
      setError('Заводить нечего: все номера уже есть в базе (или помечены «пропустить»).');
      return;
    }
    setBusy(true);
    try {
      const r = await window.matrica.engines.bulkIntake.apply({
        brandId,
        customerId,
        contractId,
        arrivalDate: arrivalMs,
        rows: items
          .filter((item) => item.action !== 'skip')
          .map((item) => ({
            number: item.number,
            action: item.action,
            ...(item.action === 'repeat_arrival' && item.existing ? { previousEngineId: item.existing.id } : {}),
          })),
      });
      const createdIds = r.ok ? r.createdIds : (r.createdIds ?? []);
      // Двигатель в договоре занимает плановое место: без этого шага он есть, а денег
      // под него в плане договора нет. Сбой слота карточку не отменяет — сообщаем итогом.
      let overPlan = 0;
      let slotErrors = 0;
      for (const id of createdIds) {
        const placed = await placeEngineIntoContractSlot({ contractId, engineId: id, engineBrandId: brandId });
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
      if (!r.ok) {
        await props.onCreated({ created: createdIds.length, skipped: 0, overPlan, slotErrors, error: r.error });
        return;
      }
      await props.onCreated({ created: r.created, skipped: r.skipped, overPlan, slotErrors });
    } catch (e) {
      setError(`Не удалось завести карточки: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!props.open) return null;

  const canApply = !busy && toCreate > 0 && !overflow;
  const hintStyle: React.CSSProperties = { fontSize: 12, color: 'var(--muted, #64748b)' };

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
          width: 'min(980px, 96vw)',
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
          Одна марка, контрагент, договор и дата прихода — на весь список. Номера можно вставить из накладной:
          разделяйте их пробелом, запятой, точкой с запятой или переводом строки.
        </div>

        {listsBusy && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, ...hintStyle }}>
            <Spinner size={18} /> Загрузка справочников…
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(220px, 1fr))', gap: 12 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={hintStyle}>Марка двигателя *</span>
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
            <span style={hintStyle}>Дата прихода *</span>
            <Input
              type="date"
              value={arrivalDate}
              onChange={(e) => setArrivalDate(e.target.value)}
              disabled={busy}
              data-bulk-intake-arrival="true"
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={hintStyle}>Контрагент *</span>
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
            <span style={hintStyle}>Номер договора *</span>
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
        </div>

        {(customers.length === 0 || contracts.length === 0) && !listsBusy && (
          <div style={{ fontSize: 13, color: '#b91c1c' }}>
            {customers.length === 0
              ? 'В базе нет контрагентов — двигатели некуда добавить. Заведите контрагента в справочнике и вернитесь в это окно.'
              : 'В базе нет договоров — двигатели некуда добавить. Заведите договор и вернитесь в это окно.'}
          </div>
        )}

        <label style={{ display: 'grid', gap: 4 }}>
          <span style={hintStyle}>Номера двигателей * — вставьте список</span>
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
                Номеров: <b>{rows.length}</b> · заведём карточек: <b>{toCreate}</b> · пропустим: <b>{summary.skip}</b>
              </span>
              {duplicates.length > 0 && (
                <>
                  <span style={hintStyle}>Дубли ({duplicates.length}):</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAllDuplicates('skip')}>
                    всем «пропустить»
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAllDuplicates('repeat_arrival')}>
                    всем «повторный заезд»
                  </Button>
                </>
              )}
            </div>
            <div
              style={{
                maxHeight: 320,
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
                        {item.existing ? (
                          <span style={{ color: '#b45309' }}>
                            уже есть · приход {formatArrival(item.existing.arrivalDate)}
                            {item.existing.engineBrand ? ` · ${item.existing.engineBrand}` : ''}
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
                          <span style={{ display: 'inline-flex', gap: 6 }}>
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
            {busy ? 'Завожу карточки…' : `Завести карточки: ${toCreate}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
