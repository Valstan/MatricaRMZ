import React, { useEffect, useRef } from 'react';
import { Button } from './Button.js';
import { useConfirm } from './ConfirmContext.js';
import { isAndroidPlatform } from '../platform.js';

export type CardActionBarProps = {
  canEdit: boolean;
  cardLabel?: string | undefined;
  onCopyToNew?: (() => void) | undefined;
  onSave?: (() => void) | undefined;
  onSaveAndClose?: (() => void) | undefined;
  /** Phase 3c: park the card as an explicit draft (no commit to the document flow). Present only
   * on cards that support drafts; the button is hidden when the handler is absent. */
  onSaveAsDraft?: (() => void) | undefined;
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
  // Панель действий закреплена сверху, и вкладки карточки встают ПОД ней — иначе они
  // уезжали бы под неё и пропадали бы у оператора с глаз (владелец 01.11.2026).
  // Высота панели измеряется и кладётся в CSS-переменную на общем родителе: шапка
  // таблицы деталей тоже должна липнуть под панелью и вкладками, а не поверх них.
  const barRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = barRef.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      parent.style.setProperty('--card-action-bar-h', `${h}px`);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      parent.style.removeProperty('--card-action-bar-h');
    };
  }, []);

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
      ref={barRef}
      className="card-action-bar"
      data-card-action-bar="1"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 8,
        background: 'var(--surface)',
        padding: '6px 0',
      }}
    >
      <div className="card-action-bar__row">
        <div className="card-action-bar__group card-action-bar__group--left">
          {props.cardLabel && (
            <span
              className="card-action-bar__label"
              style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', whiteSpace: 'nowrap', marginRight: 6 }}
            >
              {props.cardLabel}
            </span>
          )}
          {props.canEdit && props.onCopyToNew && (
            <Button variant="ghost" title="Создать новую карточку с этими же данными" onClick={props.onCopyToNew}>
              <span className="card-action-bar__label-full">Скопировать в новую карточку</span>
              <span className="card-action-bar__label-short">Скопировать</span>
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
          {props.canEdit && props.onSaveAsDraft && (
            <Button variant="ghost" title="Отложить как черновик — без проведения в документооборот; найти можно в разделе «Черновики»" onClick={props.onSaveAsDraft}>
              <span className="card-action-bar__label-full">Сохранить как черновик</span>
              <span className="card-action-bar__label-short">В черновик</span>
            </Button>
          )}
          {props.extraActionsLeft}
        </div>
        <div
          className="card-action-bar__group card-action-bar__group--center"
          style={{
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
          {props.onPrint && !isAndroidPlatform() && (
            <Button variant="ghost" tone="info" title="Распечатать карточку" onClick={props.onPrint}>
              Распечатать
            </Button>
          )}
          {props.onClose && (
            <Button variant="ghost" tone="neutral" title="Закрыть с выбором сохранения изменений" onClick={props.onClose}>
              <span className="card-action-bar__label-full">Закрыть карточку</span>
              <span className="card-action-bar__label-short">Закрыть</span>
            </Button>
          )}
        </div>
        <div className="card-action-bar__group card-action-bar__group--right">
          {props.canEdit && props.onDelete && (
            <Button variant="ghost" tone="danger" title="Удалить карточку" onClick={() => void handleDeleteClick()}>
              {props.deleteLabel ? (
                props.deleteLabel
              ) : (
                <>
                  <span className="card-action-bar__label-full">Удалить карточку</span>
                  <span className="card-action-bar__label-short">Удалить</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
