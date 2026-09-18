import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatWorkSheetValue, type EngineListItem, type WorkSheetColumn, type WorkSheetRow, type WorkSheetType } from '@matricarmz/shared';

import type { CardCloseActions } from '../cardCloseTypes.js';
import { Button } from '../components/Button.js';
import { CardActionBar } from '../components/CardActionBar.js';
import { EntityCardShell } from '../components/EntityCardShell.js';
import { EntityReferenceField } from '../components/EntityReferenceField.js';
import { Input } from '../components/Input.js';
import { UnifiedDateInput } from '../components/UnifiedDateInput.js';
import type { SearchSelectOption } from '../components/SearchSelect.js';
import { WorkSheetFieldEditor, fromWorkSheetDateInput, toWorkSheetDateInput } from '../components/WorkSheetFieldEditor.js';
import type { WorkshopOption } from '../components/WorkSheetTypeEditorDialog.js';
import { formatEngineGateLabel } from '../utils/assemblyDuplicateGate.js';
import { buildEngineSearchOptions } from '../utils/selectOptions.js';
import { askWorkSheetDuplicate } from '../utils/workSheetDuplicateGate.js';
import { loadWorkSheetTypes } from '../utils/workSheetTypesCache.js';
import { useConfirm } from '../components/ConfirmContext.js';

/**
 * Карточка этапа работ (владелец 15.09.2026): «как у нас вся система работает — есть
 * карточки, есть списки карточек». Один этап работ = одна запись истории ремонта = одна
 * карточка; двигатель в ней ровно один.
 *
 * Новый этап работ заводится ТОЙ ЖЕ карточкой: id генерирует список при открытии, а запись
 * появляется только по «Сохранить» — пустых этапов работ в истории ремонта не остаётся.
 *
 * Реквизиты двигателя (марка, внутренний номер, заказчик, договор) не вводятся: они приходят
 * из его карточки и показываются справкой — их подставляет номер двигателя.
 */
export function WorkSheetDetailsPage(props: {
  rowId: string;
  isNew: boolean;
  initialTypeCode: string | null;
  canEdit: boolean;
  engines: EngineListItem[];
  workshops: WorkshopOption[];
  onOpenEngine: (id: string) => void;
  onSaved?: (result: { repair: { applied: boolean; reason?: string } | null; typeName: string }) => void;
  onClose: () => void;
  registerCardCloseActions?: (actions: CardCloseActions | null) => void;
}) {
  const [types, setTypes] = useState<WorkSheetType[]>([]);
  const [row, setRow] = useState<WorkSheetRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const { pickChoice } = useConfirm();

  const [typeCode, setTypeCode] = useState('');
  const [engineId, setEngineId] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [workshopId, setWorkshopId] = useState('');
  const [note, setNote] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>({});
  const dirtyRef = useRef(false);
  const markDirty = () => {
    dirtyRef.current = true;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const typesRes = await loadWorkSheetTypes();
      setTypes(typesRes.rows);
      if (props.isNew) {
        setRow(null);
        setTypeCode(props.initialTypeCode ?? typesRes.rows[0]?.code ?? '');
        setEngineId(null);
        setDate(toWorkSheetDateInput(Date.now()));
        setWorkshopId('');
        setNote('');
        setValues({});
      } else {
        const res = await window.matrica.workSheets.rows.get(props.rowId);
        if (!res.ok) {
          setStatus(`Ошибка: ${res.error}`);
          return;
        }
        setRow(res.row);
        setTypeCode(res.row.typeCode);
        setEngineId(res.row.engineId);
        setDate(toWorkSheetDateInput(res.row.at));
        setWorkshopId(res.row.workshopId);
        setNote(res.row.note);
        const next: Record<string, unknown> = {};
        for (const f of res.row.fields) next[f.code] = f.value;
        setValues(next);
      }
      dirtyRef.current = false;
      setStatus('');
    } finally {
      setLoading(false);
    }
  }, [props.rowId, props.isNew, props.initialTypeCode]);

  useEffect(() => {
    void load();
  }, [load]);

  const type = useMemo(() => types.find((t) => t.code === typeCode) ?? null, [types, typeCode]);

  // Вид работ может быть недоступен: клиент офлайн (справочник — REST) или вид заведён в
  // архив. Правку это пустить под откос не должно — этап работ самоописываем, его поля несут
  // подпись и тип с собой.
  const rowColumns = useMemo<WorkSheetColumn[]>(
    () => (row?.fields ?? []).map((f) => ({ code: f.code, label: f.label || f.code, type: f.type })),
    [row],
  );
  const effectiveType = useMemo(() => {
    if (type) return type;
    if (props.isNew || !row) return null;
    // completesRepair здесь false намеренно: статус ставится только при СОЗДАНИИ этапа работ,
    // а это ветка правки — подставлять сюда догадку о чужом виде работ незачем.
    return { id: row.typeId, code: row.typeCode, name: row.typeName, completesRepair: false, columns: rowColumns, workshopId: null };
  }, [type, props.isNew, row, rowColumns]);
  const columns = effectiveType?.columns ?? [];

  // Смена вида работ у НОВОГО этапа подставляет его цех; поля чужого вида не переносим.
  useEffect(() => {
    if (!props.isNew) return;
    setWorkshopId(type?.workshopId ?? '');
    setValues({});
  }, [props.isNew, type?.code, type?.workshopId]);

  const engineOptions: SearchSelectOption[] = useMemo(() => buildEngineSearchOptions(props.engines), [props.engines]);

  /**
   * Справка по двигателю — то, что владелец назвал «взаимно помогающим»: ввели номер (или
   * внутренний номер — он же ищется тем же полем), и марка, внутренний номер, заказчик и
   * договор подставляются сами. Для сохранённого этапа работ берём его же посчитанные реквизиты,
   * для нового — каталог двигателей, уже загруженный приложением.
   */
  const engineFacts = useMemo(() => {
    if (row && row.engineId === engineId) {
      return {
        brand: row.engineBrand,
        internal: row.internalNumber,
        customer: row.customerName,
        customerFull: row.customerFullName,
        contract: row.contractShortLabel,
        contractFull: row.contractNumber,
      };
    }
    const picked = props.engines.find((e) => e.id === engineId);
    return picked
      ? { brand: picked.engineBrand ?? '', internal: picked.internalNumberFull ?? '', customer: '', customerFull: '', contract: '', contractFull: '' }
      : null;
  }, [row, engineId, props.engines]);

  const save = useCallback(
    async (opts: { close?: boolean } = {}) => {
      if (!effectiveType) return setStatus('Выберите вид работ');
      if (!engineId) return setStatus('Выберите двигатель');
      const atMs = fromWorkSheetDateInput(date);
      if (!atMs) return setStatus('Укажите дату');
      setBusy(true);
      setStatus('');
      try {
        const payload = {
          id: props.rowId,
          engineId,
          type: {
            id: effectiveType.id,
            code: effectiveType.code,
            name: effectiveType.name,
            completesRepair: effectiveType.completesRepair,
            columns: effectiveType.columns,
            workshopId: effectiveType.workshopId,
          },
          atMs,
          workshopId: workshopId || null,
          // Имя цеха — снимком в этап работ: без него читатель без прав на справочник видит uuid.
          workshopName: props.workshops.find((w) => w.id === workshopId)?.label ?? null,
          note: note.trim() || null,
          values,
        };
        // Путь записи один на создание, правку и повтор после гейта: второй вызов разъехался
        // бы с первым по payload.
        const writeRow = (repeatPass?: number) =>
          window.matrica.workSheets.rows.save({ ...payload, ...(repeatPass ? { repeatPass } : {}) });

        let r = await writeRow();
        // Совпало с уже внесённой строкой — это вопрос к оператору, а не ошибка. Спрашиваем и,
        // если он говорит «двигатель вернулся», сохраняем повторно с номером прохода.
        if (!r.ok && r.duplicate) {
          const decision = await askWorkSheetDuplicate({
            duplicate: r.duplicate,
            engineLabel: formatEngineGateLabel(props.engines.find((e) => e.id === engineId) ?? {}),
            pickChoice,
          });
          if (decision.action !== 'repeat') {
            setStatus('Не сохранено: такой этап за этот день уже есть');
            return;
          }
          r = await writeRow(decision.pass);
        }
        if (!r.ok) {
          setStatus(`Ошибка: ${r.error}`);
          return;
        }
        dirtyRef.current = false;
        window.dispatchEvent(new Event('matrica:engines-changed'));
        props.onSaved?.({ repair: r.repair, typeName: effectiveType.name });
        if (opts.close) props.onClose();
        else {
          await load();
          setStatus('Сохранено');
        }
      } catch (e) {
        setStatus(`Ошибка: ${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- props пересоздаётся каждый рендер; зависим от редактируемых значений
    [effectiveType, engineId, date, workshopId, note, values, props.rowId, load, pickChoice],
  );

  const remove = async () => {
    if (props.isNew || !row) return;
    if (!window.confirm(`Удалить этап работ «${row.typeName}» от ${formatWorkSheetValue({ type: 'date', value: row.at })}?`)) return;
    // Второй вопрос — только если откатывать ЕСТЬ ЧТО: статус поставил этот этап работ.
    const rollbackRepair =
      row.repairStamped && window.confirm('Этот этап работ поставил двигателю «Отремонтирован». Снять отметку вместе с ним?');
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.rows.delete(row.id, { rollbackRepair });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      dirtyRef.current = false;
      window.dispatchEvent(new Event('matrica:engines-changed'));
      props.onClose();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!props.registerCardCloseActions) return;
    props.registerCardCloseActions({
      isDirty: () => dirtyRef.current,
      saveAndClose: async () => {
        await save({ close: true });
      },
      reset: async () => {
        await load();
      },
      // Только сбросить несохранённое. Закрывать вкладку отсюда НЕЛЬЗЯ: этот путь проходит и
      // обычная навигация (уход с карточки закрывает её сессию), а `onClose` зануляет id
      // карточки — и вкладка исчезала с полосы при каждом переключении. Карточка этапа работ
      // была единственной, кто так делал; двигатель и договор здесь только чистят черновик,
      // а вкладку закрывает оболочка. Из-за этого этап работ не мог стать фоновой карточкой —
      // и значок ⑃ «2 рядом» на нём не появлялся вовсе.
      closeWithoutSave: () => {
        dirtyRef.current = false;
      },
      // Копии этапа работ нет и не планируется: он привязан к одному двигателю и одной дате,
      // а «копия» такой записи — это новый этап работ, который заводят кнопкой в списке.
      copyToNew: async () => {},
    });
    return () => {
      props.registerCardCloseActions?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- перерегистрация намеренно завязана на редактируемые значения, которые замыкают действия закрытия
  }, [save, load, props.registerCardCloseActions]);

  const setValue = (code: string, v: unknown) => {
    markDirty();
    setValues((prev) => ({ ...prev, [code]: v }));
  };
  const label = (text: string) => <span style={{ fontSize: 12, color: 'var(--subtle)' }}>{text}</span>;
  const fact = (text: string) => <span style={{ fontSize: 13 }}>{text || '—'}</span>;

  const title = props.isNew
    ? 'Новый этап работ'
    : `Этап работ «${row?.typeName ?? effectiveType?.name ?? ''}»${row?.engineNumber ? ` · ${row.engineNumber}` : ''}`;

  return (
    <EntityCardShell
      title={title}
      layout="stack"
      contentMaxWidth={900}
      cardActions={
        <CardActionBar
          canEdit={props.canEdit && !busy}
          cardLabel={title}
          {...(props.canEdit ? { onSave: () => void save() } : {})}
          {...(props.canEdit ? { onSaveAndClose: () => void save({ close: true }) } : {})}
          {...(props.canEdit ? { onReset: () => void load() } : {})}
          {...(props.canEdit && !props.isNew ? { onDelete: () => void remove(), deleteLabel: 'Удалить этап работ', deleteSkipBuiltInConfirm: true } : {})}
          onClose={props.onClose}
        />
      }
      status={status ? <span style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</span> : null}
    >
      {loading ? (
        <div className="ui-muted">Загрузка…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '8px 12px', alignItems: 'center' }} data-work-sheet-card>
          {label('Вид работ')}
          <select
            value={typeCode}
            disabled={!props.canEdit || !props.isNew}
            onChange={(e) => {
              markDirty();
              setTypeCode(e.target.value);
            }}
            data-work-sheet-type-select
          >
            {type === null && effectiveType !== null ? <option value={effectiveType.code}>{effectiveType.name}</option> : null}
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>

          {label('Двигатель')}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <EntityReferenceField
                target="engine"
                targetLabel="Двигатель"
                value={engineId}
                options={engineOptions}
                optionsReady={props.engines.length > 0}
                disabled={!props.canEdit || !props.isNew}
                placeholder="Номер двигателя или внутренний №…"
                onChange={(next) => {
                  markDirty();
                  setEngineId(next);
                }}
                onOpen={props.onOpenEngine}
              />
            </div>
            {engineId ? (
              <Button variant="ghost" onClick={() => props.onOpenEngine(engineId)} title="Открыть карточку двигателя" data-work-sheet-open-engine>
                ↗ Двигатель
              </Button>
            ) : null}
          </div>

          {label('Марка')}
          {fact(engineFacts?.brand ?? '')}
          {label('Внутр. №')}
          {fact(engineFacts?.internal ?? '')}
          {label('Заказчик')}
          <span style={{ fontSize: 13 }} title={engineFacts?.customerFull || undefined}>
            {engineFacts?.customer || '—'}
          </span>
          {label('Договор')}
          <span style={{ fontSize: 13 }} title={engineFacts?.contractFull || undefined}>
            {engineFacts?.contract || '—'}
          </span>

          {label('Дата')}
          <UnifiedDateInput
            type="date"
            value={date}
            disabled={!props.canEdit}
            onChange={(e) => {
              markDirty();
              setDate(e.target.value);
            }}
            data-work-sheet-date
          />

          {label('Цех')}
          <select
            value={workshopId}
            disabled={!props.canEdit}
            onChange={(e) => {
              markDirty();
              setWorkshopId(e.target.value);
            }}
          >
            <option value="">—</option>
            {props.workshops.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>

          {/* Справочно, только чтение: сервер сам ставит сюда того, кто записал строку
              последним. Печатать в бланке то, чего оператор в карточке не видит, нельзя. */}
          {!props.isNew ? (
            <>
              {label('Кто записал')}
              <span className="ui-muted">{row?.performedBy || '—'}</span>
            </>
          ) : null}

          {columns.map((col) => (
            <React.Fragment key={col.code}>
              {label(`${col.label}${col.required ? ' *' : ''}`)}
              <WorkSheetFieldEditor column={col} value={values[col.code]} disabled={!props.canEdit} onChange={(v) => setValue(col.code, v)} />
            </React.Fragment>
          ))}

          {label('Примечание')}
          <Input
            value={note}
            disabled={!props.canEdit}
            onChange={(e) => {
              markDirty();
              setNote(e.target.value);
            }}
          />

          {props.isNew && type?.completesRepair ? (
            <>
              <span />
              <span className="ui-muted" style={{ fontSize: 12 }} data-work-sheet-completes-hint>
                Этап работ «{type.name}» завершает ремонт: в карточке двигателя встанет «Отремонтирован» датой этапа работ.
              </span>
            </>
          ) : null}
        </div>
      )}
    </EntityCardShell>
  );
}
