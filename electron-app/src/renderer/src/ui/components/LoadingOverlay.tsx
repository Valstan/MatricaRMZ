import React from 'react';

/**
 * Крутящийся индикатор загрузки (этап 5 плана tabs-window-shell): показывается,
 * пока объект (список/карточка/операция с файлом) не загружен целиком; оверлей
 * перехватывает клики — редактировать до конца загрузки нельзя.
 * CSS (.mx-spinner / .mx-loading-overlay) — в global.css.
 */
export function Spinner(props: { size?: number }) {
  const s = props.size ?? 28;
  return <span className="mx-spinner" style={{ width: s, height: s }} aria-hidden="true" />;
}

export function LoadingOverlay(props: { active: boolean; label?: string; children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative' }} aria-busy={props.active || undefined}>
      {props.children}
      {props.active && (
        <div className="mx-loading-overlay" role="status">
          <Spinner size={36} />
          {props.label ? <div className="mx-loading-overlay-label">{props.label}</div> : null}
        </div>
      )}
    </div>
  );
}
