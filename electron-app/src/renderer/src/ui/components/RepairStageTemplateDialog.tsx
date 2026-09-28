import React, { useCallback, useEffect, useState } from 'react';

import type { RepairStageTemplate } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { RowReorderButtons } from './RowReorderButtons.js';

const AUTO_FROM_LABELS: Record<string, string> = {
  defectAct: 'Кнопка «Провести дефектовку»',
  kittingAct: 'Кнопка «Провести комплектность»',
  obkatkaRow: 'Строка обкатки',
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
export function RepairStageTemplateDialog(props: { onClose: () => void; onChanged: () => Promise<void> | void }) {
  const [rows, setRows] = useState<RepairStageTemplate[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [dragCode, setDragCode] = useState<string | null>(null);

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

  const move = (code: string, dir: -1 | 1) => {
    const i = live.findIndex((t) => t.code === code);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= live.length) return;
    const next = [...live];
    const [taken] = next.splice(i, 1);
    next.splice(j, 0, taken!);
    void commitOrder(next);
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
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ background: 'var(--surface)', borderRadius: 10, padding: 16, width: 'min(900px, 96vw)', maxHeight: '90vh', overflow: 'auto', display: 'grid', gridTemplateColumns: '280px 1fr', gap: 14 }}
      >
        <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
          <div style={{ fontWeight: 700 }}>Шаблон этапов</div>
          <div className="ui-muted" style={{ fontSize: 12 }}>Порядок — приоритет: тяните мышкой или стрелками</div>
          {live.map((t) => (
            <div
              key={t.code}
              draggable={!busy}
              data-stage-template-row={t.code}
              onDragStart={() => setDragCode(t.code)}
              onDragEnd={() => setDragCode(null)}
              onDragOver={(e) => {
                e.preventDefault();
              }}
              onDrop={() => {
                if (!dragCode || dragCode === t.code) return;
                const from = live.findIndex((x) => x.code === dragCode);
                const to = live.findIndex((x) => x.code === t.code);
                if (from < 0 || to < 0) return;
                const next = [...live];
                const [taken] = next.splice(from, 1);
                next.splice(to, 0, taken!);
                setDragCode(null);
                void commitOrder(next);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: t.code === selectedCode ? 'rgba(59,130,246,0.12)' : dragCode === t.code ? 'rgba(59,130,246,0.06)' : 'transparent',
                cursor: busy ? 'default' : 'grab',
              }}
            >
              <RowReorderButtons
                canMoveUp={!busy && live[0]?.code !== t.code}
                canMoveDown={!busy && live[live.length - 1]?.code !== t.code}
                onMoveUp={() => move(t.code, -1)}
                onMoveDown={() => move(t.code, 1)}
                stopPropagation
              />
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
          ))}
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
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => void save()} data-stage-template-save>
              Сохранить
            </Button>
            {draft.id && (
              <Button variant="ghost" onClick={() => void archive()}>
                В архив
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <Button variant="ghost" onClick={() => props.onClose()}>
              Закрыть
            </Button>
          </div>
          {status && <div className="ui-muted">{status}</div>}
        </div>
      </div>
    </div>
  );
}
