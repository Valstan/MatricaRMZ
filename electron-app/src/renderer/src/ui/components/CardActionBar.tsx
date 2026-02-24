import React from 'react';
import { Button } from './Button.js';

export type CardActionBarProps = {
  canEdit: boolean;
  onCopyToNew?: (() => void) | undefined;
  onSaveAndClose?: (() => void) | undefined;
  onCloseWithoutSave?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
};

export function CardActionBar(props: CardActionBarProps) {
  return (
    <div
      className="card-action-bar"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 8,
        background: 'var(--surface)',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '6px 0',
      }}
    >
      {props.canEdit && props.onCopyToNew && (
        <Button variant="ghost" onClick={props.onCopyToNew}>
          Скопировать в новую карточку
        </Button>
      )}
      {props.canEdit && props.onSaveAndClose && (
        <Button variant="ghost" tone="success" onClick={props.onSaveAndClose}>
          Сохранить и выйти
        </Button>
      )}
      {props.onCloseWithoutSave && (
        <Button variant="ghost" onClick={props.onCloseWithoutSave}>
          Выйти без сохранения
        </Button>
      )}
      {props.canEdit && props.onDelete && (
        <Button variant="ghost" tone="danger" onClick={props.onDelete}>
          Удалить карточку
        </Button>
      )}
      {props.onClose && (
        <Button variant="ghost" tone="neutral" onClick={props.onClose}>
          Закрыть карточку
        </Button>
      )}
    </div>
  );
}
