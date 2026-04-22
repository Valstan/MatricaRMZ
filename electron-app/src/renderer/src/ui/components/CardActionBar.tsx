import React from 'react';
import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';

export type CardActionBarProps = {
  canEdit: boolean;
  cardLabel?: string | undefined;
  onCopyToNew?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  onSaveAndClose?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
  onPrint?: (() => void) | undefined;
  onDelete?: (() => void) | undefined;
  deleteLabel?: string | undefined;
  /** Текст: что именно будет удалено (модальное окно). Если не задан — общая формулировка. */
  deleteConfirmDetail?: string | undefined;
  /** Не показывать встроенное подтверждение (родитель открывает свой диалог). */
  deleteSkipBuiltInConfirm?: boolean | undefined;
  onClose?: (() => void) | undefined;
  extraActionsLeft?: React.ReactNode | undefined;
  extraActionsCenter?: React.ReactNode | undefined;
  /** Одна строка для центральной группы (без переноса); при нехватке места — горизонтальная прокрутка. */
  centerNoWrap?: boolean | undefined;
};

export function CardActionBar(props: CardActionBarProps) {
  const { confirm } = useConfirm();

  async function handleDeleteClick() {
    if (!props.onDelete) return;
    if (props.deleteSkipBuiltInConfirm) {
      props.onDelete();
      return;
    }
    const actionLabel = (props.deleteLabel || 'Удалить карточку').replace(/\s+$/, '');
    const detail =
      props.deleteConfirmDetail?.trim() ||
      `${actionLabel}.\n\nБудет удалена открытая карточка${props.cardLabel ? ` (${props.cardLabel})` : ''}. Обычно это действие нельзя отменить.`;
    const ok = await confirm({ detail });
    if (ok) props.onDelete();
  }

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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8, flex: '0 0 auto' }}>
          {props.cardLabel && (
            <span style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap', marginRight: 6 }}>
              {props.cardLabel}
            </span>
          )}
          {props.canEdit && props.onCopyToNew && (
            <Button variant="ghost" title="Создать новую карточку с этими же данными" onClick={props.onCopyToNew}>
              Скопировать в новую карточку
            </Button>
          )}
          {props.canEdit && props.onSave && (
            <Button variant="ghost" tone="success" title="Сохранить изменения" onClick={props.onSave}>
              Сохранить
            </Button>
          )}
          {props.canEdit && props.onSaveAndClose && (
            <Button variant="ghost" tone="success" title="Сохранить изменения и закрыть карточку" onClick={props.onSaveAndClose}>
              Сохранить и выйти
            </Button>
          )}
          {props.extraActionsLeft}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            flex: 1,
            flexWrap: props.centerNoWrap ? 'nowrap' : 'wrap',
            overflowX: props.centerNoWrap ? 'auto' : undefined,
            minWidth: props.centerNoWrap ? 0 : undefined,
          }}
        >
          {props.canEdit && props.onReset && (
            <Button variant="ghost" title="Сбросить внесенные изменения" onClick={props.onReset}>
              Сброс
            </Button>
          )}
          {props.extraActionsCenter}
          {props.onPrint && (
            <Button variant="ghost" tone="info" title="Распечатать карточку" onClick={props.onPrint}>
              Распечатать
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
            <Button variant="ghost" tone="danger" title="Удалить карточку" onClick={() => void handleDeleteClick()}>
              {props.deleteLabel || 'Удалить карточку'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
