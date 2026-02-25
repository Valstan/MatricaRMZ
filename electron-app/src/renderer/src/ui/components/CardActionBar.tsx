import React from 'react';
import { Button } from './Button.js';

export type CardActionBarProps = {
  canEdit: boolean;
  onCopyToNew?: (() => void) | undefined;
  onSaveAndClose?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
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
      {props.onClose && (
        <Button variant="ghost" tone="neutral" title="Закрыть с выбором сохранения изменений" onClick={props.onClose}>
          Закрыть карточку
        </Button>
      )}
      {props.canEdit && props.onSaveAndClose && (
        <Button variant="ghost" tone="success" title="Сохранить изменения и закрыть карточку" onClick={props.onSaveAndClose}>
          Сохранить и выйти
        </Button>
      )}
      {props.canEdit && props.onReset && (
        <Button variant="ghost" title="Сбросить внесенные изменения" onClick={props.onReset}>
          Сброс
        </Button>
      )}
      {props.onCloseWithoutSave && (
        <Button variant="ghost" title="Сбросить изменения и закрыть" onClick={props.onCloseWithoutSave}>
          Выйти без сохранения
        </Button>
      )}
      {props.canEdit && props.onDelete && (
        <Button variant="ghost" tone="danger" title="Удалить карточку" onClick={props.onDelete}>
          Удалить карточку
        </Button>
      )}
      {props.canEdit && props.onCopyToNew && (
        <Button variant="ghost" title="Создать новую карточку с этими же данными" onClick={props.onCopyToNew}>
          Скопировать в новую карточку
        </Button>
      )}
    </div>
  );
}
