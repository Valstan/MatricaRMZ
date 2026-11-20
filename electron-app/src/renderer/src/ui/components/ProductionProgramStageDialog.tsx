import React, { useMemo, useState } from 'react';

import {
  productionProgramStageNeighbours,
  productionProgramStageOptions,
  type ProductionProgramEngineStage,
  type RepairStageTemplate,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { UnifiedDateInput } from './UnifiedDateInput.js';
import { formatMoscowDate } from '../utils/dateUtils.js';

/**
 * Модалка «Этап двигателя» из производственной программы (владелец 20.11.2026).
 *
 * Заказ: «при смене статуса появляется модальное окно, в котором запрошены
 * дополнительные, нужные для этого этапа поля — дата, когда этап был завершён,
 * и что там ещё есть» — и этап должен заноситься **полностью**, в историю
 * ремонта двигателя, а не «менять статус в плане».
 *
 * Поэтому полей здесь ровно столько, сколько у строки этапа в карточке:
 * этап, дата завершения, цех, примечание. Плюс «Срок по плану» — плановый
 * срок отгрузки строки плана: колонка «Отгрузка» убрана с экрана (владелец
 * 20.11.2026), а счётчики «В срок / Просрочено» на плашке программы должны
 * продолжать считаться.
 *
 * Гейты записи — те же, что в карточке (общий путь `workSheets:stages:save`):
 * субординация дат, дубль этапа за день (спрашиваем проход), смена даты
 * дефектовки (спрашиваем подтверждение). Здесь эти вопросы и задаются.
 */

/** Что модалка просит у вызывающего. */
export type ProductionProgramStageSubmitArgs = {
  /** Код этапа единого списка. */
  code: string;
  /** Дата завершения этапа, формат `input[type=date]` (ГГГГ-ММ-ДД). */
  date: string;
  /** Цех этапа (id справочника); пусто — цех не указан. */
  workshopId: string;
  /** Примечание к этапу. */
  note: string;
  /** Плановый срок отгрузки по строке плана (ГГГГ-ММ-ДД); пусто — срока нет. */
  planDeadline: string;
  /** Осознанный повторный проход (ответ на гейт дублей), начиная с 2. */
  repeatPass?: number;
  /** Подтверждение смены даты разборки/дефектовки. */
  confirmDefectDate?: boolean;
};

/** Ответ вызывающего: успех, отказ или вопрос, на который надо ответить. */
export type ProductionProgramStageSubmitResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** Такой этап за этот день уже есть — можно записать проходом № N. */
      duplicate?: { nextPass: number; typeName: string; atMs: number };
      /** Дата дефектовки уже стоит — запись с другой датой требует подтверждения. */
      defectDateChange?: { currentAtMs: number; nextAtMs: number; typeName: string };
    };

function todayInputValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ProductionProgramStageDialog(props: {
  /** Подпись двигателя: «Д-245 001». */
  engineLabel: string;
  /** Текущий этап двигателя (из карточки) — null, если этапов ещё не было. */
  currentStage: ProductionProgramEngineStage | null;
  /** Реестр этапов (серверный справочник или статика). */
  templates: readonly RepairStageTemplate[];
  /** Справочник цехов. */
  workshops: readonly { id: string; label: string }[];
  /** Этап, выбранный в ячейке плана (уже выбранный оператором). */
  initialCode: string;
  /** Плановый срок отгрузки строки плана (ГГГГ-ММ-ДД); пусто — срока нет. */
  planDeadline: string;
  /** Цех по умолчанию (цех программы, если он есть в справочнике). */
  defaultWorkshopId: string;
  onClose: () => void;
  onSubmit: (args: ProductionProgramStageSubmitArgs) => Promise<ProductionProgramStageSubmitResult>;
}) {
  const [code, setCode] = useState<string>(props.initialCode);
  const [date, setDate] = useState<string>(todayInputValue());
  const [workshopId, setWorkshopId] = useState<string>(props.defaultWorkshopId);
  const [note, setNote] = useState<string>('');
  const [planDeadline, setPlanDeadline] = useState<string>(props.planDeadline);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>('');
  /** Вопрос «записать проходом № N?» — ждёт ответа оператора. */
  const [duplicate, setDuplicate] = useState<{ nextPass: number; typeName: string; atMs: number } | null>(null);
  /** Вопрос «дата дефектовки уже стоит — поставить новую?» — ждёт ответа. */
  const [defectChange, setDefectChange] = useState<{ currentAtMs: number; nextAtMs: number } | null>(null);

  const options = useMemo(
    () => productionProgramStageOptions(props.templates, props.currentStage?.code ?? null),
    [props.templates, props.currentStage?.code],
  );

  /** Соседи текущего этапа: «следующий» и «предыдущий» (заказ владельца). */
  const neighbours = useMemo(
    () => productionProgramStageNeighbours(props.templates, props.currentStage?.code ?? null),
    [props.templates, props.currentStage?.code],
  );

  /** Этап ниже текущего — это возврат назад: предупреждаем, а не молчим. */
  const isBackward = useMemo(() => {
    const current = options.find((o) => o.isCurrent);
    const chosen = options.find((o) => o.code === code);
    if (!current || !chosen) return false;
    return chosen.sortOrder < current.sortOrder;
  }, [options, code]);

  const run = async (extra?: { repeatPass?: number; confirmDefectDate?: boolean }) => {
    if (!code) {
      setError('Выберите этап.');
      return;
    }
    if (!date) {
      setError('Укажите дату, когда этап был завершён.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await props.onSubmit({
        code,
        date,
        workshopId,
        note,
        planDeadline,
        ...(extra?.repeatPass ? { repeatPass: extra.repeatPass } : {}),
        ...(extra?.confirmDefectDate ? { confirmDefectDate: true } : {}),
      });
      if (res.ok) {
        props.onClose();
        return;
      }
      if (res.duplicate) {
        setDuplicate({
          nextPass: res.duplicate.nextPass,
          typeName: res.duplicate.typeName,
          atMs: res.duplicate.atMs,
        });
        return;
      }
      if (res.defectDateChange) {
        setDefectChange({
          currentAtMs: res.defectDateChange.currentAtMs,
          nextAtMs: res.defectDateChange.nextAtMs,
        });
        return;
      }
      setError(res.error);
    } catch (e) {
      setError(`Не удалось записать этап: ${String(e instanceof Error ? e.message : e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Этап двигателя"
      data-pp-stage-dialog
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface)',
          borderRadius: 10,
          padding: 16,
          width: 'min(620px, 96vw)',
          maxHeight: '90vh',
          overflow: 'auto',
          display: 'grid',
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 16 }}>Этап двигателя</div>

        <div style={{ display: 'grid', gap: 2, fontSize: 13 }}>
          <div>
            <span className="ui-muted">Двигатель: </span>
            {props.engineLabel}
          </div>
          <div>
            <span className="ui-muted">Сейчас: </span>
            {props.currentStage ? props.currentStage.label : 'этапов ещё не было'}
          </div>
        </div>

        <label style={{ display: 'grid', gap: 4 }}>
          <span className="ui-muted" style={{ fontSize: 12 }}>
            Этап
          </span>
          <select
            value={code}
            disabled={busy}
            data-pp-stage-code
            onChange={(e) => setCode(e.target.value)}
            style={{ padding: '4px 6px' }}
          >
            <option value="">— выберите этап —</option>
            {options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
                {o.isCurrent ? ' (сейчас)' : ''}
              </option>
            ))}
          </select>
        </label>

        {/* Следующий/предыдущий — кнопки рядом с выбором (заказ владельца:
            «можно было выбрать другой какой-то этап, следующий, например, или предыдущий»). */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Button
            variant="ghost"
            disabled={busy || !neighbours.prev}
            data-pp-stage-prev
            onClick={() => neighbours.prev && setCode(neighbours.prev.code)}
          >
            ← Предыдущий этап
          </Button>
          <Button
            variant="ghost"
            disabled={busy || !neighbours.next}
            data-pp-stage-next
            onClick={() => neighbours.next && setCode(neighbours.next.code)}
          >
            Следующий этап →
          </Button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>
              Дата завершения этапа
            </span>
            <UnifiedDateInput
              type="date"
              value={date}
              disabled={busy}
              data-pp-stage-date
              onChange={(e) => setDate(String(e.target.value ?? ''))}
            />
          </label>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="ui-muted" style={{ fontSize: 12 }}>
              Цех
            </span>
            <select
              value={workshopId}
              disabled={busy}
              data-pp-stage-workshop
              onChange={(e) => setWorkshopId(e.target.value)}
              style={{ padding: '4px 6px' }}
            >
              <option value="">— без цеха —</option>
              {props.workshops.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label style={{ display: 'grid', gap: 4 }}>
          <span className="ui-muted" style={{ fontSize: 12 }}>
            Примечание к этапу
          </span>
          <input
            value={note}
            disabled={busy}
            data-pp-stage-note
            onChange={(e) => setNote(e.target.value)}
            placeholder="что делали, что заменили, чем кончилось"
            style={{ padding: '4px 6px' }}
          />
        </label>

        <label style={{ display: 'grid', gap: 4 }}>
          <span className="ui-muted" style={{ fontSize: 12 }}>
            Срок по плану (дата отгрузки)
          </span>
          <UnifiedDateInput
            type="date"
            value={planDeadline}
            disabled={busy}
            data-pp-stage-deadline
            onChange={(e) => setPlanDeadline(String(e.target.value ?? ''))}
          />
          <span className="ui-muted" style={{ fontSize: 11 }}>
            Срок живёт в строке плана: по нему считаются «В срок / Просрочено» на плашке программы.
          </span>
        </label>

        {isBackward ? (
          <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
            Этап ниже текущего — это возврат назад: в истории появится новый проход (проход № 2 и дальше).
          </div>
        ) : null}

        {duplicate ? (
          <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <div>
              За {formatMoscowDate(new Date(duplicate.atMs))} этап «{duplicate.typeName}» уже внесён. Записать проходом №{' '}
              {duplicate.nextPass}?
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="ghost" disabled={busy} onClick={() => setDuplicate(null)}>
                Отмена
              </Button>
              <Button disabled={busy} onClick={() => void run({ repeatPass: duplicate.nextPass })}>
                Записать проходом № {duplicate.nextPass}
              </Button>
            </div>
          </div>
        ) : null}

        {defectChange ? (
          <div style={{ display: 'grid', gap: 6, fontSize: 13 }}>
            <div>
              Дата разборки/дефектовки уже стоит: {formatMoscowDate(new Date(defectChange.currentAtMs))}. Поставить{' '}
              {formatMoscowDate(new Date(defectChange.nextAtMs))}?
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="ghost" disabled={busy} onClick={() => setDefectChange(null)}>
                Отмена
              </Button>
              <Button disabled={busy} onClick={() => void run({ confirmDefectDate: true })}>
                Поставить новую дату
              </Button>
            </div>
          </div>
        ) : null}

        {error ? <div style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</div> : null}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={() => props.onClose()} disabled={busy}>
            Отмена
          </Button>
          <Button onClick={() => void run()} disabled={busy || !code}>
            {busy ? 'Записываем…' : 'Записать этап'}
          </Button>
        </div>
      </div>
    </div>
  );
}
