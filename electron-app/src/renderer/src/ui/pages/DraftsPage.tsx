import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { useConfirm } from '../components/ConfirmContext.js';

// Раздел «Черновики» (Phase 3c). Персистентный список несохранённых снимков оператора
// из card_drafts (owner-private, синкается между ПК) — и автосохранённых (recovery), и
// явных (explicit). Открыть → переход в карточку (draft-aware загрузка восстанавливает
// снимок); Удалить → soft-delete через синк. Опора: 3b (drafts.list/get/clear).

type DraftRow = {
  id: string;
  cardType: string;
  cardId: string;
  kind: 'recovery' | 'explicit';
  title: string | null;
  updatedAt: number;
};

const CARD_TYPE_LABELS: Record<string, string> = {
  work_order: 'Наряд',
};

function cardTypeLabel(cardType: string): string {
  return CARD_TYPE_LABELS[cardType] ?? cardType;
}

function formatDateTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '—';
  try {
    return new Date(ms).toLocaleString('ru-RU');
  } catch {
    return '—';
  }
}

export function DraftsPage(props: { onOpenWorkOrder: (id: string) => void | Promise<void> }) {
  const { confirm } = useConfirm();
  const [drafts, setDrafts] = useState<DraftRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const r = await window.matrica.drafts.list();
      if (!r?.ok) {
        setError(String((r as { error?: string })?.error ?? 'не удалось загрузить черновики'));
        setDrafts(null);
        return;
      }
      setDrafts(
        r.drafts.map((d) => ({ id: d.id, cardType: d.cardType, cardId: d.cardId, kind: d.kind, title: d.title, updatedAt: d.updatedAt })),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openDraft = useCallback(
    (d: DraftRow) => {
      if (d.cardType === 'work_order') void props.onOpenWorkOrder(d.cardId);
    },
    [props],
  );

  const deleteDraft = useCallback(
    async (d: DraftRow) => {
      const ok = await confirm({
        title: 'Удалить черновик?',
        detail: `Черновик «${d.title?.trim() || cardTypeLabel(d.cardType)}» будет удалён без восстановления. Сама сохранённая карточка (если есть) не затрагивается.`,
        confirmLabel: 'Удалить',
      });
      if (!ok) return;
      setBusy(true);
      setError('');
      try {
        const r = await window.matrica.drafts.clear({ id: d.id });
        if (!r?.ok) {
          setError(String((r as { error?: string })?.error ?? 'не удалось удалить'));
          return;
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [confirm, load],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>Черновики</h2>
        <Button onClick={() => void load()} disabled={busy}>
          {busy ? 'Загрузка…' : 'Обновить'}
        </Button>
        {drafts !== null && <span style={{ color: '#64748b', fontSize: 13 }}>всего: {drafts.length}</span>}
      </div>

      <div style={{ color: '#64748b', fontSize: 13, maxWidth: 900 }}>
        Несохранённые изменения ваших карточек — автосохранённые снимки (после сбоя или закрытия без сохранения) и
        отложенные черновики. «Открыть» вернёт вас в карточку с восстановленными изменениями; «Сохранить» в самой
        карточке зафиксирует их, после чего черновик исчезнет. Черновики приватны и следуют за вами между компьютерами.
      </div>

      {error && <div style={{ color: '#b91c1c' }}>{error}</div>}

      {drafts !== null && drafts.length === 0 && <div style={{ color: '#16a34a' }}>Черновиков нет 🎉</div>}

      {drafts !== null && drafts.length > 0 && (
        <table style={{ borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: '#64748b', textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>Карточка</th>
              <th style={{ padding: '6px 8px' }}>Тип</th>
              <th style={{ padding: '6px 8px' }}>Вид</th>
              <th style={{ padding: '6px 8px' }}>Изменён</th>
              <th style={{ padding: '6px 8px' }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => (
              <tr key={d.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                <td style={{ padding: '6px 8px' }}>{d.title?.trim() || `${cardTypeLabel(d.cardType)} ${d.cardId.slice(0, 8)}…`}</td>
                <td style={{ padding: '6px 8px', color: '#64748b' }}>{cardTypeLabel(d.cardType)}</td>
                <td style={{ padding: '6px 8px', color: '#64748b' }}>{d.kind === 'explicit' ? 'Черновик' : 'Автосохранение'}</td>
                <td style={{ padding: '6px 8px', color: '#64748b' }}>{formatDateTime(d.updatedAt)}</td>
                <td style={{ padding: '6px 8px', display: 'flex', gap: 6 }}>
                  <Button variant="ghost" tone="success" onClick={() => openDraft(d)} disabled={d.cardType !== 'work_order'}>
                    Открыть
                  </Button>
                  <Button variant="ghost" tone="danger" onClick={() => void deleteDraft(d)} disabled={busy}>
                    Удалить
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
