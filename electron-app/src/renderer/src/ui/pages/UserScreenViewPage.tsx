import React, { useEffect, useState } from 'react';
import { sanitizeUiSpec, type UiScreenDetails, type UiSpecV1 } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';
import { SpecRenderer } from '../uiBuilder/SpecRenderer.js';
import type { UiIntentRuntime } from '../uiBuilder/intentRuntime.js';

/** Просмотр сохранённого экрана оператора: spec_json → SpecRenderer с боевым runtime. */
export function UserScreenViewPage(props: {
  screenId: string;
  runtime: UiIntentRuntime;
  onEdit: (id: string) => void;
}) {
  const [screen, setScreen] = useState<UiScreenDetails | null>(null);
  const [spec, setSpec] = useState<UiSpecV1 | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <div style={{ padding: 16, fontSize: 13, color: theme.colors.muted }}>{error}</div>;
  if (!screen || !spec) return <div style={{ padding: 16, fontSize: 13, color: theme.colors.muted }}>Загрузка…</div>;

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{screen.name}</div>
        {screen.canEdit ? (
          <Button size="sm" variant="ghost" onClick={() => props.onEdit(screen.id)}>
            Редактировать
          </Button>
        ) : null}
      </div>
      <SpecRenderer spec={spec} runtime={props.runtime} />
    </div>
  );
}

export default UserScreenViewPage;
