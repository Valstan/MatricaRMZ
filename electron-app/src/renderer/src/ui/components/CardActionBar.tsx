import React from 'react';
import { Button } from './Button.js';

export type CardActionBarProps = {
  canEdit: boolean;
  onCopyToNew?: (() => void) | undefined;
  onSaveAndClose?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
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
        padding: '6px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          width: '100%',
          gap: 6,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 6, flex: 1 }}>
          {props.canEdit && props.onCopyToNew && (
            <Button variant="ghost" title="Создать новую карточку с этими же данными" onClick={props.onCopyToNew}>
              Скопировать в новую карточку
            </Button>
          )}
          {props.canEdit && props.onSaveAndClose && (
            <Button variant="ghost" tone="success" title="Сохранить изменения и закрыть карточку" onClick={props.onSaveAndClose}>
              Сохранить и выйти
            </Button>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            flex: 1,
            flexWrap: 'wrap',
          }}
        >
          {props.canEdit && props.onReset && (
            <Button variant="ghost" title="Сбросить внесенные изменения" onClick={props.onReset}>
              Сброс
            </Button>
          )}
          {props.onClose && (
            <Button variant="ghost" tone="neutral" title="Закрыть с выбором сохранения изменений" onClick={props.onClose}>
              Закрыть карточку
            </Button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flex: 1 }}>
          {props.canEdit && props.onDelete && (
            <Button variant="ghost" tone="danger" title="Удалить карточку" onClick={props.onDelete}>
              Удалить карточку
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
