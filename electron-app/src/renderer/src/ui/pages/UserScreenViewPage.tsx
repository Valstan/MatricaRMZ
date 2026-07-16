import React, { useEffect, useMemo, useState } from 'react';
import {
  MOCK_BLOCK_LABELS_RU,
  describeUiSpecForDeveloper,
  orderBlocksForReading,
  sanitizeUiSpec,
  type UiScreenDetails,
  type UiSpecV2,
} from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';
import { MockupCanvas } from '../uiBuilder/MockupCanvas.js';

/**
 * Просмотр эскиза оператора: read-only холст + нумерованные сноски с описаниями
 * («что должен делать каждый элемент») + экспорт текстового ТЗ для разработчика.
 */
export function UserScreenViewPage(props: { screenId: string; onEdit: (id: string) => void }) {
  const [screen, setScreen] = useState<UiScreenDetails | null>(null);
  const [spec, setSpec] = useState<UiSpecV2 | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await window.matrica.uiScreens.get(props.screenId);
      if (!alive) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setScreen(res.screen);
      setSpec(sanitizeUiSpec(res.screen.specJson));
      setError(null);
    })();
    return () => {
      alive = false;
    };
  }, [props.screenId]);

  const annotated = useMemo(() => {
    if (!spec) return [];
    return orderBlocksForReading(spec.blocks)
      .map((b, i) => ({ block: b, num: i + 1 }))
      .filter(({ block }) => block.note?.trim() || block.label?.trim());
  }, [spec]);

  async function copyDeveloperSpec() {
    if (!spec) return;
    try {
      await navigator.clipboard.writeText(describeUiSpecForDeveloper(spec, screen?.name));
      setToast('Описание для разработчика скопировано в буфер');
    } catch {
      setToast('Не удалось скопировать в буфер');
    }
    window.setTimeout(() => setToast(null), 3500);
  }

  if (error) return <div style={{ padding: 16, fontSize: 13, color: theme.colors.muted }}>{error}</div>;
  if (!screen || !spec) return <div style={{ padding: 16, fontSize: 13, color: theme.colors.muted }}>Загрузка…</div>;

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{screen.name}</div>
        <span style={{ fontSize: 12, color: theme.colors.muted }}>Эскиз — элементы не действуют, это набросок будущего модуля</span>
        <Button size="sm" variant={showAnnotations ? 'primary' : 'ghost'} onClick={() => setShowAnnotations((v) => !v)}>
          № Сноски
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyDeveloperSpec()}>
          📋 Описание для разработчика
        </Button>
        {screen.canEdit ? (
          <Button size="sm" variant="ghost" onClick={() => props.onEdit(screen.id)}>
            Редактировать
          </Button>
        ) : null}
        {toast ? <span style={{ fontSize: 13, color: theme.colors.muted }}>{toast}</span> : null}
      </div>
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0, minWidth: 0 }}>
          <MockupCanvas spec={spec} mode="view" showAnnotations={showAnnotations} />
        </div>
        {showAnnotations && annotated.length > 0 ? (
          <div style={{ flex: '0 0 300px', overflow: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Сноски</div>
            {annotated.map(({ block: b, num }) => (
              <div key={b.id} style={{ fontSize: 12, borderLeft: `2px solid ${theme.colors.border}`, paddingLeft: 8 }}>
                <div style={{ fontWeight: 600 }}>
                  {num}. {MOCK_BLOCK_LABELS_RU[b.kind]}
                  {b.label?.trim() ? ` «${b.label.trim()}»` : ''}
                </div>
                {b.note?.trim() ? <div style={{ color: theme.colors.muted, whiteSpace: 'pre-wrap' }}>{b.note.trim()}</div> : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default UserScreenViewPage;
