import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  REPAIR_HISTORY_OPERATION_TYPE,
  buildEngineHistoryFeed,
  buildRepairHistoryMeta,
  engineHistoryFeedFieldLines,
  repairHistoryActionOptions,
  type EngineHistoryFeedItem,
  type EngineHistoryFeedRow,
  type RepairStageTemplate,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SearchSelect } from './SearchSelect.js';
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
  canEdit: boolean;
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
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // Две формы добавления (владелец 01.10.2026): этап из шаблона и ручная запись.
  // Обе раскрываются кнопками и прячутся после записи/отмены — инлайн-полей вверху нет.
  const [addingStage, setAddingStage] = useState(false);
  const [stageCode, setStageCode] = useState('');
  const [stageWorkshopId, setStageWorkshopId] = useState('');
  const [stageDate, setStageDate] = useState('');
  const [stageNote, setStageNote] = useState('');
  const [pendingPass, setPendingPass] = useState<{ pass: number; id: string; code: string; atMs: number; note: string } | null>(null);
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

  // Правка даты уже записанного этапа прямо в строке ленты.
  const [editingDate, setEditingDate] = useState<{ id: string; code: string; value: string } | null>(null);
  const confirmCtx = useConfirmOptional();
  // Гейт отгрузки в полёте: повторный клик не должен открыть второй гейт поверх первого.
  const shipmentGateBusy = useRef(false);

  const load = useCallback(async () => {
    try {
      const [ops, tpl] = await Promise.all([
        window.matrica.operations.list(props.engineId),
        window.matrica.workSheets.stages.templates.list(),
      ]);
      setRows((Array.isArray(ops) ? ops : []) as EngineHistoryFeedRow[]);
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

  async function writeStage(
    args: {
      id: string;
      code: string;
      atMs: number;
      note?: string;
      workshopId?: string;
      workshopName?: string;
      repeatPass?: number;
      confirmDefectDate?: boolean;
    },
  ) {
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.save({ ...args, engineId: props.engineId });
      if (!r.ok && r.duplicate) {
        setPendingPass({ pass: r.duplicate.nextPass, id: args.id, code: args.code, atMs: args.atMs, note: args.note ?? '' });
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
          `Дата разборки/дефектовки уже стоит: ${formatMoscowDate(new Date(r.defectDateChange.currentAtMs))}. Поставить ${formatMoscowDate(new Date(r.defectDateChange.nextAtMs))}? Лист дефектовки свою дату не поменяет.`,
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
      setStatus(r.backward ? `«${templateName(args.code)}» — возврат назад, записан проход № ${r.pass}.` : '');
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
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.remove(id);
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
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
    const meta = buildRepairHistoryMeta({
      action,
      workshopId: draftWorkshopId,
      note: draftNote,
      ...(Number.isFinite(typed) ? { at: typed } : {}),
    });
    try {
      setStatus('Сохраняю…');
      await window.matrica.operations.add(props.engineId, REPAIR_HISTORY_OPERATION_TYPE, 'done', meta.action, JSON.stringify(meta));
      setAddingManual(false);
      resetDraft();
      setStatus('');
      await load();
      props.onChanged?.();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700 }} {...emojiAttrs('История ремонта')}>История ремонта</span>
        <span className="ui-muted">{feed.length > 0 ? `${feed.length} событий` : 'событий пока нет'}</span>
        <div style={{ flex: 1 }} />
        {props.canEdit && (
          <>
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
          </>
        )}
      </div>

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
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }} />
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
                ...(pendingPass.note ? { note: pendingPass.note } : {}),
                repeatPass: pendingPass.pass,
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

      {addingManual && (
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

          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => setAddingManual(false)}>
              Отмена
            </Button>
            <Button onClick={() => void saveManual()} data-repair-history-save>
              Сохранить
            </Button>
          </div>
        </div>
      )}

      {status && <div className="ui-muted">{status}</div>}

      {feed.length > 0 && (
        <div style={{ width: '100%', maxWidth: 1400, margin: '0 auto', display: 'flex', justifyContent: 'center' }}>
          <table style={{ borderCollapse: 'collapse', width: 'max-content', maxWidth: '100%' }} data-history-feed-table>
            <thead>
              <tr>
                {['', 'Дата', 'Записано', 'Тип', 'Событие', 'Цех', 'Причина и примечание', 'Кто', ''].map((h, i) => (
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
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      {canFixDate &&
                        (editingDate?.id === item.id ? (
                          <Button variant="ghost" title="Отмена" onClick={() => setEditingDate(null)}>
                            ✕
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            disabled={busy}
                            title="Изменить дату этапа"
                            data-repair-stage-edit-date={item.id}
                            onClick={() => setEditingDate({ id: item.id, code: item.stageCode, value: toInputDate(item.at) })}
                          >
                            ✎
                          </Button>
                        ))}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      {item.at > 0 ? formatMoscowDate(new Date(item.at)) : '—'}
                      {item.pass >= 2 && <div className="ui-muted">проход № {item.pass} (возврат)</div>}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }} className="ui-muted" data-history-feed-recorded={item.id}>
                      {item.recordedAt > 0 ? formatMoscowDate(new Date(item.recordedAt)) : '—'}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      <span
                        className="ui-muted"
                        style={{ fontSize: 11, border: '1px solid var(--border)', borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' }}
                      >
                        {item.icon} {item.kindLabel}
                      </span>
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
                      ) : editingDate?.id === item.id ? (
                        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                          <Input
                            type="date"
                            value={editingDate.value}
                            disabled={busy}
                            title="Дата этапа"
                            data-repair-stage-date={item.id}
                            onChange={(e) => setEditingDate((prev) => (prev ? { ...prev, value: e.target.value } : null))}
                          />
                          <Button
                            variant="ghost"
                            disabled={busy}
                            data-repair-stage-apply-date={item.id}
                            onClick={() => {
                              const atMs = fromInputDate(editingDate.value);
                              if (atMs !== null) {
                                void writeStage({ id: item.id, code: editingDate.code, atMs }).then(() => setEditingDate(null));
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
                      {item.reason && <div>{item.reason}</div>}
                      {item.note && <div>{item.note}</div>}
                      {details.map((line) => (
                        <div key={line} className="ui-muted">
                          {line}
                        </div>
                      ))}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }} data-history-feed-by={item.id}>
                      {item.by ? <span className="ui-muted">{item.by}</span> : null}
                    </td>
                    <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                      {props.canEdit && item.editable && (
                        <Button variant="ghost" disabled={busy} title="Убрать этап" data-repair-stage-remove={item.id} onClick={() => void removeStage(item.id, item.title)}>
                          ✕
                        </Button>
                      )}
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