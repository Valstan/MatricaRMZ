// «Рабочий стол» — стартовый экран после входа (этап 5 пакета владельца 2026-08-19б):
// ярлыки-ссылки на разделы/карточки, папки, корзина и раскладка сплитов экрана
// «чат + рабочий стол». Хранится ключом `desktop` в employee.ui_profile_json
// (per-key LWW из v3.5.0) — стол едет за пользователем между машинами.

export type DesktopShortcut = {
  id: string;
  /** Подпись плитки — обычно хлебные крошки раздела на момент создания. */
  label: string;
  /** Эмодзи-иконка плитки (из TAB_SHORTCUT_META или дефолт). */
  icon: string;
  /**
   * ChatDeepLinkPayload как есть. Валидируется только «объект разумного размера»
   * (как recentVisits.link): ярлык на раздел, которого нет в ЭТОЙ версии клиента,
   * храним и не рендерим — id-чурн релизов не должен стирать чужой рабочий стол.
   */
  link?: unknown;
  /** null — лежит на столе; иначе id папки. Ярлык с несуществующей папкой рендерится на столе. */
  folderId: string | null;
  /** null — живой; иначе момент удаления: ярлык лежит в корзине, откуда его можно вернуть. */
  deletedAt: number | null;
  createdAt: number;
};

export type DesktopFolder = {
  id: string;
  name: string;
  createdAt: number;
};

export type DesktopLayout = {
  /** Ширина зоны чата в процентах экрана «Рабочий стол» (владельческий дефолт — треть). */
  chatPct: number;
  /** Ширина колонки собеседников в процентах зоны чата. */
  peoplePct: number;
};

export type UserUiProfileDesktop = {
  shortcuts: DesktopShortcut[];
  folders: DesktopFolder[];
  layout: DesktopLayout;
};

export const DESKTOP_DEFAULT_LAYOUT: DesktopLayout = { chatPct: 33, peoplePct: 30 };

export const DESKTOP_MAX_SHORTCUTS = 200;
export const DESKTOP_MAX_FOLDERS = 40;
const MAX_LABEL = 160;
const MAX_LINK_JSON = 4000;

export function createEmptyDesktop(): UserUiProfileDesktop {
  return { shortcuts: [], folders: [], layout: { ...DESKTOP_DEFAULT_LAYOUT } };
}

function clampPct(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(85, Math.max(10, n)) : fallback;
}

function sanitizeShortcut(raw: unknown): DesktopShortcut | null {
  if (typeof raw !== 'object' || raw == null) return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim().slice(0, 80);
  const label = String(r.label ?? '').trim().slice(0, MAX_LABEL);
  if (!id || !label) return null;
  const createdAt = Number(r.createdAt ?? 0);
  const deletedAt = Number(r.deletedAt ?? NaN);
  const out: DesktopShortcut = {
    id,
    label,
    icon: String(r.icon ?? '').trim().slice(0, 8) || '🔗',
    folderId: typeof r.folderId === 'string' && r.folderId.trim() ? r.folderId.trim().slice(0, 80) : null,
    deletedAt: Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : null,
    createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0,
  };
  if (typeof r.link === 'object' && r.link != null) {
    try {
      if (JSON.stringify(r.link).length <= MAX_LINK_JSON) out.link = r.link;
    } catch {
      // несериализуемый link — ярлык остаётся, ссылка отбрасывается
    }
  }
  return out;
}

function sanitizeFolder(raw: unknown): DesktopFolder | null {
  if (typeof raw !== 'object' || raw == null) return null;
  const r = raw as Record<string, unknown>;
  const id = String(r.id ?? '').trim().slice(0, 80);
  const name = String(r.name ?? '').trim().slice(0, MAX_LABEL);
  if (!id || !name) return null;
  const createdAt = Number(r.createdAt ?? 0);
  return { id, name, createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : 0 };
}

/** Секция `desktop` профиля: undefined — секции в PATCH нет (не трогать). */
export function sanitizeDesktopSection(raw: unknown): UserUiProfileDesktop | undefined {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const shortcuts: DesktopShortcut[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.shortcuts)) {
    for (const item of r.shortcuts.slice(0, DESKTOP_MAX_SHORTCUTS)) {
      const s = sanitizeShortcut(item);
      if (s && !seen.has(s.id)) {
        seen.add(s.id);
        shortcuts.push(s);
      }
    }
  }
  const folders: DesktopFolder[] = [];
  const seenFolders = new Set<string>();
  if (Array.isArray(r.folders)) {
    for (const item of r.folders.slice(0, DESKTOP_MAX_FOLDERS)) {
      const f = sanitizeFolder(item);
      if (f && !seenFolders.has(f.id)) {
        seenFolders.add(f.id);
        folders.push(f);
      }
    }
  }
  const layoutRaw = (typeof r.layout === 'object' && r.layout != null ? r.layout : {}) as Record<string, unknown>;
  return {
    shortcuts,
    folders,
    layout: {
      chatPct: clampPct(layoutRaw.chatPct, DESKTOP_DEFAULT_LAYOUT.chatPct),
      peoplePct: clampPct(layoutRaw.peoplePct, DESKTOP_DEFAULT_LAYOUT.peoplePct),
    },
  };
}

/** Живые ярлыки на самом столе (не в папке, не в корзине). */
export function desktopSurfaceShortcuts(d: UserUiProfileDesktop): DesktopShortcut[] {
  const folderIds = new Set(d.folders.map((f) => f.id));
  return d.shortcuts.filter((s) => s.deletedAt == null && (s.folderId == null || !folderIds.has(s.folderId)));
}

/** Живые ярлыки внутри папки. */
export function desktopFolderShortcuts(d: UserUiProfileDesktop, folderId: string): DesktopShortcut[] {
  return d.shortcuts.filter((s) => s.deletedAt == null && s.folderId === folderId);
}

/** Содержимое корзины. */
export function desktopTrashShortcuts(d: UserUiProfileDesktop): DesktopShortcut[] {
  return d.shortcuts.filter((s) => s.deletedAt != null);
}

/** Ярлык — в корзину (из стола или папки). */
export function desktopMoveToTrash(d: UserUiProfileDesktop, shortcutId: string, now: number): UserUiProfileDesktop {
  return {
    ...d,
    shortcuts: d.shortcuts.map((s) => (s.id === shortcutId ? { ...s, deletedAt: now, folderId: null } : s)),
  };
}

/** Вернуть ярлык из корзины на стол. */
export function desktopRestoreFromTrash(d: UserUiProfileDesktop, shortcutId: string): UserUiProfileDesktop {
  return {
    ...d,
    shortcuts: d.shortcuts.map((s) => (s.id === shortcutId ? { ...s, deletedAt: null, folderId: null } : s)),
  };
}

/** Очистить корзину — окончательное удаление содержимого. */
export function desktopEmptyTrash(d: UserUiProfileDesktop): UserUiProfileDesktop {
  return { ...d, shortcuts: d.shortcuts.filter((s) => s.deletedAt == null) };
}

/** Переложить ярлык в папку (folderId=null — на стол). */
export function desktopMoveToFolder(d: UserUiProfileDesktop, shortcutId: string, folderId: string | null): UserUiProfileDesktop {
  return {
    ...d,
    shortcuts: d.shortcuts.map((s) => (s.id === shortcutId ? { ...s, folderId, deletedAt: null } : s)),
  };
}

/**
 * Удалить папку: содержимое уезжает в корзину (не стирается), сама папка исчезает —
 * поведение по решению владельца (этап 5 п.5).
 */
export function desktopDeleteFolder(d: UserUiProfileDesktop, folderId: string, now: number): UserUiProfileDesktop {
  return {
    ...d,
    folders: d.folders.filter((f) => f.id !== folderId),
    shortcuts: d.shortcuts.map((s) =>
      s.folderId === folderId && s.deletedAt == null ? { ...s, folderId: null, deletedAt: now } : s,
    ),
  };
}

/** Добавить ярлык на стол (id генерирует вызывающий — crypto.randomUUID в renderer). */
export function desktopAddShortcut(
  d: UserUiProfileDesktop,
  shortcut: { id: string; label: string; icon: string; link?: unknown },
  now: number,
): UserUiProfileDesktop {
  if (d.shortcuts.length >= DESKTOP_MAX_SHORTCUTS) return d;
  return {
    ...d,
    shortcuts: [
      ...d.shortcuts,
      { id: shortcut.id, label: shortcut.label, icon: shortcut.icon, link: shortcut.link, folderId: null, deletedAt: null, createdAt: now },
    ],
  };
}

/** Создать папку. */
export function desktopAddFolder(d: UserUiProfileDesktop, folder: { id: string; name: string }, now: number): UserUiProfileDesktop {
  if (d.folders.length >= DESKTOP_MAX_FOLDERS) return d;
  return { ...d, folders: [...d.folders, { id: folder.id, name: folder.name, createdAt: now }] };
}

/** Переименовать папку. */
export function desktopRenameFolder(d: UserUiProfileDesktop, folderId: string, name: string): UserUiProfileDesktop {
  const trimmed = name.trim().slice(0, MAX_LABEL);
  if (!trimmed) return d;
  return { ...d, folders: d.folders.map((f) => (f.id === folderId ? { ...f, name: trimmed } : f)) };
}
