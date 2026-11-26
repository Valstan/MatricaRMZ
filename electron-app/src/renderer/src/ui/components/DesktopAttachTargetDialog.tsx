import React, { useEffect, useMemo, useState } from 'react';

import { desktopAttachTarget, desktopAttachTargetKinds, type DesktopAttachTarget } from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';

// «Прикрепить к карточке…» — выбор карточки-цели для файлов с Верстака.
//
// Поиск тот же, что у глобального поиска (Ctrl+K): сервер отдаёт вид сущности, id и подпись.
// Показываются ТОЛЬКО карточки, которые умеют принять вложения (см. DESKTOP_ATTACH_TARGETS в
// домене): выбрать цель, которая файл молча не примет, — хуже, чем не предложить её вовсе.
//
// Смысла в собственном поиске нет: дублировать глобальный поиск — это второй источник правды
// о том, где что лежит, и он разъедется с первым.

type Hit = { kind: string; id: string; label: string; sublabel?: string; code?: string };

const MIN_CHARS = 2;

export function DesktopAttachTargetDialog(props: {
  open: boolean;
  /** Сколько файлов пойдёт в выбранную карточку — показываем оператору. */
  fileCount: number;
  onClose: () => void;
  /** Выбранная цель: куда открываться и по какому `scope` примет файлы. */
  onPick: (target: DesktopAttachTarget & { id: string; label: string }) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setHits([]);
    setError('');
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setHits([]);
      setError('');
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setBusy(true);
      try {
        const r = await window.matrica.search.global({ q, limit: 40 });
        if (cancelled) return;
        setError('');
        setHits(((r?.hits ?? []) as Hit[]).filter((h) => h && h.id && h.kind));
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, props.open]);

  const allowed = useMemo(() => new Set(desktopAttachTargetKinds()), []);
  const rows = useMemo(
    () => hits.filter((h) => allowed.has(h.kind) && desktopAttachTarget(h.kind, h.id) !== null),
    [hits, allowed],
  );

  if (!props.open) return null;

  return (
    <div
      data-attach-target-dialog
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(2, 6, 23, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1200,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 20,
          width: 'min(560px, 100%)',
          display: 'grid',
          gap: 10,
        }}
      >
        <div style={{ fontWeight: 700, fontSize: 17 }}>📎 Прикрепить к карточке</div>
        <div className="ui-muted">
          Файлов с Верстака: {props.fileCount}. Карточка заберёт их сама — доступ к каждому файлу
          проверяется сервером, и то, что вам не открывается, приложить не выйдет.
        </div>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Номер двигателя, контракт, сотрудник…"
          autoFocus
        />
        {error ? <div style={{ color: '#b91c1c', fontSize: 12 }}>Поиск не отработал: {error}</div> : null}
        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 4 }}>
          {busy && rows.length === 0 ? <div className="ui-muted">Ищу…</div> : null}
          {!busy && query.trim().length >= MIN_CHARS && rows.length === 0 ? (
            <div className="ui-muted">Подходящих карточек не нашлось. Ищите по номеру двигателя или названию.</div>
          ) : null}
          {rows.map((h) => (
            <button
              key={`${h.kind}:${h.id}`}
              type="button"
              data-attach-target={h.id}
              onClick={() => {
                const target = desktopAttachTarget(h.kind, h.id);
                if (!target) return;
                props.onPick({ ...target, label: h.label });
              }}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                cursor: 'pointer',
              }}
            >
              <div style={{ fontWeight: 600 }}>{h.label}</div>
              <div style={{ fontSize: 12, color: 'var(--subtle)' }}>
                {h.sublabel ? `${h.sublabel}` : h.kind}
                {h.code ? ` · ${h.code}` : ''}
              </div>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={props.onClose}>
            Отмена
          </Button>
        </div>
      </div>
    </div>
  );
}
