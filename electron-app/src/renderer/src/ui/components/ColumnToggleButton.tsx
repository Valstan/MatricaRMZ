import React from 'react';

import { isAndroidPlatform } from '../platform.js';

/**
 * The «×» that hides a column straight from its header. On a tablet it is always visible
 * (there is no hover to reveal it); on desktop `.list-col-hide` keeps it transparent until
 * the header is hovered, so the row of titles stays clean until someone reaches for it.
 * Bringing a column back is the panel's job — a hidden column leaves no cell behind, or the
 * header would drift out of step with the body.
 */
export function ColumnToggleButton(props: {
  colId: string;
  visible: boolean;
  alwaysVisible?: boolean | undefined;
  onToggle: () => void;
}) {
  if (props.alwaysVisible) return null;
  return (
    <button
      type="button"
      className={isAndroidPlatform() ? 'list-col-hide list-col-hide-touch' : 'list-col-hide'}
      onClick={(e) => {
        e.stopPropagation();
        props.onToggle();
      }}
      title="Скрыть колонку (вернуть — кнопкой «Колонки»)"
      aria-label="Скрыть колонку"
    >
      ×
    </button>
  );
}
