import React, { useCallback, useEffect, useState } from 'react';

import type { RepairStageTemplate } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { ListReorderHandle } from './ListReorderHandle.js';
import { useListReorder } from '../hooks/useListReorder.js';

const AUTO_FROM_LABELS: Record<string, string> = {
  defectAct: 'Кнопка «Провести дефектовку»',
  kittingAct: 'Кнопка «Провести комплектность»',
};

type Draft = { id: string | null; code: string; name: string; autoFrom: string; sideBranch: boolean; updatedAt: number | null };

function draftFrom(t: RepairStageTemplate | null): Draft {
  return t
    ? { id: t.id ?? null, code: t.code, name: t.name, autoFrom: t.autoFrom ?? '', sideBranch: t.sideBranch === true, updatedAt: t.updatedAt ?? null }
    : { id: null, code: '', name: '', autoFrom: '', sideBranch: false, updatedAt: null };
}

/**
 * Справочник шаблона этапов (план unified-repair-stages, шаг 5b): названия,
 * новые этапы, архив и приоритет. Приоритет — порядком в списке: мышкой
 * (drag-and-drop) или стрелками — на планшете перетаскивания нет, поэтому
 * стрелки остаются всегда. Сервер перенумеровывает 10/20/… одним вызовом.
 */
export function RepairStageTemplateDialog(props: {
  onClose: () => void;
  onChanged: () => Promise<void> | void;
  /** Встроить в чужую обёртку («Карта этапов»): без затемнения и своей панели. */
  bare?: boolean;
}) {
  const [rows, setRows] = useState<RepairStageTemplate[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await window.matrica.workSheets.stages.templates.list({ includeArchived: true });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setRows(res.templates);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const live = rows.filter((t) => t.archivedAt == null);
  const archived = rows.filter((t) => t.archivedAt != null);
  const selected = live.find((t) => t.code === selectedCode) ?? null;

  const pick = (t: RepairStageTemplate | null) => {
    setSelectedCode(t?.code ?? null);
    setDraft(draftFrom(t));
    setStatus('');
  };

  async function commitOrder(next: RepairStageTemplate[]) {
    if (next.some((t) => !t.id)) {
      setStatus('Порядок двигаем только на сервере — без связи со справочником он не сохранится.');
      return;
    }
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.templates.reorder(next.map((t) => t.id as string));
      if (!r.ok) {
        setStatus(`Ошибка: ${r.error}`);
        return;
      }
      await refresh();
      await props.onChanged();
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // ПОРЯДОК ЭТАПОВ — по общему киту (промт КАРМАНА #67): единая ручка «⠿» вместо
  // кнопок ↑/↓ и своего drag-and-drop. Кит считает механику перемещения (мышь, стрелки,
  // линия места вставки), а сохраняет порядок по-прежнему сервер — `commitOrder`
  // вызывает `templates.reorder` и сервер перенумеровывает приоритеты.
  const reorder = useListReorder({
    rows: live,
    canReorder: !busy,
    onReorder: (next) => void commitOrder(next),
  });

  const [mergeSource, setMergeSource] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [mergeInfo, setMergeInfo] = useState('');

  const dryRunMerge = async () => {
    if (!mergeSource || !mergeTarget) return setMergeInfo('Выберите оба этапа');
    if (mergeSource === mergeTarget) return setMergeInfo('Исходный и целевой этапы совпадают');
    setBusy(true);
    setMergeInfo('');
    try {
      const r = (await window.matrica.workSheets.stages.templates.merge({
        sourceId: mergeSource,
        targetId: mergeTarget,
        dryRun: true,
      })) as { ok: boolean; moved?: number; error?: string };
      if (!r.ok) return setMergeInfo(`Ошибка: ${r.error ?? 'unknown'}`);
      setMergeInfo(`Строк к переезду: ${r.moved ?? 0}. Подтвердите слияние — исходный этап уйдёт в архив.`);
    } catch (e) {
      setMergeInfo(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const applyMerge = async () => {
    if (!mergeSource || !mergeTarget || mergeSource === mergeTarget) return;
    if (!window.confirm('Объединить этапы? Все строки истории переедут на целевой этап, исходный уйдёт в архив.')) return;
    setBusy(true);
    setMergeInfo('');
    try {
      const r = (await window.matrica.workSheets.stages.templates.merge({
        sourceId: mergeSource,
        targetId: mergeTarget,
      })) as { ok: boolean; moved?: number; error?: string };
      if (!r.ok) return setMergeInfo(`Ошибка: ${r.error ?? 'unknown'}`);
      setMergeInfo(`Готово: переехало строк — ${r.moved ?? 0}.`);
      setMergeSource('');
      setMergeTarget('');
      await refresh();
      await props.onChanged();
    } catch (e) {
      setMergeInfo(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeForever = async () => {
    if (!selected?.id) return;
    if (!window.confirm(`Удалить этап «${selected.name}» навсегда? Возможно только если у него нет строк в истории.`)) return;
    setBusy(true);
    try {
      const r = (await window.matrica.workSheets.stages.templates.remove(selected.id)) as {
        ok: boolean;
        error?: string;
      };
      if (!r.ok) return setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
      await refresh();
      await props.onChanged();
      pick(null);
      setStatus('Этап удалён');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft.name.trim()) return setStatus('Название этапа обязательно');
    setBusy(true);
    setStatus('');
    try {
      const r = await window.matrica.workSheets.stages.templates.upsert({
        ...(draft.id ? { id: draft.id } : {}),
        ...(draft.id ? {} : draft.code.trim() ? { code: draft.code.trim() } : {}),
        name: draft.name.trim(),
        ...(draft.autoFrom ? { autoFrom: draft.autoFrom } : { autoFrom: null }),
        ...(draft.sideBranch ? { sideBranch: true } : {}),
        ...(draft.id && draft.updatedAt != null ? { expectedUpdatedAt: draft.updatedAt } : {}),
      });
      if (!r.ok) return setStatus(`Ошибка: ${r.error}`);
      await refresh();
      await props.onChanged();
      pick(r.row);
      setStatus('Сохранено');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!selected?.id) return;
    if (!window.confirm(`Убрать этап «${selected.name}» в архив? Строки этапов в истории останутся.`)) return;
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.templates.archive(selected.id);
      if (!r.ok) return setStatus(`Ошибка: ${r.error}`);
      await refresh();
      await props.onChanged();
      pick(null);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (t: RepairStageTemplate) => {
    if (!t.id) return;
    setBusy(true);
    try {
      const r = await window.matrica.workSheets.stages.templates.restore(t.id);
      if (!r.ok) return setStatus(`Ошибка: ${r.error}`);
      await refresh();
      await props.onChanged();
      setStatus(`Этап «${t.name}» возвращён из архива`);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const body = (
    <div
      onClick={(e) => e.stopPropagation()}
      style={
        props.bare
          ? // В «Карте этапов» панель и прокрутка — у оболочки, здесь только внутренняя сетка.
            { display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14 }
          : { background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(900px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14 }
      }
    >
        <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
          <div style={{ fontWeight: 700 }}>Шаблон этапов</div>
          <div className="ui-muted" style={{ fontSize: 12 }}>Порядок — приоритет: тяните мышкой за ручку «⠿» или двигайте стрелками</div>
          {/* Граница списка: перетаскивание считает строки ТОЛЬКО живых этапов. */}
          <div ref={reorder.scopeRef} style={{ display: 'grid', gap: 6 }}>
            {live.map((t, idx) => {
              const key = reorder.keys[idx] ?? '';
              return (
                <div
                  key={t.code}
                  data-stage-template-row={t.code}
                  // Маркер строки для кита перестановки (промт КАРМАНА #67).
                  data-list-row="true"
                  data-list-row-key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: t.code === selectedCode ? 'rgba(59,130,246,0.12)' : 'transparent',
                    ...reorder.rowStyle(key),
                  }}
                  onDragOver={reorder.onDragOver}
                  onDrop={reorder.onDrop}
                >
                  <ListReorderHandle {...reorder.handleProps(key, { label: `этап ${idx + 1}` })} />
                  <button
                    type="button"
                    onClick={() => pick(t)}
                    style={{ flex: 1, textAlign: 'left', background: 'transparent', border: 0, cursor: 'pointer', padding: 0 }}
                  >
                    {t.name}
                    {t.sideBranch ? <span className="ui-muted"> · вне порядка</span> : null}
                    {t.autoFrom ? <span className="ui-muted"> · автомат</span> : null}
                  </button>
                </div>
              );
            })}
          </div>
          <Button variant="ghost" onClick={() => pick(null)} data-stage-template-new>
            + Новый этап
          </Button>

          {archived.length > 0 ? (
            <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
              <div className="ui-muted" style={{ fontSize: 12 }}>В архиве — строки этапов остались, код занят</div>
              {archived.map((t) => (
                <div key={t.code} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="ui-muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                  <Button variant="ghost" disabled={busy} onClick={() => void restore(t)} title="Вернуть этап из архива">
                    Вернуть
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
          <div style={{ fontWeight: 700, fontSize: 16 }}>{draft.id ? `Этап «${selected?.name ?? ''}»` : 'Новый этап'}</div>
          {!draft.id && (
            <Input value={draft.code} onChange={(e) => setDraft((d) => ({ ...d, code: e.target.value }))} placeholder="Код латиницей (после создания не меняется)" />
          )}
          <Input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="Название этапа" />
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            Автопростановка
            <select
              value={draft.autoFrom}
              onChange={(e) => setDraft((d) => ({ ...d, autoFrom: e.target.value }))}
              style={{ flex: 1, padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
            >
              <option value="">—</option>
              {Object.entries(AUTO_FROM_LABELS).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.sideBranch} onChange={(e) => setDraft((d) => ({ ...d, sideBranch: e.target.checked }))} />
            Вне порядка (утиль, брак)
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => void save()} data-stage-template-save>
              Сохранить
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                // Применить приоритеты — пересохранить порядок на сервере
                void commitOrder(live);
              }}
              title="Сохранить текущий порядок этапов как приоритеты"
              data-stage-template-apply-priorities
            >
              Применить приоритеты
            </Button>
            {draft.id && (
              <Button variant="ghost" onClick={() => void archive()}>
                В архив
              </Button>
            )}
            {draft.id && (
              <Button variant="ghost" disabled={busy} onClick={() => void removeForever()} title="Удалить навсегда — только если у этапа нет строк в истории">
                Удалить
              </Button>
            )}
            {/* Управляющие кнопки влево (владелец 24.11.2026, промт КАРМАНА #141):
                «Закрыть» — в одной группе с кнопками шаблона, не у правого края. */}
            <Button variant="ghost" onClick={() => props.onClose()}>
              Закрыть
            </Button>
          </div>
          {status && <div className="ui-muted">{status}</div>}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'grid', gap: 8 }} data-stage-template-merge>
            <div style={{ fontWeight: 700 }}>Объединить дубли</div>
            <div className="ui-muted" style={{ fontSize: 12 }}>
              Все строки истории исходного этапа переедут на целевой (через журнал — парк получит переезд синком), исходный уйдёт в архив.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="ui-muted" style={{ fontSize: 12 }}>Исходный (исчезнет)</span>
                <select
                  value={mergeSource}
                  disabled={busy}
                  data-stage-merge-source
                  onChange={(e) => setMergeSource(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
                >
                  <option value="">—</option>
                  {live.map((t) => (
                    <option key={t.code} value={t.id ?? ''}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="ui-muted" style={{ fontSize: 12 }}>Целевой (останется)</span>
                <select
                  value={mergeTarget}
                  disabled={busy}
                  data-stage-merge-target
                  onChange={(e) => setMergeTarget(e.target.value)}
                  style={{ padding: '6px 8px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)' }}
                >
                  <option value="">—</option>
                  {live.map((t) => (
                    <option key={t.code} value={t.id ?? ''}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="ghost" disabled={busy} onClick={() => void dryRunMerge()} data-stage-merge-dry-run>
                Посчитать строки
              </Button>
              <Button disabled={busy} onClick={() => void applyMerge()} data-stage-merge-apply>
                Объединить
              </Button>
            </div>
            {mergeInfo && <div className="ui-muted">{mergeInfo}</div>}
          </div>
        </div>
    </div>
  );

  if (props.bare) return body;
  return (
    <div
      role="dialog"
      aria-label="Шаблон этапов ремонта"
      data-stage-template-editor
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
      onClick={() => {
        if (!busy) props.onClose();
      }}
    >
      {body}
    </div>
  );
}
