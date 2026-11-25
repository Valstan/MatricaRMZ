import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  REPAIR_HISTORY_OPERATION_TYPE,
  buildEngineHistoryFeed,
  buildRepairHistoryMeta,
  ENGINE_INVENTORY_STAGE,
  engineHistoryFeedFieldLines,
  repairHistoryActionOptions,
  type EngineHistoryFeedItem,
  type EngineHistoryFeedRow,
  type RepairStageRow,
  type RepairStageTemplate,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SearchSelect } from './SearchSelect.js';
import { TransferStagesDialog } from './TransferStagesDialog.js';
import { emojiAttrs } from '../utils/labelEmoji.js';
import { useConfirmOptional } from './ConfirmContext.js';
import { formatMoscowDate } from '../utils/dateUtils.js';
import { confirmShipmentWithOpenAssembly } from '../utils/shipmentAssemblyGate.js';

/**
 * Единая лента истории ремонта двигателя (задача владельца 01.10.2026).
 *
 * Раньше на вкладке было три ленты: «Этапы ремонта», «История ремонта» и паспорт по всем
 * операциям. Данные у них одни и те же — строки `operations`, — но читались как три
 * разных журнала, и чтобы узнать «что было с двигателем», приходилось перечитывать все
 * три. Теперь это одна таблица, а сборку строк делает домен (`buildEngineHistoryFeed`):
 * правило живёт в одном месте, иначе строки снова разъедутся по датам и подписям.
 *
 * Что видно в строке: дата события и отдельно дата записи (этап «Сборка» за 20-е может
 * быть введён сегодня), тип, событие, цех, причина/примечание, автор по-русски.
 */

type StageTemplate = RepairStageTemplate;

function toInputDate(ms: number | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fromInputDate(v: string): number | null {
  const ms = v ? Date.parse(`${v}T12:00:00`) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

function today(): string {
  return toInputDate(Date.now());
}

export function EngineHistoryFeedPanel(props: {
  engineId: string;
  /**
   * Метка этапа ремонта. Гейт — тот же, что на сервере (`ledgerAuthzGuard`):
   * `work_sheets.edit` ИЛИ `operations.edit` (дизъюнкция, план #114, шаг 24).
   */
  canEdit: boolean;
  /** Ручная запись истории: `operations.edit` (как любая операция в таймлайне). */
  canEditManual?: boolean;
  /** Перенос этапов между двигателями: `engines.edit` (своя операция, не этап). */
  canTransfer?: boolean;
  workshopOptions: Array<{ id: string; label: string }>;
  /** Перерисовать карточку после записи: этап влияет на строку списка (цех, действие). */
  onChanged?: () => void;
  /** Подпись двигателя для гейта отгрузки («Д6 123», не uuid). */
  engineLabel?: string;
  /** Открыть карточку этапа работ, породившего запись. */
  onOpenWorkSheet?: (id: string, title?: string) => void;
}) {
  const [rows, setRows] = useState<EngineHistoryFeedRow[]>([]);
  const [templates, setTemplates] = useState<StageTemplate[]>([]);
  /**
   * Погашенные этапы (этап следует за датой карточки): сняли дату — этап исчез из
   * истории, но остался в базе. Показываем его с пометкой «почему исчез» и даём вернуть.
   */
  const [deletedStages, setDeletedStages] = useState<RepairStageRow[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Гейты по видам записи (план #114, шаг 24). Ручная запись и метка этапа —
  // разные права: сервер режет их по-разному, и UI-гейт должен смотреть на то же.
  const canEditManual = props.canEditManual ?? props.canEdit;
  const canTransfer = props.canTransfer ?? props.canEdit;

  // Две формы добавления (владелец 01.10.2026): этап из шаблона и ручная запись.
  // Обе раскрываются кнопками и прячутся после записи/отмены — инлайн-полей вверху нет.
  const [addingStage, setAddingStage] = useState(false);
  const [stageCode, setStageCode] = useState('');
  const [stageWorkshopId, setStageWorkshopId] = useState('');
  const [stageDate, setStageDate] = useState('');
  const [stageNote, setStageNote] = useState('');
  const [pendingPass, setPendingPass] = useState<{ pass: number; id: string; code: string; atMs: number; note: string; workshopId: string; workshopName: string } | null>(null);
  // Смена даты дефектовки (dual-entry, PR4): сервис спрашивает, лента переспрашивает
  // оператора и повторяет запись с `confirmDefectDate`.
  const [pendingDefectDate, setPendingDefectDate] = useState<{
    id: string;
    code: string;
    atMs: number;
    note?: string;
    workshopId?: string;
    workshopName?: string;
    currentAtMs: number;
  } | null>(null);
  const [addingManual, setAddingManual] = useState(false);
  const [draftDate, setDraftDate] = useState('');
  const [draftAction, setDraftAction] = useState('');
  const [draftWorkshopId, setDraftWorkshopId] = useState('');
  const [draftNote, setDraftNote] = useState('');

  // Правка уже записанного этапа прямо в строке ленты: дата, цех, примечание
  // (PR-4 плана 10-2026 — раньше правилась только дата, а смена даты молча
  // стирала цех: писатель собирает строку заново из входа).
  const [editingDate, setEditingDate] = useState<{ id: string; code: string; value: string; workshopId: string; workshopName: string; note: string; repeat: boolean; repeatReason: string } | null>(null);
  // Правка ручной записи прямо в строке: текст действия, дата, цех, примечание.
  const [editingManual, setEditingManual] = useState<{ id: string; action: string; date: string; workshopId: string; workshopName: string; note: string } | null>(null);
  // Перенос этапов при перебивке номера (программа владельца, п.4, 10.10.2026).
  const [transferOpen, setTransferOpen] = useState(false);
  // Разовый откат последнего действия в ленте (добавил/удалил/поправил не то —
  // жмёшь «Отменить», и строка возвращается). Одношаговый: новое действие стирает кнопку.
  const [undo, setUndo] = useState<
    | { label: string; kind: 'remove-stage'; id: string }
    | {
        label: string;
        kind: 'restore-stage';
        snapshot: { id: string; code: string; atMs: number; note?: string; workshopId?: string; workshopName?: string; pass: number; repeatReason?: string };
      }
    | { label: string; kind: 'remove-manual'; id: string }
    | {
        label: string;
        kind: 'restore-manual';
        snapshot: { id: string; action: string; atMs: number; note: string; workshopId?: string; workshopName?: string };
      }
    | {
        label: string;
        kind: 'readd-manual';
        snapshot: { action: string; atMs: number; note: string; workshopId: string; workshopName?: string };
      }
    | null
  >(null);
  const confirmCtx = useConfirmOptional();
  // Гейт отгрузки в полёте: повторный клик не должен открыть второй гейт поверх первого.
  const shipmentGateBusy = useRef(false);

  const load = useCallback(async () => {
    try {
      const [ops, tpl, gone] = await Promise.all([
        window.matrica.operations.list(props.engineId),
        window.matrica.workSheets.stages.templates.list(),
        // Погашенные этапы — отдельная выборка: её отсутствие не должно ронять ленту.
        window.matrica.workSheets.stages.deleted(props.engineId).catch(() => null),
      ]);
      setRows((Array.isArray(ops) ? ops : []) as EngineHistoryFeedRow[]);
      setDeletedStages(gone?.ok ? gone.rows : []);
      if (tpl.ok) {
        setTemplates(tpl.templates);
        if (tpl.source === 'fallback') setStatus('Шаблон этапов взят из программы — сервер недоступен, свежих правок может не быть.');
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, [props.engineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const feed = useMemo(() => buildEngineHistoryFeed(rows), [rows]);

  const workshopName = useCallback(
    (id: string, snapshot?: string) =>
      props.workshopOptions.find((w) => w.id === id)?.label ?? snapshot ?? (id ? 'цех не из справочника' : ''),
    [props.workshopOptions],
  );
  const templateName = useCallback(
    (code: string) => templates.find((t) => t.code === code)?.name ?? code,
    [templates],
  );
  const actionOptions = useMemo(
    () => repairHistoryActionOptions(buildEngineHistoryFeed(rows).map((i) => ({ action: i.title } as never))),
    [rows],
  );

  function resetStageForm() {
    setStageCode('');
    setStageWorkshopId('');
    setStageDate('');
    setStageNote('');
  }

  /** Снимок строки этапа из текущей ленты — для отката: вернуть как было. */
  function stageSnapshot(id: string):
    | { id: string; code: string; atMs: number; note?: string; workshopId?: string; workshopName?: string; pass: number; repeatReason?: string }
    | null {
    const item = feed.find((i) => i.id === id && i.stageCode);
    if (!item || !(item.at > 0)) return null;
    return {
      id: item.id,
      code: item.stageCode,
      atMs: item.at,
      ...(item.note ? { note: item.note } : {}),
      ...(item.workshopId ? { workshopId: item.workshopId } : {}),
      ...(item.workshopName ? { workshopName: item.workshopName } : {}),
      pass: item.pass,
      ...(item.repeatReason ? { repeatReason: item.repeatReason } : {}),
    };
  }

  async function runUndo() {
    const u = undo;
    if (!u || busy) return;
    setUndo(null);
    setBusy(true);
    try {
      if (u.kind === 'remove-stage' || u.kind === 'remove-manual') {
        const r =
          u.kind === 'remove-stage'
            ? await window.matrica.workSheets.stages.remove(u.id)
            : await window.matrica.operations.remove(u.id);
        if (!r.ok) {
          setStatus(`Ошибка: ${r.error}`);
          return;
        }
      } else if (u.kind === 'restore-stage') {
        const s = u.snapshot;
        const r = await window.matrica.workSheets.stages.save({
          id: s.id,
          code: s.code,
          atMs: s.atMs,
          ...(s.note ? { note: s.note } : {}),
          ...(s.workshopId ? { workshopId: s.workshopId } : {}),
          ...(s.workshopName ? { workshopName: s.workshopName } : {}),
          ...(s.pass >= 2 ? { repeatPass: s.pass } : {}),
          ...(s.repeatReason ? { repeatReason: s.repeatReason } : {}),
          // Откат — сам по себе подтверждение: оператор уже отвечал на вопрос один раз,
          // второй раз спрашивать про ту же дату незачем.
          ...(s.code === 'disassembly_defect' ? { confirmDefectDate: true } : {}),
          engineId: props.engineId,
        });
        if (!r.ok) {
          setStatus(`Ошибка: ${r.error}`);
          return;
        }
      } else if (u.kind === 'restore-manual') {
        const r = await window.matrica.operations.updateManual(props.engineId, u.snapshot.id, {
          action: u.snapshot.action,
          at: u.snapshot.atMs,
          note: u.snapshot.note,
          ...(u.snapshot.workshopId !== undefined ? { workshopId: u.snapshot.workshopId } : {}),
          ...(u.snapshot.workshopName !== undefined ? { workshopName: u.snapshot.workshopName } : {}),
        });
        if (!r.ok) {
          setStatus(`Ошибка: ${r.error}`);
          return;
        }
      } else {
        const meta = buildRepairHistoryMeta({
          action: u.snapshot.action,
          workshopId: u.snapshot.workshopId,
          ...(u.snapshot.workshopName ? { workshopName: u.snapshot.workshopName } : {}),
          note: u.snapshot.note,
          at: u.snapshot.atMs,
        });
        await window.matrica.operations.add(props.engineId, REPAIR_HISTORY_OPERATION_TYPE, 'done', meta.action, JSON.stringify(meta));
      }
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function writeStage(
    args: {
      id: string;
      code: string;
      atMs: number;
      note?: string;
      workshopId?: string;
      workshopName?: string;
      repeatPass?: number;
      repeatReason?: string;
      repeat?: boolean;
      confirmDefectDate?: boolean;
    },
  ) {
    // Снимок ДО записи: если строка уже есть — откат вернёт её, если новая — откат её снимет.
    const before = stageSnapshot(args.id);
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.save({ ...args, engineId: props.engineId });
      if (!r.ok && r.duplicate) {
        setPendingPass({
          pass: r.duplicate.nextPass,
          id: args.id,
          code: args.code,
          atMs: args.atMs,
          note: args.note ?? '',
          workshopId: args.workshopId ?? '',
          workshopName: args.workshopName ?? '',
        });
        setStatus(`Такой этап за этот день уже есть — записать проходом № ${r.duplicate.nextPass}?`);
        return;
      }
      if (!r.ok && r.defectDateChange) {
        setPendingDefectDate({
          id: args.id,
          code: args.code,
          atMs: args.atMs,
          ...(args.note ? { note: args.note } : {}),
          ...(args.workshopId ? { workshopId: args.workshopId } : {}),
          ...(args.workshopName ? { workshopName: args.workshopName } : {}),
          currentAtMs: r.defectDateChange.currentAtMs,
        });
        setStatus(
          `Дата разборки/дефектовки уже стоит: ${formatMoscowDate(new Date(r.defectDateChange.currentAtMs))}. Поставить ${formatMoscowDate(new Date(r.defectDateChange.nextAtMs))}? Дата подставится и в лист дефектовки.`,
        );
        return;
      }
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setPendingPass(null);
      setPendingDefectDate(null);
      resetStageForm();
      setAddingStage(false);
      setUndo(
        before
          ? { label: `«${templateName(args.code)}»`, kind: 'restore-stage', snapshot: before }
          : { label: `«${templateName(args.code)}»`, kind: 'remove-stage', id: args.id },
      );
      setStatus(r.backward && r.pass >= 2 ? `«${templateName(args.code)}» — возврат назад, записан проход № ${r.pass}.` : '');
      // Направление «этап → акт»: дату дефектовки доносим до листа. Довесок —
      // этап уже записан, его исход не трогаем.
      if (args.code === 'disassembly_defect') {
        try {
          const synced = await window.matrica.checklists.engineSetAnswerDate({
            engineId: props.engineId,
            stage: ENGINE_INVENTORY_STAGE,
            code: 'defect_start_date',
            atMs: args.atMs,
          });
          if (!synced?.ok) {
            setStatus((s) => `${s} Дату в лист дефектовки донести не вышло: ${synced?.error ?? 'unknown'}.`);
          }
        } catch {
          /* этап записан — довесок */
        }
      }
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeStage(id: string, name: string) {
    if (!confirm(`Убрать этап «${name}» из истории? (строка погасится, не удалится)`)) return;
    // Снимок ДО снятия: откат запишет строку тем же id заново (upsert воскрешает).
    const before = stageSnapshot(id);
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.remove(id);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setUndo(before ? { label: `«${name}»`, kind: 'restore-stage', snapshot: before } : null);
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Вернуть погашенный этап в историю ремонта (сняли дату карточки — этап исчез).
   * Возврат воскрешает строку тем же id: она снова считается в истории и расчётах.
   */
  async function restoreDeletedStage(id: string, name: string) {
    if (!confirm(`Вернуть этап «${name}» в историю ремонта?`)) return;
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.restore(id);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setStatus(`Этап «${name}» возвращён в историю`);
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function resetDraft() {
    setDraftDate(today());
    setDraftAction('');
    setDraftWorkshopId('');
    setDraftNote('');
  }

  async function saveManual() {
    const action = draftAction.trim();
    if (!action) {
      setStatus('Укажите действие — без него строка ничего не говорит');
      return;
    }
    const typed = draftDate ? Date.parse(`${draftDate}T12:00:00`) : Number.NaN;
    // Имя цеха — снимком из справочника сразу: строка обязана читаться без него.
    const wsLabel = props.workshopOptions.find((w) => w.id === draftWorkshopId)?.label ?? '';
    const meta = buildRepairHistoryMeta({
      action,
      workshopId: draftWorkshopId,
      ...(wsLabel ? { workshopName: wsLabel } : {}),
      note: draftNote,
      ...(Number.isFinite(typed) ? { at: typed } : {}),
    });
    try {
      setStatus('Сохраняю…');
      const created = await window.matrica.operations.add(props.engineId, REPAIR_HISTORY_OPERATION_TYPE, 'done', meta.action, JSON.stringify(meta));
      setAddingManual(false);
      resetDraft();
      setUndo({ label: `запись «${action}»`, kind: 'remove-manual', id: created.id });
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function removeManual(id: string, title: string) {
    if (!confirm(`Убрать запись «${title}» из истории? (строка погасится, не удалится)`)) return;
    const item = feed.find((i) => i.id === id);
    setBusy(true);
    try {
      const r = await window.matrica.operations.remove(id);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      // Откат удаления — та же запись новой строкой (автор и момент ввода станут
      // текущими, дата события и текст — прежние). Говорим об этом прямо в подписи.
      setUndo(
        item
          ? {
              label: `запись «${item.title}»`,
              kind: 'readd-manual',
              snapshot: { action: item.title, atMs: item.at > 0 ? item.at : Date.now(), note: item.note, workshopId: item.workshopId, ...(item.workshopName ? { workshopName: item.workshopName } : {}) },
            }
          : null,
      );
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyManualEdit(id: string, action: string, dateValue: string, workshopId: string, workshopName: string, note: string) {
    const trimmed = action.trim();
    if (!trimmed) {
      setStatus('Укажите действие — без него строка ничего не говорит');
      return;
    }
    const item = feed.find((i) => i.id === id);
    const parsed = dateValue ? Date.parse(`${dateValue}T12:00:00`) : Number.NaN;
    setBusy(true);
    try {
      const r = await window.matrica.operations.updateManual(props.engineId, id, {
        action: trimmed,
        ...(Number.isFinite(parsed) ? { at: parsed } : {}),
        note,
        workshopId,
        ...(workshopName ? { workshopName } : {}),
      });
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      setEditingManual(null);
      setUndo(
        item
          ? {
              label: `запись «${item.title}»`,
              kind: 'restore-manual',
              snapshot: { id, action: item.title, atMs: item.at > 0 ? item.at : Date.now(), note: item.note, workshopId: item.workshopId, ...(item.workshopName ? { workshopName: item.workshopName } : {}) },
            }
          : null,
      );
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function detailLines(item: EngineHistoryFeedItem): string[] {
    return [
      ...item.extra.map((f) => `${f.label}: ${f.value}`),
      ...engineHistoryFeedFieldLines(item),
    ];
  }

  return (
    <div data-engine-history-feed style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
      {/* Ряд кнопок — слева (владелец 24.11.2026, промт КАРМАНА #118; досрочно —
          промт #141). Здесь стояла пустая распорка, а кнопки — ЗА ней: они уезжали к
          правому краю, а на планшете (1024 px) уезжали за край экрана. Распорки в
          шапке больше нет: заголовок, счётчик и кнопки идут подряд слева, а не
          растягиваются по ширине. Порядок кнопок зафиксирован (действие по умолчанию →
          этап → перенос), чтобы ряд не «прыгал», когда права меняются. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }} {...emojiAttrs('История ремонта')}>История ремонта</span>
        <span className="ui-muted">{feed.length > 0 ? `${feed.length} событий` : 'событий пока нет'}</span>
        {canEditManual && (
          <Button
            variant="ghost"
            data-repair-history-add
            onClick={() => {
              resetDraft();
              setAddingStage(false);
              setAddingManual(true);
            }}
          >
            Добавить запись
          </Button>
        )}
        {props.canEdit && (
          <Button
            variant="ghost"
            data-repair-stage-form-open
            onClick={() => {
              resetStageForm();
              setStageDate(today());
              setAddingManual(false);
              setAddingStage(true);
            }}
          >
            Добавить этап ремонта
          </Button>
        )}
        {canTransfer && (
          <Button
            variant="ghost"
            data-transfer-open
            onClick={() => {
              setAddingStage(false);
              setAddingManual(false);
              setTransferOpen(true);
            }}
          >
            Перенести этапы…
          </Button>
        )}
      </div>

      {/* Перенос этапов при перебивке номера: срез «от укладки вала и выше» уезжает
        на выбранный двигатель, обе истории получают записи о переносе. */}
      {canTransfer && transferOpen && (
        <TransferStagesDialog
          sourceEngineId={props.engineId}
          sourceLabel={props.engineLabel ?? props.engineId}
          onClose={() => setTransferOpen(false)}
          onDone={() => load()}
        />
      )}

      {/* Форма добавления этапа: раскрывается кнопкой (владелец 01.10.2026). */}
      {props.canEdit && addingStage && (
        <div style={{ display: 'grid', gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              value={stageCode}
              disabled={busy}
              data-repair-stage-pick
              onChange={(e) => setStageCode(e.target.value)}
              style={{ minWidth: 220, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
            >
              <option value="">Выберите этап…</option>
              {templates.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
            <div style={{ minWidth: 220 }}>
              <SearchSelect
                value={stageWorkshopId}
                options={props.workshopOptions}
                placeholder="Цех (если применимо)"
                showAllWhenEmpty
                onChange={(next) => setStageWorkshopId(String(next ?? ''))}
              />
            </div>
            <div style={{ width: 170 }}>
              <Input
                type="date"
                value={stageDate}
                disabled={busy}
                title="Дата этапа"
                data-repair-stage-add-date
                onChange={(e) => setStageDate(e.target.value)}
              />
            </div>
          </div>
          <Input value={stageNote} disabled={busy} placeholder="Примечание (необязательно)" onChange={(e) => setStageNote(e.target.value)} />
          {/* Подвал формы: кнопки слева (владелец 24.11.2026). Распорка уводила
              «Отмена»/«Применить» к правому краю — на планшете они уезжали за край. */}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => setAddingStage(false)}>
              Отмена
            </Button>
            <Button
              disabled={busy || !stageCode || !stageDate}
              data-repair-stage-add
              onClick={() => {
                const atMs = fromInputDate(stageDate);
                if (!stageCode || atMs === null) {
                  setStatus('Выберите этап и дату');
                  return;
                }
                void (async () => {
                  // Гейт отгрузки (план unified-repair-stages, шаг 8/3): отметка
                  // «Отправлен/Принят заказчиком» при незакрытом сборочном наряде сначала
                  // предлагает закрыть наряды; на отмене отметка не встаёт вовсе. Без
                  // провайдера диалогов гейт молчит — как и раньше в секции этапов.
                  if ((stageCode === 'shipped' || stageCode === 'accepted') && confirmCtx && !shipmentGateBusy.current) {
                    shipmentGateBusy.current = true;
                    try {
                      const decision = await confirmShipmentWithOpenAssembly({
                        engineId: props.engineId,
                        engineLabel: props.engineLabel ?? props.engineId,
                        pickChoice: confirmCtx.pickChoice,
                      });
                      if (decision.action !== 'proceed') return;
                    } finally {
                      shipmentGateBusy.current = false;
                    }
                  }
                  const workshopLabel = props.workshopOptions.find((w) => w.id === stageWorkshopId)?.label ?? '';
                  await writeStage({
                    id: crypto.randomUUID(),
                    code: stageCode,
                    atMs,
                    ...(stageNote.trim() ? { note: stageNote.trim() } : {}),
                    ...(stageWorkshopId ? { workshopId: stageWorkshopId } : {}),
                    ...(stageWorkshopId && workshopLabel ? { workshopName: workshopLabel } : {}),
                  });
                })();
              }}
            >
              Применить
            </Button>
          </div>
        </div>
      )}

      {pendingPass && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button
            data-repair-stage-confirm-pass
            onClick={() =>
              void writeStage({
                id: pendingPass.id,
                code: pendingPass.code,
                atMs: pendingPass.atMs,
                repeatPass: pendingPass.pass,
                // Подтверждение прохода — та же строка, а не новая: цех и примечание
                // несутся как были, иначе запись проходом молча стирала бы их.
                ...(pendingPass.note ? { note: pendingPass.note } : {}),
                ...(pendingPass.workshopId ? { workshopId: pendingPass.workshopId } : {}),
                ...(pendingPass.workshopId && pendingPass.workshopName ? { workshopName: pendingPass.workshopName } : {}),
              })
            }
          >
            Записать проходом № {pendingPass.pass}
          </Button>
          <Button variant="ghost" onClick={() => { setPendingPass(null); setStatus(''); }}>
            Отмена
          </Button>
        </div>
      )}

      {/* Смена даты дефектовки вручную (dual-entry): авто-метка могла поставить дату
          раньше оператора — его дату спрашиваем, а не отказываем. */}
      {pendingDefectDate && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Button
            data-repair-stage-confirm-defect-date
            onClick={() =>
              void writeStage({
                id: pendingDefectDate.id,
                code: pendingDefectDate.code,
                atMs: pendingDefectDate.atMs,
                ...(pendingDefectDate.note ? { note: pendingDefectDate.note } : {}),
                ...(pendingDefectDate.workshopId ? { workshopId: pendingDefectDate.workshopId } : {}),
                ...(pendingDefectDate.workshopName ? { workshopName: pendingDefectDate.workshopName } : {}),
                confirmDefectDate: true,
              })
            }
          >
            Поставить {formatMoscowDate(new Date(pendingDefectDate.atMs))}
          </Button>
          <Button variant="ghost" onClick={() => { setPendingDefectDate(null); setStatus(''); }}>
            Отмена
          </Button>
        </div>
      )}

      {canEditManual && addingManual && (
        <div style={{ display: 'grid', gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ width: 170 }}>
              <Input type="date" value={draftDate} onChange={(e) => setDraftDate(e.target.value)} title="Дата события" data-repair-history-date />
            </div>
            <div style={{ minWidth: 260, flex: 1 }}>
              {/* Список действий ОТКРЫТЫЙ: подсказки через datalist, но ввести можно любое своё. */}
              <Input
                value={draftAction}
                onChange={(e) => setDraftAction(e.target.value)}
                placeholder="Действие (можно ввести своё)"
                list="repair-history-actions"
                data-repair-history-action
              />
              <datalist id="repair-history-actions">
                {actionOptions.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </div>
            <div style={{ minWidth: 220 }}>
              <SearchSelect
                value={draftWorkshopId}
                options={props.workshopOptions}
                placeholder="Цех (если применимо)"
                showAllWhenEmpty
                onChange={(next) => setDraftWorkshopId(String(next ?? ''))}
              />
            </div>
          </div>
          <Input value={draftNote} onChange={(e) => setDraftNote(e.target.value)} placeholder="Комментарий — что произошло, всё важное об этом событии" />

          {/* Подвал формы: кнопки слева (владелец 24.11.2026) — без распорки. */}
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => setAddingManual(false)}>
              Отмена
            </Button>
            <Button onClick={() => void saveManual()} data-repair-history-save>
              Сохранить
            </Button>
          </div>
        </div>
      )}

      {(status || undo) && (
        <div className="ui-muted" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {status && <span>{status}</span>}
          {undo && (
            <Button variant="ghost" disabled={busy} title="Вернуть как было до последнего действия" data-history-undo onClick={() => void runUndo()}>
              ↩ Отменить: {undo.label}
            </Button>
          )}
        </div>
      )}

      {/* Заезды двигателя ушли в отдельную вкладку «История заездов» (владелец 19.11.2026):
          лента событий ремонта остаётся здесь, а приходы, отъезды, договоры и контрагенты
          по заездам — там. Дублировать одно и то же в двух местах нельзя: цифры разъедутся. */}

      {feed.length > 0 && (
        <div style={{ width: '100%', maxWidth: 1400, margin: '0 auto', display: 'flex', justifyContent: 'center' }}>
          <table style={{ borderCollapse: 'collapse', width: 'max-content', maxWidth: '100%' }} data-history-feed-table>
            <thead>
              <tr>
                {['', 'Дата', 'Записано', 'Тип', 'Событие', 'Цех', 'Причина и примечание', 'Кто'].map((h, i) => (
                  <th
                    key={`${i}-${h}`}
                    {...emojiAttrs(h)}
                    style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {feed.map((item) => {
                const details = detailLines(item);
                const canFixDate = props.canEdit && item.editable && !(item.sheetRowId && props.onOpenWorkSheet);
                return (
                  <tr key={item.id} data-history-feed-row={item.id} data-history-feed-kind={item.kind}>
                    {/* Кнопки действий над записью — в ЛЕВОЙ группе строки (владелец
                        24.11.2026: управляющие кнопки влево; промт КАРМАНА #141). Раньше
                        снятие этапа и правка ручной записи стояли в безымянной колонке
                        справа — на планшете эти кнопки уезжали за край экрана. Сама строка
                        осталась на месте: правка по-прежнему делается в строке ленты. */}
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        {canFixDate &&
                          (editingDate?.id === item.id ? (
                            <Button variant="ghost" title="Отмена" onClick={() => setEditingDate(null)}>
                              ✕
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              title="Править этап: дата, цех, примечание"
                              data-repair-stage-edit-date={item.id}
                              onClick={() => setEditingDate({ id: item.id, code: item.stageCode, value: toInputDate(item.at), workshopId: item.workshopId, workshopName: item.workshopName ?? '', note: item.note, repeat: item.pass >= 2, repeatReason: item.repeatReason })}
                            >
                              ✎
                            </Button>
                          ))}
                        {props.canEdit && item.editable && (
                          <Button
                            variant="ghost"
                            // Пока строка правится, снять этап нельзя: рядом уже стоит
                            // «Отмена» правки, и два одинаковых крестика путают.
                            disabled={busy || editingDate?.id === item.id}
                            title="Убрать этап"
                            data-repair-stage-remove={item.id}
                            onClick={() => void removeStage(item.id, item.title)}
                          >
                            ✕
                          </Button>
                        )}
                        {canEditManual && item.kind === 'manual' && (
                          <>
                            <Button
                              variant="ghost"
                              disabled={busy}
                              title="Править запись"
                              data-manual-edit={item.id}
                              onClick={() =>
                                setEditingManual({ id: item.id, action: item.title, date: toInputDate(item.at > 0 ? item.at : null), workshopId: item.workshopId, workshopName: item.workshopName ?? '', note: item.note })
                              }
                            >
                              ✎
                            </Button>
                            <Button
                              variant="ghost"
                              disabled={busy}
                              title="Убрать запись"
                              data-manual-remove={item.id}
                              onClick={() => void removeManual(item.id, item.title)}
                            >
                              ✕
                            </Button>
                          </>
                        )}
                      </span>
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      {/* Служебная отметка (заведение карточки) — не событие ремонта:
                          даты исполнения у неё нет, только «записано» (когда и кем завели
                          карточку). Решение владельца 02.11.2026. */}
                      {item.service ? '' : item.at > 0 ? formatMoscowDate(new Date(item.at)) : '—'}
                      {item.pass >= 2 && <div className="ui-muted">проход № {item.pass} (возврат)</div>}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }} className="ui-muted" data-history-feed-recorded={item.id}>
                      {item.service
                        ? item.at > 0
                          ? formatMoscowDate(new Date(item.at))
                          : '—'
                        : item.recordedAt > 0
                          ? formatMoscowDate(new Date(item.recordedAt))
                          : '—'}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      {item.service ? null : (
                        <span
                          className="ui-muted"
                          style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' }}
                        >
                          {item.icon} {item.kindLabel}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      {item.sheetRowId && props.onOpenWorkSheet ? (
                        <button
                          type="button"
                          className="ui-muted"
                          title="Открыть карточку этапа работ"
                          data-repair-history-open-sheet={item.id}
                          onClick={() => props.onOpenWorkSheet?.(item.sheetRowId as string, item.title)}
                          style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', background: 'transparent', cursor: 'pointer', textDecoration: 'underline' }}
                        >
                          {`${item.title} ↗`}
                        </button>
                      ) : editingManual?.id === item.id && item.kind === 'manual' ? (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Input
                            value={editingManual.action}
                            disabled={busy}
                            title="Текст записи"
                            placeholder="Действие"
                            data-manual-action={item.id}
                            onChange={(e) => setEditingManual((prev) => (prev ? { ...prev, action: e.target.value } : null))}
                          />
                          <Input
                            type="date"
                            value={editingManual.date}
                            disabled={busy}
                            title="Дата события"
                            data-manual-date={item.id}
                            onChange={(e) => setEditingManual((prev) => (prev ? { ...prev, date: e.target.value } : null))}
                          />
                          <span style={{ minWidth: 140 }}>
                            <SearchSelect
                              value={editingManual.workshopId || null}
                              options={props.workshopOptions}
                              placeholder="Цех"
                              showAllWhenEmpty
                              onChange={(next) =>
                                setEditingManual((prev) => {
                                  if (!prev) return prev;
                                  const id = String(next ?? '');
                                  return { ...prev, workshopId: id, workshopName: props.workshopOptions.find((w) => w.id === id)?.label ?? '' };
                                })
                              }
                            />
                          </span>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            title="Сохранить правку записи"
                            data-manual-apply={item.id}
                            onClick={() => void applyManualEdit(item.id, editingManual.action, editingManual.date, editingManual.workshopId, editingManual.workshopName, editingManual.note)}
                          >
                            Применить
                          </Button>
                          <Button variant="ghost" title="Отмена" onClick={() => setEditingManual(null)}>
                            ✕
                          </Button>
                        </span>
                      ) : editingDate?.id === item.id ? (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                          <Input
                            type="date"
                            value={editingDate.value}
                            disabled={busy}
                            title="Дата этапа"
                            data-repair-stage-date={item.id}
                            onChange={(e) => setEditingDate((prev) => (prev ? { ...prev, value: e.target.value } : null))}
                          />
                          <span data-repair-stage-workshop={item.id} style={{ minWidth: 140 }}>
                            <SearchSelect
                              value={editingDate.workshopId || null}
                              options={props.workshopOptions}
                              placeholder="Цех"
                              showAllWhenEmpty
                              onChange={(next) =>
                                setEditingDate((prev) => {
                                  if (!prev) return prev;
                                  // Имя — снимком из справочника сразу: писатель пересобирает
                                  // строку из входа, и id без имени уронил бы подпись.
                                  const id = String(next ?? '');
                                  return { ...prev, workshopId: id, workshopName: props.workshopOptions.find((w) => w.id === id)?.label ?? '' };
                                })
                              }
                            />
                          </span>
                          <Input
                            value={editingDate.note}
                            disabled={busy}
                            title="Примечание"
                            placeholder="Примечание"
                            data-repair-stage-note={item.id}
                            onChange={(e) => setEditingDate((prev) => (prev ? { ...prev, note: e.target.value } : null))}
                          />
                          <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap', fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={editingDate.repeat}
                              disabled={busy}
                              data-repair-stage-repeat={item.id}
                              onChange={(e) =>
                                setEditingDate((prev) =>
                                  prev ? { ...prev, repeat: e.target.checked, ...(e.target.checked ? {} : { repeatReason: '' }) } : prev,
                                )
                              }
                            />
                            Возврат
                          </label>
                          {editingDate.repeat ? (
                            <Input
                              value={editingDate.repeatReason}
                              disabled={busy}
                              title="Причина возврата"
                              placeholder="Причина возврата"
                              data-repair-stage-repeat-reason={item.id}
                              onChange={(e) => setEditingDate((prev) => (prev ? { ...prev, repeatReason: e.target.value } : null))}
                            />
                          ) : null}
                          <Button
                            variant="ghost"
                            disabled={busy}
                            data-repair-stage-apply-date={item.id}
                            onClick={() => {
                              const atMs = fromInputDate(editingDate.value);
                              if (atMs !== null) {
                                // Правка несёт все три поля: писатель пересобирает строку
                                // целиком, и непереданное стиралось бы (цех — вживую,
                                // примечание — тот же класс, закрыт раньше отдельно).
                                // Имя — свежее из справочника, иначе снимок из формы
                                // (цех мог уйти из справочника после записи).
                                const wsLabel = props.workshopOptions.find((w) => w.id === editingDate.workshopId)?.label ?? editingDate.workshopName;
                                void writeStage({
                                  id: item.id,
                                  code: editingDate.code,
                                  atMs,
                                  ...(editingDate.note.trim() ? { note: editingDate.note.trim() } : {}),
                                  ...(editingDate.workshopId ? { workshopId: editingDate.workshopId } : {}),
                                  ...(wsLabel ? { workshopName: wsLabel } : {}),
                                  repeat: editingDate.repeat,
                                  ...(editingDate.repeat ? { repeatReason: editingDate.repeatReason.trim() } : {}),
                                }).then(() => setEditingDate(null));
                              }
                            }}
                          >
                            Применить
                          </Button>
                        </span>
                      ) : (
                        <span>{item.title}</span>
                      )}
                      {item.statusLabel && <div className="ui-muted">{item.statusLabel}</div>}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>{item.workshopId ? workshopName(item.workshopId, item.workshopName) : ''}</td>
                    <td style={{ padding: '4px 6px', overflowWrap: 'break-word' }}>
                      {editingManual?.id === item.id && item.kind === 'manual' ? (
                        <Input
                          value={editingManual.note}
                          disabled={busy}
                          title="Примечание"
                          placeholder="Комментарий — что произошло, всё важное об этом событии"
                          data-manual-note={item.id}
                          onChange={(e) => setEditingManual((prev) => (prev ? { ...prev, note: e.target.value } : null))}
                        />
                      ) : (
                        <>
                          {item.reason && <div>{item.reason}</div>}
                          {item.repeatReason && item.pass >= 2 ? (
                            <div className="ui-muted" data-history-feed-repeat-reason={item.id}>
                              Возврат: {item.repeatReason}
                            </div>
                          ) : null}
                          {item.note && <div>{item.note}</div>}
                          {details.map((line) => (
                            <div key={line} className="ui-muted">
                              {line}
                            </div>
                          ))}
                        </>
                      )}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }} data-history-feed-by={item.id}>
                      {item.by ? <span className="ui-muted">{item.by}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Погашенные этапы (этап следует за датой карточки). Сняли дату в карточке — этап
          исчез из истории, но строка осталась в базе: показываем её с пометкой «почему
          исчезла» и даём вернуть. Без этого снятие даты было бы необратимой потерей. */}
      {deletedStages.length > 0 && (
        <div style={{ width: '100%', maxWidth: 1400, margin: '12px auto 0', display: 'flex', justifyContent: 'center' }}>
          <div style={{ border: '1px dashed var(--border)', borderRadius: 6, padding: 8 }} data-history-deleted-stages>
            <div className="ui-muted" style={{ marginBottom: 6 }}>
              Погашенные этапы — исчезли, потому что сняли дату в карточке. Их можно вернуть.
            </div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {deletedStages.map((row) => (
                  <tr key={row.id} data-history-deleted-stage={row.id}>
                    <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>
                      {row.at && row.at > 0 ? formatMoscowDate(new Date(row.at)) : '—'}
                    </td>
                    <td style={{ padding: '3px 6px' }}>{row.name}</td>
                    <td style={{ padding: '3px 6px' }} className="ui-muted">
                      {row.extinguished
                        ? `погашен: снята дата «${row.extinguished.attr}»${
                            row.extinguished.by ? `, ${row.extinguished.by}` : ''
                          }`
                        : 'погашен вручную'}
                    </td>
                    <td style={{ padding: '3px 6px', whiteSpace: 'nowrap' }}>
                      {props.canEdit && (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          title="Вернуть этап в историю ремонта"
                          data-history-deleted-restore={row.id}
                          onClick={() => void restoreDeletedStage(row.id, row.name)}
                        >
                          ↩ Вернуть
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}