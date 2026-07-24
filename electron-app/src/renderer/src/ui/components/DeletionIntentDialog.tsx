import React, { useEffect, useMemo, useState } from 'react';

import type { EntityReferenceTarget, IncomingReferenceGroup } from '@matricarmz/shared';

import { EntityReferenceField } from './EntityReferenceField.js';
import type { SearchSelectOption } from './SearchSelect.js';

/**
 * Диалог намерения при удалении (Ф2/Ф3). Показывает входящие ссылки на удаляемый объект
 * и предлагает 4 действия: оставить / удалить связи / заменить / отложить в «Заметки».
 * Само удаление и разрешение ссылок выполняет admin.entities.resolveAndDelete.
 */
export function DeletionIntentDialog(props: {
  entityId: string;
  /** Человеческое имя удаляемого объекта (для заголовка/заметки). */
  entityLabel: string;
  /** Родительный падеж типа для текста: «марку двигателя», «контрагента». */
  targetLabelGenitive: string;
  /** Тип для пикера замены. */
  replaceTarget: EntityReferenceTarget;
  /** Живые объекты того же типа для замены (без самого удаляемого). */
  replaceOptions: SearchSelectOption[];
  onClose: (didDelete: boolean) => void;
}) {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'busy' | 'error'>('loading');
  const [groups, setGroups] = useState<IncomingReferenceGroup[]>([]);
  const [error, setError] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacementId, setReplacementId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await window.matrica.admin.entities.incomingReferences(props.entityId);
      if (!alive) return;
      if (!r.ok) {
        setError(r.error);
        setPhase('error');
        return;
      }
      setGroups(r.groups);
      setPhase('ready');
    })();
    return () => {
      alive = false;
    };
  }, [props.entityId]);

  const totalRefs = useMemo(() => groups.reduce((n, g) => n + g.paths.length, 0), [groups]);

  async function apply(mode: 'leave' | 'remove' | 'replace', asReminder = false) {
    setPhase('busy');
    const opts = mode === 'replace' ? { mode, ...(replacementId ? { replacementId } : {}) } : { mode };
    const r = await window.matrica.admin.entities.resolveAndDelete(props.entityId, opts);
    if (!r.ok) {
      setError(r.error);
      setPhase('error');
      return;
    }
    if (asReminder && groups.length > 0) {
      const lines = groups.map((g) => `• ${g.sourceTypeLabel} ${g.sourceLabel}`).join('\n');
      await window.matrica.notes
        .upsert({
          title: `Заменить удалённый объект: ${props.entityLabel}`,
          body: [
            {
              id: crypto.randomUUID(),
              kind: 'text',
              text: `Объект «${props.entityLabel}» удалён, связи сняты. Выбрать замену в:\n${lines}`,
            },
          ],
          importance: 'important',
        })
        .catch(() => null);
    }
    props.onClose(true);
  }

  const overlay: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  };
  const card: React.CSSProperties = {
    background: 'var(--card-bg, #fff)',
    color: 'var(--text)',
    borderRadius: 12,
    border: '1px solid var(--border)',
    padding: 20,
    width: 'min(560px, 92vw)',
    maxHeight: '86vh',
    overflowY: 'auto',
    boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
  };
  const btn: React.CSSProperties = {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--button-ghost-bg)',
    color: 'var(--text)',
    cursor: 'pointer',
    textAlign: 'left',
  };

  const busy = phase === 'busy' || phase === 'loading';

  return (
    <div style={overlay} onClick={() => !busy && props.onClose(false)}>
      <div style={card} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px' }}>Удаление: {props.entityLabel}</h3>

        {phase === 'loading' && <div style={{ color: 'var(--muted)' }}>Ищу связанные объекты…</div>}
        {phase === 'error' && <div style={{ color: 'var(--danger, #b91c1c)' }}>Ошибка: {error}</div>}

        {phase !== 'loading' && phase !== 'error' && groups.length === 0 && (
          <>
            <div style={{ color: 'var(--muted)', margin: '8px 0 16px' }}>
              Связанных объектов не найдено. Удалить {props.targetLabelGenitive}?
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" style={btn} disabled={busy} onClick={() => props.onClose(false)}>
                Отмена
              </button>
              <button type="button" style={{ ...btn, background: 'var(--danger, #b91c1c)', color: '#fff' }} disabled={busy} onClick={() => void apply('leave')}>
                Удалить
              </button>
            </div>
          </>
        )}

        {phase !== 'loading' && phase !== 'error' && groups.length > 0 && (
          <>
            <div style={{ color: 'var(--muted)', margin: '8px 0 12px' }}>
              На этот объект ссылаются {groups.length} записей ({totalRefs} ссылок). Что сделать со связями?
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginBottom: 14, fontSize: 13 }}>
              {groups.map((g) => (
                <div key={`${g.sourceKind}:${g.sourceId}`} style={{ padding: '2px 0' }}>
                  <b>{g.sourceTypeLabel}</b> {g.sourceLabel}
                </div>
              ))}
            </div>

            {replaceOpen ? (
              <div style={{ marginBottom: 12 }}>
                <div style={{ color: 'var(--muted)', marginBottom: 6 }}>Заменить на:</div>
                <EntityReferenceField
                  target={props.replaceTarget}
                  targetLabel="Замена"
                  value={replacementId}
                  options={props.replaceOptions}
                  onChange={setReplacementId}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                  <button type="button" style={btn} disabled={busy} onClick={() => setReplaceOpen(false)}>
                    Назад
                  </button>
                  <button type="button" style={{ ...btn, background: '#2563eb', color: '#fff' }} disabled={busy || !replacementId} onClick={() => void apply('replace')}>
                    Заменить и удалить
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                <button type="button" style={btn} disabled={busy} onClick={() => setReplaceOpen(true)}>
                  🔁 Заменить связи на другой объект…
                </button>
                <button type="button" style={btn} disabled={busy} onClick={() => void apply('remove')}>
                  ✂️ Удалить связи и удалить объект
                </button>
                <button type="button" style={btn} disabled={busy} onClick={() => void apply('remove', true)}>
                  🔔 Удалить связи, замену отложить в «Заметки»
                </button>
                <button type="button" style={btn} disabled={busy} onClick={() => void apply('leave')}>
                  ⚠️ Оставить связи висячими и удалить
                </button>
                <button type="button" style={{ ...btn, textAlign: 'center', marginTop: 4 }} disabled={busy} onClick={() => props.onClose(false)}>
                  Отмена
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
