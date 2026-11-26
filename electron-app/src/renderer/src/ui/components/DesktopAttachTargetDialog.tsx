import React, { useEffect, useMemo, useState } from 'react';

import {
  desktopAttachTarget,
  desktopAttachTargetKinds,
  globalSearchKindLabel,
  type DesktopAttachTarget,
  type GlobalSearchKind,
} from '@matricarmz/shared';

import { Button } from './Button.js';
import { Input } from './Input.js';
import { SearchModeToggle, searchModeOf } from './SearchModeToggle.js';
import { searchModeEmptyText } from './SearchModeHint.js';
import { useSearchMode } from '../hooks/useSearchMode.js';
import { L2_SOURCES, pickL2Label, type L2Row } from '../services/globalSearchSources.js';
import { filterPreparedRecords, prepareRecordSearch, type PreparedRecordSearch } from '../utils/search.js';

// «Прикрепить к карточке…» — выбор карточки-цели для файлов с Верстака.
//
// Поиск ТОТ ЖЕ, что у глобального поиска (Ctrl+K), — а именно обе его дыры:
//
//   • СПРАВОЧНИКИ (L2) — двигатели, договоры, сотрудники, марки, контрагенты,
//     инструменты. Именно из них карточка-цель и берётся.
//   • СЕРВЕР (L3) — номенклатура и складские документы; они карточками-приёмниками
//     не являются и отсеиваются фильтром ниже, но слой оставлен: это тот же
//     перечень, что у палитры.
//
// ⚠️ Один слой — это не «тот же поиск», а его ПОЛОВИНА: серверный поиск (`GET /search`)
// смотрит только номенклатуру и складские документы (`backend-api/src/services/
// globalSearchService.ts`), и ДВИГАТЕЛЯ в нём нет никогда. На этом споткнулась
// живая приёмка 26.11.2026: выбор карточки-цели по двигателю не нашёл ничего,
// хотя карточка двигателя принимает файлы.
//
// Смысла в собственном поиске нет: дублировать глобальный поиск — это второй
// источник правды о том, где что лежит, и он разъедется с первым.

type Hit = { kind: GlobalSearchKind; id: string; label: string; sublabel?: string; code?: string };

const MIN_CHARS = 2;
const PER_KIND_LIMIT = 20;

/** Источники справочников, из которых берётся карточка-цель. */
const ATTACH_SOURCES = L2_SOURCES.filter((src) => desktopAttachTargetKinds().includes(src.kind));

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
  /** Строки справочников (L2) — грузятся один раз при открытии диалога. */
  const [directoryRows, setDirectoryRows] = useState<Partial<Record<string, L2Row[]>>>({});
  // Режим поиска — общий для всех экранов (владелец 13.11.2026): пока в поле печатают,
  // ищется ТОЧНО; «≈ Похожие» включается кнопкой и только на это время. Диалог ищет по
  // справочникам так же, как палитра Ctrl+K, — правило одно на все экраны поиска.
  const { similar: searchSimilar, toggle: toggleSearchMode } = useSearchMode({ query });
  const searchMode = searchModeOf(searchSimilar);

  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setHits([]);
    setError('');
  }, [props.open]);

  // Справочники (L2) — тот же заход, что у палитры Ctrl+K: список двигателей,
  // договоров и т.д. через те же мосты, через которые их читают свои страницы.
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    void (async () => {
      const loaded: Record<string, L2Row[]> = {};
      await Promise.all(
        ATTACH_SOURCES.map(async (src) => {
          loaded[src.kind] = await src.load();
        }),
      );
      if (alive) setDirectoryRows(loaded);
    })();
    return () => {
      alive = false;
    };
  }, [props.open]);

  // Подготовка строк — один раз на набор (поиск по строке дешёвый, подготовка нет).
  const prepared = useMemo(() => {
    const out: Partial<Record<string, PreparedRecordSearch<L2Row>>> = {};
    for (const src of ATTACH_SOURCES) {
      const rows = directoryRows[src.kind] ?? [];
      if (rows.length === 0) continue;
      out[src.kind] = prepareRecordSearch(
        rows,
        (r) => String(r.id ?? ''),
        (r) => pickL2Label(r),
        { kind: src.kind },
      );
    }
    return out;
  }, [directoryRows]);

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
        // Слой 1 — справочники: двигатели, договоры, сотрудники, марки, инструменты.
        const found: Hit[] = [];
        for (const src of ATTACH_SOURCES) {
          const prep = prepared[src.kind];
          if (!prep) continue;
          const tier = filterPreparedRecords(prep, q, searchMode);
          for (const r of tier.records.slice(0, PER_KIND_LIMIT)) {
            const id = String(r.id ?? '');
            if (!id) continue;
            found.push({ kind: src.kind, id, label: pickL2Label(r) || id, code: src.getCode?.(r) ?? '' });
          }
        }
        // Слой 2 — сервер: номенклатура и складские документы (в выдаче цели не
        // попадут — их отсечёт фильтр карточек-приёмников, но слой тот же).
        let serverHits: Hit[] = [];
        try {
          const r = await window.matrica.search.global({ q, limit: 40 });
          serverHits = ((r?.hits ?? []) as Array<{ kind: GlobalSearchKind; id: string; label: string; code?: string }>).filter(
            (h) => h && h.id && h.kind,
          );
        } catch {
          serverHits = [];
        }
        if (cancelled) return;
        setError('');
        const seen = new Set<string>();
        setHits([...found, ...serverHits].filter((h) => {
          const key = `${h.kind}|${h.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }));
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
  }, [query, props.open, prepared, searchMode]);

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1 }}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Номер двигателя, контракт, сотрудник…"
              autoFocus
            />
          </div>
          <SearchModeToggle similar={searchSimilar} onToggle={toggleSearchMode} />
        </div>
        {error ? <div style={{ color: '#b91c1c', fontSize: 12 }}>Поиск не отработал: {error}</div> : null}
        <div style={{ maxHeight: 320, overflowY: 'auto', display: 'grid', gap: 4 }}>
          {busy && rows.length === 0 ? <div className="ui-muted">Ищу…</div> : null}
          {!busy && query.trim().length >= MIN_CHARS && rows.length === 0 ? (
            <div className="ui-muted">
              {searchModeEmptyText(
                searchSimilar,
                query,
                'Подходящих карточек не нашлось. Ищите по номеру двигателя или названию.',
              )}
            </div>
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
                {h.sublabel ? `${h.sublabel}` : globalSearchKindLabel(h.kind)}
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
