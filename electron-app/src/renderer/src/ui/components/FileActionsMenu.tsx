import React, { useEffect } from 'react';

import { PopupLayer } from './PopupLayer.js';

// ДЕЙСТВИЯ НАД ОТМЕЧЕННЫМИ ФАЙЛАМИ — один набор на все точки включения.
//
// Где включается:
//   * выдача «Поиска по файлам» (локальные файлы оператора) — `FileSearchPage.tsx`;
//   * панель вложений карточки (серверные вложения) — по заявке владельца
//     от 25.11.2026 «Контекстное меню над файлами: почта, печать, ИИ, коллега»
//     (отдельная нить; набор и компонент — эти же).
//
// Почему один список, а не два: набор действий — это продуктовое решение, и две
// копии разъезжаются (в одной появится «отправить», в другой забудут). Различаются
// точки включения не составом, а тем, что действие умеет: поэтому у каждого пункта
// есть проверка `available`, а недоступное в меню НЕ показывается (правило промта
// КАРМАНА #158: «пункт, который на этой машине не сработает, в меню не показывается»).
//
// Пункт «удалить файл» здесь есть не может: программа не удаляет файлы оператора.

export type FileActionId =
  | 'print'
  | 'printWizard'
  | 'pdf'
  | 'mail'
  | 'colleague'
  | 'chat'
  | 'openFolder'
  | 'desktop'
  | 'copyPath';

export type FileActionDef = {
  id: FileActionId;
  label: string;
  icon: string;
  /** Что действие делает — одной строкой, для подсказки. */
  hint: string;
};

/** Набор действий над отмеченными файлами. */
export const FILE_ACTIONS: FileActionDef[] = [
  {
    id: 'print',
    label: 'Печать',
    icon: '🖨',
    hint: 'Системный диалог печати, все отмеченные сразу',
  },
  {
    id: 'printWizard',
    label: 'Через мастер печати фотографий',
    icon: '🖼',
    hint: 'Одно системное окно: оператор правит размер и раскладку всех снимков',
  },
  {
    id: 'pdf',
    label: 'Собрать PDF одним файлом',
    icon: '📄',
    hint: 'Сохранить PDF с фотографиями и открыть его',
  },
  {
    id: 'mail',
    label: 'Отправить на почту',
    icon: '✉️',
    hint: 'Открыть почтовый клиент; файлы прикрепляются вручную из папки',
  },
  {
    id: 'colleague',
    label: 'Отправить коллеге',
    icon: '📤',
    hint: 'Файл ляжет у коллеги на Верстаке после подтверждения',
  },
  {
    id: 'chat',
    label: 'В личные сообщения чата',
    icon: '💬',
    hint: 'Отправить файлом в переписку с коллегой',
  },
  {
    id: 'openFolder',
    label: 'Открыть папку с файлами',
    icon: '📂',
    hint: 'Показать папку на диске, где лежат отмеченные файлы',
  },
  {
    id: 'desktop',
    label: 'Положить на верстак',
    icon: '🧱',
    hint: 'Ярлыки файлов появятся на Верстаке',
  },
  {
    id: 'copyPath',
    label: 'Скопировать путь',
    icon: '📋',
    hint: 'Путь(и) к отмеченным файлам — в буфер обмена',
  },
];

/** Пункт меню по id — чтобы не искать в списке. */
export function fileActionDef(id: FileActionId): FileActionDef {
  const found = FILE_ACTIONS.find((a) => a.id === id);
  if (!found) throw new Error(`нет действия ${id}`);
  return found;
}

export type FileActionsMenuProps = {
  open: boolean;
  /** Точка меню в координатах окна (обычно — под курсором). */
  at: { x: number; y: number } | null;
  /** Сколько файлов отмечено — показываем в шапке меню. */
  count: number;
  /** Какое действие на этой машине доступно. Недоступные в меню не показываются. */
  available?: (id: FileActionId) => boolean;
  onAction: (id: FileActionId) => void;
  onClose: () => void;
};

/**
 * Меню действий над отмеченными файлами.
 *
 * Живёт в портале (`PopupLayer`): правило проекта — всплывающее меню заводится
 * ТОЛЬКО через портал (гейт `components/popupLayer.guard.test.ts`), иначе меню
 * уезжает под контекст наложения предка и оператор его не видит.
 */
export function FileActionsMenu(props: FileActionsMenuProps) {
  const { open, at, count, onAction, onClose } = props;
  const available = props.available ?? (() => true);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onPointerDown = (e: PointerEvent) => {
      const node = e.target as HTMLElement | null;
      if (node?.closest?.('[data-file-actions-menu]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onClose]);

  if (!open || !at) return null;

  const items = FILE_ACTIONS.filter((a) => available(a.id));
  if (items.length === 0) return null;

  const width = 320;
  const left = Math.max(8, Math.min(at.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(at.y, window.innerHeight - 8 - items.length * 34 - 44));

  return (
    <PopupLayer>
      <div
        data-file-actions-menu
        role="menu"
        style={{
          position: 'fixed',
          left,
          top,
          width,
          padding: '6px 0',
          border: '1px solid var(--border)',
          borderRadius: 12,
          background: 'var(--surface)',
          boxShadow: 'var(--shadow-md, 0 10px 30px rgba(2, 6, 23, 0.25))',
        }}
      >
        <div
          style={{
            padding: '6px 12px 8px',
            fontSize: 12,
            color: 'var(--muted)',
            borderBottom: '1px solid var(--border)',
            marginBottom: 4,
          }}
        >
          Отмечено файлов: {count}
        </div>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            data-file-action={item.id}
            title={item.hint}
            onClick={() => {
              onClose();
              onAction(item.id);
            }}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              padding: '7px 12px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              font: 'inherit',
              fontSize: 13,
              color: 'var(--text, inherit)',
            }}
          >
            <span style={{ marginRight: 8 }}>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </div>
    </PopupLayer>
  );
}
