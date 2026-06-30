import React, { useCallback, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';

// Чистка пустых авто-созданных карточек/документов (запрос владельца 2026-06-29). Сервер
// сканирует пустышки по типам; решение об удалении за оператором (галочки + подтверждение).
// Удаление — soft-delete через синк, с серверной ре-валидацией «пусто» перед удалением.

type EmptyCardKind = 'engine' | 'contract' | 'employee' | 'work_order' | 'supply_request';
type EmptyCardRow = { id: string; kind: string; label: string; createdAt: number };
type EmptyCardsGroup = { kind: EmptyCardKind; label: string; rows: EmptyCardRow[] };
type DeleteReport = { deleted: number; skipped: Array<{ id: string; reason: string }> };

function formatDate(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleDateString('ru-RU');
  } catch {
    return '—';
  }
}

export function EmptyCardsCleanupPage(props: { canEdit: boolean }) {
  const { confirm } = useConfirm();
  const [groups, setGroups] = useState<EmptyCardsGroup[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [lastReport, setLastReport] = useState<DeleteReport | null>(null);

  const analyze = useCallback(async () => {
    setBusy(true);
    setError('');
    setLastReport(null);
    try {
      const r = await window.matrica.maintenance.emptyCardsAnalyze();
      if (!r?.ok) {
        setError(String((r as { error?: string })?.error ?? 'не удалось выполнить анализ'));
        setGroups(null);
        return;
      }
      const nextGroups = (r.groups ?? []) as EmptyCardsGroup[];
      setGroups(nextGroups);
      setTotal(Number(r.total ?? 0));
      // пустышки подтверждены сервером — по умолчанию отмечены к удалению
      const next: Record<string, boolean> = {};
      for (const g of nextGroups) for (const row of g.rows) next[row.id] = true;
      setChecked(next);
    } finally {
      setBusy(false);
    }
  }, []);

  const selectedIds = useMemo(() => {
    const ids: string[] = [];
    for (const g of groups ?? []) for (const row of g.rows) if (checked[row.id]) ids.push(row.id);
    return ids;
  }, [groups, checked]);

  const setGroupChecked = useCallback((g: EmptyCardsGroup, value: boolean) => {
    setChecked((prev) => {
      const next = { ...prev };
      for (const row of g.rows) next[row.id] = value;
      return next;
    });
  }, []);

  const deleteSelected = useCallback(async () => {
    if (selectedIds.length === 0) return;
    const ok = await confirm({
      title: 'Удалить пустые карточки?',
      detail: `Будет удалено пустых карточек/документов: ${selectedIds.length}. Они помечаются удалёнными (soft-delete) и пропадут у всех клиентов. Карточки, на которые ссылаются другие записи, будут пропущены.`,
      confirmLabel: 'Удалить',
    });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      const r = await window.matrica.maintenance.emptyCardsDelete({ ids: selectedIds });
      if (!r?.ok) {
        setError(String((r as { error?: string })?.error ?? 'не удалось удалить'));
        return;
      }
      setLastReport({ deleted: Number(r.deleted ?? 0), skipped: r.skipped ?? [] });
      await analyze();
    } finally {
      setBusy(false);
    }
  }, [analyze, confirm, selectedIds]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Пустые карточки</h2>
        <Button onClick={() => void analyze()} disabled={busy}>
          {busy ? 'Поиск…' : groups === null ? 'Найти пустые' : 'Повторить поиск'}
        </Button>
        {groups !== null && <span style={{ color: '#64748b', fontSize: 13 }}>найдено пустых: {total}</span>}
      </div>

      <div style={{ color: '#64748b', fontSize: 13, maxWidth: 900 }}>
        Пустые — авто-созданные карточки и документы, в которые ничего не внесли (нет номера/марки у двигателя,
        реквизитов у договора, ФИО/логина у сотрудника, строк работ в наряде, позиций в заявке). Отметьте галочками,
        что удалить, и нажмите «Удалить выбранные». Удаление обратимо на уровне синка (soft-delete); карточки со
        ссылками из других записей будут пропущены.
      </div>

      {error && <div style={{ color: '#b91c1c' }}>{error}</div>}

      {lastReport && (
        <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 10, padding: 10, fontSize: 13 }}>
          <b>Удалено: {lastReport.deleted}.</b>
          {lastReport.skipped.length > 0 && (
            <div style={{ color: '#92400e', marginTop: 4 }}>
              Пропущено ({lastReport.skipped.length}): {lastReport.skipped.map((s) => `…${s.id.slice(-6)} — ${s.reason}`).join('; ')}
            </div>
          )}
        </div>
      )}

      {groups !== null && groups.length === 0 && <div style={{ color: '#16a34a' }}>Пустых карточек не найдено 🎉</div>}

      {props.canEdit && (groups?.length ?? 0) > 0 && (
        <div>
          <Button onClick={() => void deleteSelected()} disabled={busy || selectedIds.length === 0}>
            Удалить выбранные ({selectedIds.length})
          </Button>
        </div>
      )}

      {(groups ?? []).map((g) => {
        const allChecked = g.rows.every((row) => checked[row.id]);
        return (
          <div key={g.kind} style={{ border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#334155' }}>
              {g.label} — {g.rows.length}
            </div>
            <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ color: '#64748b', textAlign: 'left' }}>
                  <th style={{ padding: '4px 8px' }}>
                    <input
                      type="checkbox"
                      checked={allChecked}
                      disabled={!props.canEdit}
                      onChange={(e) => setGroupChecked(g, e.target.checked)}
                      aria-label="Выбрать все в группе"
                    />
                  </th>
                  <th style={{ padding: '4px 8px' }}>Карточка</th>
                  <th style={{ padding: '4px 8px' }}>Создана</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((row) => (
                  <tr key={row.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                    <td style={{ padding: '4px 8px' }}>
                      <input
                        type="checkbox"
                        checked={Boolean(checked[row.id])}
                        disabled={!props.canEdit}
                        onChange={(e) => setChecked((prev) => ({ ...prev, [row.id]: e.target.checked }))}
                      />
                    </td>
                    <td style={{ padding: '4px 8px' }}>{row.label}</td>
                    <td style={{ padding: '4px 8px', color: '#64748b' }}>{formatDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
