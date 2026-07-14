import React from 'react';
import type { UiBlock, UiSpecV1 } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { theme } from '../theme.js';
import type { UiIntentRuntime } from './intentRuntime.js';
import { UiListWidget } from './widgets.js';

function BlockView(props: { block: UiBlock; runtime: UiIntentRuntime }) {
  const { block, runtime } = props;
  switch (block.kind) {
    case 'heading':
      return <h2 style={{ margin: '4px 0', fontSize: 20 }}>{block.text}</h2>;
    case 'text':
      return <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{block.text}</div>;
    case 'button': {
      const enabled = runtime.canRunIntent(block.intent);
      const hint = runtime.intentHint(block.intent);
      return (
        <span title={hint ?? undefined} style={{ alignSelf: 'flex-start' }}>
          <Button disabled={!enabled} onClick={() => runtime.runIntent(block.intent)}>
            {block.label}
          </Button>
        </span>
      );
    }
    case 'list':
      return <UiListWidget widget={block.widget} runtime={runtime} {...(block.limit != null ? { limit: block.limit } : {})} />;
  }
}

/** Pure JSON-spec → design-system components. All behavior goes through the runtime. */
export function SpecRenderer(props: { spec: UiSpecV1; runtime: UiIntentRuntime }) {
  if (props.spec.blocks.length === 0) {
    return <div style={{ color: theme.colors.muted, fontSize: 13, padding: 8 }}>Экран пуст — добавьте блоки.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 760 }}>
      {props.spec.blocks.map((b) => (
        <BlockView key={b.id} block={b} runtime={props.runtime} />
      ))}
    </div>
  );
}
