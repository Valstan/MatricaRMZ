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
import { buildEngineSearchOptions } from '../utils/selectOptions.js';
import { loadWorkSheetTypes } from '../utils/workSheetTypesCache.js';

/**
 * Карточка ведомости работ (владелец 15.09.2026): «как у нас вся система работает — есть
 * карточки, есть списки карточек». Одна ведомость = одна запись истории ремонта = одна
 * карточка; двигатель в ней ровно один.
 *
 * Новая ведомость заводится ТОЙ ЖЕ карточкой: id генерирует список при открытии, а запись
 * появляется только по «Сохранить» — пустых ведомостей в истории ремонта не остаётся.
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
  // архив. Правку это пустить под откос не должно — ведомость самоописываема, её поля несут
  // подпись и тип с собой.
  const rowColumns = useMemo<WorkSheetColumn[]>(
    () => (row?.fields ?? []).map((f) => ({ code: f.code, label: f.label || f.code, type: f.type })),
    [row],
  );
  const effectiveType = useMemo(() => {
    if (type) return type;
    if (props.isNew || !row) return null;
    // completesRepair здесь false намеренно: статус ставится только при СОЗДАНИИ ведомости,
    // а это ветка правки — подставлять сюда догадку о чужом виде работ незачем.
    return { id: row.typeId, code: row.typeCode, name: row.typeName, completesRepair: false, columns: rowColumns, workshopId: null };
  }, [type, props.isNew, row, rowColumns]);
  const columns = effectiveType?.columns ?? [];

  // Смена вида работ у НОВОЙ ведомости подставляет его цех; поля чужого вида не переносим.
  useEffect(() => {
    if (!props.isNew) return;
    setWorkshopId(type?.workshopId ?? '');
    setValues({});
  }, [props.isNew, type?.code, type?.workshopId]);

  const engineOptions: SearchSelectOption[] = useMemo(() => buildEngineSearchOptions(props.engines), [props.engines]);

  /**
   * Справка по двигателю — то, что владелец назвал «взаимно помогающим»: ввели номер (или
   * внутренний номер — он же ищется тем же полем), и марка, внутренний номер, заказчик и
   * договор подставляются сами. Для сохранённой ведомости берём её же посчитанные реквизиты,
   * для новой — каталог двигателей, уже загруженный приложением.
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
        const r = await window.matrica.workSheets.rows.save({
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
          // Имя цеха — снимком в ведомость: без него читатель без прав на справочник видит uuid.
          workshopName: props.workshops.find((w) => w.id === workshopId)?.label ?? null,
          note: note.trim() || null,
          values,
        });
        if (!r.ok) {
          setStatus(`Ошибка: ${r.error}`);
          return;
        }
        dirtyRef.current = false;
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
    [effectiveType, engineId, date, workshopId, note, values, props.rowId, load],
  );

  const remove = async () => {
    if (props.isNew || !row) return;
    if (!window.confirm(`Удалить ведомость «${row.typeName}» от ${formatWorkSheetValue({ type: 'date', value: row.at })}?`)) return;
    // Второй вопрос — только если откатывать ЕСТЬ ЧТО: статус поставила эта ведомость.
    const rollbackRepair =
      row.repairStamped && window.confirm('Эта ведомость поставила двигателю «Отремонтирован». Снять отметку вместе с ней?');
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.rows.delete(row.id, { rollbackRepair });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      dirtyRef.current = false;
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
      closeWithoutSave: () => {
        dirtyRef.current = false;
        props.onClose();
      },
      // Копии ведомости нет и не планируется: она привязана к одному двигателю и одной дате,
      // а «копия» такой записи — это новая ведомость, которую заводят кнопкой в списке.
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
    ? 'Новая ведомость'
    : `Ведомость «${row?.typeName ?? effectiveType?.name ?? ''}»${row?.engineNumber ? ` · ${row.engineNumber}` : ''}`;

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
          {...(props.canEdit && !props.isNew ? { onDelete: () => void remove(), deleteLabel: 'Удалить ведомость', deleteSkipBuiltInConfirm: true } : {})}
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
                Ведомость «{type.name}» завершает ремонт: в карточке двигателя встанет «Отремонтирован» датой ведомости.
              </span>
            </>
          ) : null}
        </div>
      )}
    </EntityCardShell>
  );
}
