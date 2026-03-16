import React from 'react';

import { Button } from './Button.js';

export function RowReorderButtons(props: {
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  stopPropagation?: boolean;
}) {
  const handleClick =
    (action: () => void) =>
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (props.stopPropagation) event.stopPropagation();
      action();
    };

  return (
    <div style={{ display: 'inline-flex', gap: 4 }}>
      <Button type="button" variant="ghost" size="sm" disabled={!props.canMoveUp} title="Поднять строку выше" onClick={handleClick(props.onMoveUp)}>
        ↑
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={!props.canMoveDown} title="Опустить строку ниже" onClick={handleClick(props.onMoveDown)}>
        ↓
      </Button>
    </div>
  );
}
