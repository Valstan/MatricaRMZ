import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  desktopAddFolder,
  desktopDeleteFolder,
  desktopEmptyTrash,
  desktopFolderShortcuts,
  desktopMoveToFolder,
  desktopMoveToTrash,
  desktopRenameFolder,
  desktopRenameShortcut,
  desktopRestoreFromTrash,
  desktopSurfaceShortcuts,
  desktopTrashShortcuts,
  type DesktopShortcut,
  type UserUiProfileDesktop,
} from '@matricarmz/shared';

import { theme } from '../theme.js';
import { useConfirm } from './ConfirmContext.js';

// MIME-тип DnD внутри рабочего стола: сторонние перетаскивания (файлы из
// проводника, текст) им не прикидываются и молча игнорируются.
const DND_SHORTCUT = 'application/x-matrica-desktop-shortcut';

type CtxMenu =
  | { kind: 'shortcut'; id: string; x: number; y: number; inTrash: boolean }
  | { kind: 'folder'; id: string; x: number; y: number }
  | { kind: 'trash'; x: number; y: number }
  | { kind: 'surface'; x: number; y: number };

/**
 * «Рабочий стол» — правая зона экрана «чат + рабочий стол» (этап 5 пакета
 * 2026-08-19б): ярлыки-ссылки, папки окном поверх, корзина в правом нижнем углу.
 * Всё состояние живёт снаружи (ключ `desktop` в ui_profile_json) — компонент
 * получает снимок и репортит изменения через onChange.
 */
export function DesktopPane(props: {
  desktop: UserUiProfileDesktop;
  onChange: (next: UserUiProfileDesktop) => void;
  /** Открыть ярлык (deep-link). Ярлык без link просто ничего не делает. */
  onOpenLink: (link: unknown) => void;
}) {
  const { confirm, promptText } = useConfirm();
  const { desktop, onChange } = props;

  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Контекстное меню закрывается любым кликом/Escape — как системное.
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  const openFolder = openFolderId ? desktop.folders.find((f) => f.id === openFolderId) ?? null : null;
  const surface = desktopSurfaceShortcuts(desktop);
  const trash = desktopTrashShortcuts(desktop);

  const menuPos = useCallback((e: React.MouseEvent) => {
    const rect = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }, []);

  function startDrag(e: React.DragEvent, shortcutId: string) {
    e.dataTransfer.setData(DND_SHORTCUT, shortcutId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function draggedId(e: React.DragEvent): string | null {
    const id = e.dataTransfer.getData(DND_SHORTCUT);
    return id || null;
  }

  function allowDrop(e: React.DragEvent, target: string) {
    if (!e.dataTransfer.types.includes(DND_SHORTCUT)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverTarget(target);
  }

  async function deleteFolderWithConfirm(folderId: string) {
    const folder = desktop.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const count = desktopFolderShortcuts(desktop, folderId).length;
    const ok = await confirm({
      title: 'Удалить папку?',
      detail:
        count > 0
          ? `Папка «${folder.name}» будет удалена, её ярлыки (${count}) переедут в корзину.`
          : `Папка «${folder.name}» пуста и будет удалена.`,
      confirmLabel: 'Удалить папку',
    });
    if (!ok) return;
    if (openFolderId === folderId) setOpenFolderId(null);
    onChange(desktopDeleteFolder(desktop, folderId, Date.now()));
  }

  async function emptyTrashWithConfirm() {
    if (trash.length === 0) return;
    const ok = await confirm({
      title: 'Очистить корзину?',
      detail: `Ярлыки в корзине (${trash.length}) будут удалены окончательно.`,
      confirmLabel: 'Очистить',
    });
    if (!ok) return;
    setTrashOpen(false);
    onChange(desktopEmptyTrash(desktop));
  }

  async function createFolder() {
    const name = await promptText({
      title: 'Новая папка',
      placeholder: 'Название папки',
      confirmLabel: 'Создать',
      validate: (v) => (v.trim() ? null : 'Введите название'),
    });
    if (!name || !name.trim()) return;
    onChange(desktopAddFolder(desktop, { id: crypto.randomUUID(), name: name.trim() }, Date.now()));
  }

  async function renameFolder(folderId: string) {
    const folder = desktop.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const name = await promptText({
      title: 'Переименовать папку',
      placeholder: folder.name,
      confirmLabel: 'Сохранить',
      validate: (v) => (v.trim() ? null : 'Введите название'),
    });
    if (!name || !name.trim()) return;
    onChange(desktopRenameFolder(desktop, folderId, name));
  }

  // Подпись ярлыка замораживается при создании (крошки раздела на тот момент) —
  // переименование единственный способ её поправить (этап B).
  async function renameShortcut(shortcutId: string) {
    const shortcut = desktop.shortcuts.find((x) => x.id === shortcutId);
    if (!shortcut) return;
    const label = await promptText({
      title: 'Переименовать ярлык',
      placeholder: shortcut.label,
      confirmLabel: 'Сохранить',
      validate: (v) => (v.trim() ? null : 'Введите название'),
    });
    if (!label || !label.trim()) return;
    onChange(desktopRenameShortcut(desktop, shortcutId, label));
  }

  function shortcutTile(s: DesktopShortcut, opts: { inTrash?: boolean } = {}) {
    return (
      <button
        key={s.id}
        type="button"
        draggable
        data-desktop-shortcut={s.id}
        onDragStart={(e) => startDrag(e, s.id)}
        onDragEnd={() => setDragOverTarget(null)}
        onDoubleClick={() => {
          if (s.link != null) props.onOpenLink(s.link);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ kind: 'shortcut', id: s.id, inTrash: opts.inTrash ?? false, ...menuPos(e) });
        }}
        title={s.link != null ? `${s.label} — двойной клик откроет раздел` : s.label}
        style={{
          width: 92,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          padding: '10px 4px',
          border: '1px solid transparent',
          borderRadius: 10,
          background: 'transparent',
          color: theme.colors.text,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 30, lineHeight: '34px' }} aria-hidden="true">
          {s.icon}
        </span>
        <span
          style={{
            fontSize: 11,
            lineHeight: '13px',
            textAlign: 'center',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            wordBreak: 'break-word',
          }}
        >
          {s.label}
        </span>
      </button>
    );
  }

  function folderTile(folderId: string, name: string) {
    const count = desktopFolderShortcuts(desktop, folderId).length;
    const hot = dragOverTarget === `folder:${folderId}`;
    return (
      <button
        key={folderId}
        type="button"
        data-desktop-folder={folderId}
        onDoubleClick={() => setOpenFolderId(folderId)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ kind: 'folder', id: folderId, ...menuPos(e) });
        }}
        onDragOver={(e) => allowDrop(e, `folder:${folderId}`)}
        onDragLeave={() => setDragOverTarget((t) => (t === `folder:${folderId}` ? null : t))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverTarget(null);
          const id = draggedId(e);
          if (id) onChange(desktopMoveToFolder(desktop, id, folderId));
        }}
        title={`${name} — двойной клик откроет папку`}
        style={{
          width: 92,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          padding: '10px 4px',
          border: `1px solid ${hot ? theme.colors.borderStrong : 'transparent'}`,
          borderRadius: 10,
          background: hot ? theme.colors.surface2 : 'transparent',
          color: theme.colors.text,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 30, lineHeight: '34px' }} aria-hidden="true">
          📁
        </span>
        <span style={{ fontSize: 11, lineHeight: '13px', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 84 }}>
          {name}
          {count > 0 ? ` (${count})` : ''}
        </span>
      </button>
    );
  }

  const trashHot = dragOverTarget === 'trash';
  const surfaceHot = dragOverTarget === 'surface';

  return (
    <div
      ref={rootRef}
      data-desktop-pane
      onContextMenu={(e) => {
        // ПКМ по свободному месту — меню поверхности («Создать папку»).
        e.preventDefault();
        setCtxMenu({ kind: 'surface', ...menuPos(e) });
      }}
      onDragOver={(e) => allowDrop(e, 'surface')}
      onDrop={(e) => {
        e.preventDefault();
        setDragOverTarget(null);
        const id = draggedId(e);
        if (!id) return;
        const s = desktop.shortcuts.find((x) => x.id === id);
        if (!s) return;
        // Дроп на свободное место: из корзины — восстановить, из папки — на стол.
        if (s.deletedAt != null) onChange(desktopRestoreFromTrash(desktop, id));
        else if (s.folderId != null) onChange(desktopMoveToFolder(desktop, id, null));
      }}
      style={{
        position: 'relative',
        height: '100%',
        minWidth: 0,
        overflow: 'hidden',
        background: surfaceHot ? theme.colors.surface2 : 'transparent',
      }}
    >
      {/* Плитки: папки первыми, затем ярлыки */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 4, padding: 12, height: '100%', overflowY: 'auto' }}>
        {desktop.folders.map((f) => folderTile(f.id, f.name))}
        {surface.map((s) => shortcutTile(s))}
        {desktop.folders.length === 0 && surface.length === 0 && (
          <div style={{ color: theme.colors.muted, fontSize: 13, padding: 16, maxWidth: 420 }}>
            Рабочий стол пуст. Кнопка «На рабочий стол» в МЕНЮ добавит сюда ярлык текущего раздела;
            ПКМ по свободному месту — создать папку.
          </div>
        )}
      </div>

      {/* Корзина — постоянный элемент, правый нижний угол */}
      <button
        type="button"
        data-desktop-trash
        onClick={() => setTrashOpen((v) => trash.length > 0 && !v)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setCtxMenu({ kind: 'trash', ...menuPos(e) });
        }}
        onDragOver={(e) => allowDrop(e, 'trash')}
        onDragLeave={() => setDragOverTarget((t) => (t === 'trash' ? null : t))}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverTarget(null);
          const id = draggedId(e);
          if (id) onChange(desktopMoveToTrash(desktop, id, Date.now()));
        }}
        title={trash.length > 0 ? `Корзина: ${trash.length}. Клик — показать содержимое, ПКМ — очистить.` : 'Корзина пуста. Перетащите сюда ярлык, чтобы удалить.'}
        style={{
          position: 'absolute',
          right: 16,
          bottom: 12,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          padding: '8px 12px',
          borderRadius: 10,
          border: `1px solid ${trashHot ? theme.colors.borderStrong : theme.colors.border}`,
          background: trashHot ? theme.colors.surface2 : theme.colors.surface,
          color: theme.colors.text,
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 26 }} aria-hidden="true">
          {trash.length > 0 ? '🗑️' : '🗑'}
        </span>
        <span style={{ fontSize: 11, color: theme.colors.muted }}>Корзина{trash.length > 0 ? ` (${trash.length})` : ''}</span>
      </button>

      {/* Содержимое корзины — всплывашка над кнопкой; ярлык можно утащить обратно на стол */}
      {trashOpen && trash.length > 0 && (
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 78,
            width: 320,
            maxHeight: '55%',
            overflowY: 'auto',
            border: `1px solid ${theme.colors.border}`,
            borderRadius: 12,
            background: theme.colors.surface,
            boxShadow: theme.colors.chatMenuShadow,
            padding: 8,
            zIndex: 5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 6px 8px' }}>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Корзина</span>
            <button
              type="button"
              onClick={() => setTrashOpen(false)}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: theme.colors.muted }}
              title="Закрыть"
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>{trash.map((s) => shortcutTile(s, { inTrash: true }))}</div>
          <div style={{ fontSize: 11, color: theme.colors.muted, padding: '6px 6px 2px' }}>
            Перетащите ярлык на стол, чтобы вернуть; ПКМ по корзине — очистить.
          </div>
        </div>
      )}

      {/* Окно папки поверх стола, ≈¾ зоны */}
      {openFolder && (
        <div
          data-desktop-folder-window
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.25)',
            zIndex: 6,
          }}
          onClick={() => setOpenFolderId(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              // Внутри окна папки меню поверхности стола не нужно.
              e.preventDefault();
              e.stopPropagation();
            }}
            style={{
              width: '75%',
              height: '75%',
              display: 'flex',
              flexDirection: 'column',
              border: `1px solid ${theme.colors.border}`,
              borderRadius: 14,
              background: theme.colors.surface,
              boxShadow: theme.colors.chatMenuShadow,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 14px',
                borderBottom: `1px solid ${theme.colors.border}`,
                background: theme.colors.surface2,
              }}
            >
              <span style={{ fontWeight: 700 }}>📁 {openFolder.name}</span>
              <button
                type="button"
                data-desktop-folder-close
                onClick={() => setOpenFolderId(null)}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, color: theme.colors.muted }}
                title="Закрыть папку"
              >
                ✕
              </button>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: 4, padding: 12 }}>
              {desktopFolderShortcuts(desktop, openFolder.id).map((s) => shortcutTile(s))}
              {desktopFolderShortcuts(desktop, openFolder.id).length === 0 && (
                <div style={{ color: theme.colors.muted, fontSize: 13, padding: 10 }}>
                  Папка пуста. Перетащите сюда ярлыки со стола.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Контекстное меню */}
      {ctxMenu && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute',
            left: Math.min(ctxMenu.x, (rootRef.current?.clientWidth ?? 400) - 220),
            top: Math.min(ctxMenu.y, (rootRef.current?.clientHeight ?? 300) - 140),
            minWidth: 200,
            border: `1px solid ${theme.colors.chatMenuBorder}`,
            borderRadius: 10,
            background: theme.colors.chatMenuBg,
            boxShadow: theme.colors.chatMenuShadow,
            padding: 4,
            zIndex: 10,
          }}
        >
          {ctxMenu.kind === 'surface' && (
            <CtxItem
              label="📁 Создать папку"
              onClick={() => {
                setCtxMenu(null);
                void createFolder();
              }}
            />
          )}
          {ctxMenu.kind === 'shortcut' && (
            <>
              {(() => {
                const s = desktop.shortcuts.find((x) => x.id === ctxMenu.id);
                return s?.link != null ? (
                  <CtxItem
                    label="↗ Открыть"
                    onClick={() => {
                      setCtxMenu(null);
                      props.onOpenLink(s.link);
                    }}
                  />
                ) : null;
              })()}
              {ctxMenu.inTrash ? (
                <CtxItem
                  label="↩ Вернуть на стол"
                  onClick={() => {
                    setCtxMenu(null);
                    onChange(desktopRestoreFromTrash(desktop, ctxMenu.id));
                  }}
                />
              ) : (
                <>
                  <CtxItem
                    label="✏️ Переименовать"
                    onClick={() => {
                      setCtxMenu(null);
                      void renameShortcut(ctxMenu.id);
                    }}
                  />
                  <CtxItem
                    label="🗑 Удалить (в корзину)"
                    onClick={() => {
                      setCtxMenu(null);
                      onChange(desktopMoveToTrash(desktop, ctxMenu.id, Date.now()));
                    }}
                  />
                </>
              )}
            </>
          )}
          {ctxMenu.kind === 'folder' && (
            <>
              <CtxItem
                label="↗ Открыть папку"
                onClick={() => {
                  setCtxMenu(null);
                  setOpenFolderId(ctxMenu.id);
                }}
              />
              <CtxItem
                label="✏️ Переименовать"
                onClick={() => {
                  setCtxMenu(null);
                  void renameFolder(ctxMenu.id);
                }}
              />
              <CtxItem
                label="🗑 Удалить папку"
                onClick={() => {
                  setCtxMenu(null);
                  void deleteFolderWithConfirm(ctxMenu.id);
                }}
              />
            </>
          )}
          {ctxMenu.kind === 'trash' && (
            <CtxItem
              label={trash.length > 0 ? `🧹 Очистить корзину (${trash.length})` : '🧹 Корзина пуста'}
              onClick={() => {
                setCtxMenu(null);
                void emptyTrashWithConfirm();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CtxItem(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        border: 'none',
        borderRadius: 8,
        background: 'transparent',
        color: theme.colors.text,
        fontSize: 13,
        cursor: 'pointer',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = theme.colors.surface2;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {props.label}
    </button>
  );
}
