import { resolveDeepLinkRoute } from './deepLinkRoute.js';
import type { ChatDeepLinkPayload } from '../ipc/types.js';

// «Рабочий стол» — стартовый экран после входа (этап 5 пакета владельца 2026-08-19б):
// ярлыки-ссылки на разделы/карточки, папки, корзина и раскладка сплитов экрана
// «чат + рабочий стол». Хранится ключом `desktop` в employee.ui_profile_json
// (per-key LWW из v3.5.0) — стол едет за пользователем между машинами.

/** Место плитки в сетке стола. Ячейки, а не пиксели: стол — резиновая половина
 *  экрана «чат + рабочий стол», и абсолютные пиксели поехали бы при первом же
 *  перетаскивании разделителя. */
export type DesktopShortcutPos = {
  col: number;
  row: number;
};

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
  /** Место в сетке; нет — плитка раскладывается потоком, как до появления координат. */
  pos?: DesktopShortcutPos;
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
  /** Отметка одноразового переезда «Быстрого запуска» в ярлыки. Роумится: вторая
   *  машина переезд не повторит, удалённая вручную плитка не воскреснет. */
  shortcutsMigratedAt?: number;
};

/** Счётчик использования ярлыков: id → дневной бакет `ГГГГ-ММ-ДД` → число открытий.
 *  Живёт локально и уезжает в профиль редко и свёрткой: каждая запись профиля даёт два
 *  добавления в ledger, а «плюс один на каждое открытие» превратил бы редкую запись в
 *  поток (грабля M79). */
export type DesktopUsage = {
  buckets: Record<string, Record<string, number>>;
  /** Момент последней свёртки — чтобы не писать профиль чаще, чем нужно. */
  foldedAt: number;
};

export const DESKTOP_DEFAULT_LAYOUT: DesktopLayout = { chatPct: 33, peoplePct: 30 };

export const DESKTOP_MAX_SHORTCUTS = 200;
export const DESKTOP_MAX_FOLDERS = 40;
const MAX_LABEL = 160;
const MAX_LINK_JSON = 4000;
const MAX_GRID_CELL = 999;
/** Окно рейтинга — 30 дней (см. план «рабочий стол и человеко-понятные названия»). */
export const DESKTOP_USAGE_MAX_DAYS = 30;
const MAX_USAGE_COUNT = 1_000_000;
const USAGE_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const pos = sanitizeShortcutPos(r.pos);
  if (pos) out.pos = pos;
  if (typeof r.link === 'object' && r.link != null) {
    try {
      if (JSON.stringify(r.link).length <= MAX_LINK_JSON) out.link = r.link;
    } catch {
      // несериализуемый link — ярлык остаётся, ссылка отбрасывается
    }
  }
  return out;
}

function sanitizeGridCell(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const cell = Math.trunc(n);
  if (cell < 0 || cell > MAX_GRID_CELL) return null;
  return cell;
}

function sanitizeShortcutPos(raw: unknown): DesktopShortcutPos | null {
  if (typeof raw !== 'object' || raw == null) return null;
  const r = raw as Record<string, unknown>;
  const col = sanitizeGridCell(r.col);
  const row = sanitizeGridCell(r.row);
  if (col == null || row == null) return null;
  return { col, row };
}

/** Секция `desktopUsage` профиля: undefined — секции в PATCH нет (не трогать). */
export function sanitizeDesktopUsageSection(raw: unknown): DesktopUsage | undefined {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const bucketsRaw = typeof r.buckets === 'object' && r.buckets != null ? (r.buckets as Record<string, unknown>) : {};
  const buckets: Record<string, Record<string, number>> = {};
  for (const shortcutId of Object.keys(bucketsRaw).slice(0, DESKTOP_MAX_SHORTCUTS)) {
    const id = shortcutId.trim().slice(0, 80);
    if (!id) continue;
    const daysRaw = bucketsRaw[shortcutId];
    if (typeof daysRaw !== 'object' || daysRaw == null) continue;
    const days: Record<string, number> = {};
    for (const day of Object.keys(daysRaw as Record<string, unknown>).sort().slice(-DESKTOP_USAGE_MAX_DAYS)) {
      if (!USAGE_DAY_RE.test(day)) continue;
      const count = Number((daysRaw as Record<string, unknown>)[day]);
      if (!Number.isFinite(count) || count <= 0) continue;
      days[day] = Math.min(MAX_USAGE_COUNT, Math.trunc(count));
    }
    if (Object.keys(days).length > 0) buckets[id] = days;
  }
  const foldedAt = Number(r.foldedAt ?? 0);
  return { buckets, foldedAt: Number.isFinite(foldedAt) && foldedAt > 0 ? foldedAt : 0 };
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
  const migratedAt = Number(r.shortcutsMigratedAt ?? 0);
  return {
    shortcuts,
    folders,
    layout: {
      chatPct: clampPct(layoutRaw.chatPct, DESKTOP_DEFAULT_LAYOUT.chatPct),
      peoplePct: clampPct(layoutRaw.peoplePct, DESKTOP_DEFAULT_LAYOUT.peoplePct),
    },
    ...(Number.isFinite(migratedAt) && migratedAt > 0 ? { shortcutsMigratedAt: migratedAt } : {}),
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

/** Живые ярлыки — на столе и в папках; корзина в лимит не входит. */
export function desktopLiveShortcutCount(d: UserUiProfileDesktop): number {
  return d.shortcuts.reduce((n, s) => n + (s.deletedAt == null ? 1 : 0), 0);
}

/**
 * Ключ ссылки ярлыка для дедупа: один ярлык на одну ссылку. Карточка — по роуту
 * (`engine:<id>`; специальное поле и универсальная пара cardKind/entityId дают один
 * ключ), раздел — `tab:<tab>`. Файловый ярлык этапа D — по `fileId`: у всех файлов
 * стола одна «вкладка», и ключ по ней слил бы их в один. null — дедупить нечего.
 */
export function desktopShortcutLinkKey(link: unknown): string | null {
  if (typeof link !== 'object' || link == null) return null;
  const l = link as Record<string, unknown>;
  const kind = String(l.kind ?? '');
  if (kind === 'file') {
    const fileId = String(l.fileId ?? '').trim();
    return fileId ? `file:${fileId}` : null;
  }
  if (kind !== 'app_link') return null;
  const route = resolveDeepLinkRoute(l as unknown as ChatDeepLinkPayload);
  if (route.kind === 'card') return `${route.cardKind}:${route.id}`;
  if (route.kind === 'tab') return route.id ? `tab:${route.id}` : null;
  return `${route.kind}:${route.id}`;
}

export type DesktopShortcutInput = { id: string; label: string; icon: string; link?: unknown };

/** Добавить ярлык на стол (id генерирует вызывающий — crypto.randomUUID в renderer). */
export function desktopAddShortcut(d: UserUiProfileDesktop, shortcut: DesktopShortcutInput, now: number): UserUiProfileDesktop {
  if (desktopLiveShortcutCount(d) >= DESKTOP_MAX_SHORTCUTS) return d;
  return {
    ...d,
    shortcuts: [
      ...d.shortcuts,
      { id: shortcut.id, label: shortcut.label, icon: shortcut.icon, link: shortcut.link, folderId: null, deletedAt: null, createdAt: now },
    ],
  };
}

export type DesktopToggleOutcome = 'added' | 'removed' | 'limit';

/**
 * Тумблер кнопки-галстука: ссылки на столе нет — положить (из корзины вернуть свой же
 * ярлык, а не плодить новый), есть — убрать в корзину. Исход возвращается явно, чтобы
 * сообщение оператору называло то, что произошло: упор в лимит — не «добавлено».
 */
export function desktopToggleShortcut(
  d: UserUiProfileDesktop,
  shortcut: DesktopShortcutInput,
  now: number,
): { desktop: UserUiProfileDesktop; outcome: DesktopToggleOutcome } {
  const key = desktopShortcutLinkKey(shortcut.link);
  if (key) {
    const live = d.shortcuts.find((s) => s.deletedAt == null && desktopShortcutLinkKey(s.link) === key);
    if (live) return { desktop: desktopMoveToTrash(d, live.id, now), outcome: 'removed' };
  }
  if (desktopLiveShortcutCount(d) >= DESKTOP_MAX_SHORTCUTS) return { desktop: d, outcome: 'limit' };
  if (key) {
    const trashed = d.shortcuts.find((s) => s.deletedAt != null && desktopShortcutLinkKey(s.link) === key);
    if (trashed) return { desktop: desktopRestoreFromTrash(d, trashed.id), outcome: 'added' };
  }
  return { desktop: desktopAddShortcut(d, shortcut, now), outcome: 'added' };
}

export type DesktopPutOutcome = 'added' | 'exists' | 'limit';

/**
 * «Добавить на Рабочий стол» из меню кнопок: не тумблер — пункт называется «добавить»,
 * и снимать ярлык он не должен. Лежащий ярлык (в т.ч. в папке) — `exists`, из корзины
 * возвращается свой же.
 */
export function desktopPutShortcut(
  d: UserUiProfileDesktop,
  shortcut: DesktopShortcutInput,
  now: number,
): { desktop: UserUiProfileDesktop; outcome: DesktopPutOutcome } {
  const key = desktopShortcutLinkKey(shortcut.link);
  if (key && d.shortcuts.some((s) => s.deletedAt == null && desktopShortcutLinkKey(s.link) === key)) {
    return { desktop: d, outcome: 'exists' };
  }
  const r = desktopToggleShortcut(d, shortcut, now);
  return { desktop: r.desktop, outcome: r.outcome === 'limit' ? 'limit' : 'added' };
}

/** Переименовать ярлык — подпись замораживается при создании, иначе исправить её нечем. */
export function desktopRenameShortcut(d: UserUiProfileDesktop, shortcutId: string, label: string): UserUiProfileDesktop {
  const trimmed = label.trim().slice(0, MAX_LABEL);
  if (!trimmed) return d;
  return { ...d, shortcuts: d.shortcuts.map((s) => (s.id === shortcutId ? { ...s, label: trimmed } : s)) };
}

/**
 * Одноразовый переезд «Быстрого запуска» в ярлыки стола. Отметка роумится, поэтому
 * вторая машина переезд не повторит и удалённая вручную плитка не воскреснет. Id
 * детерминирован по ключу ссылки: две машины, переехавшие до первого sync'а, дадут
 * один ярлык, а не два. Занятый чужим ярлыком id и уже лежащая на столе ссылка —
 * пропускаются, не перетираются.
 */
export function desktopMigrateQuickStart(
  d: UserUiProfileDesktop,
  items: Array<{ label: string; icon: string; link: unknown }>,
  now: number,
): UserUiProfileDesktop {
  if (d.shortcutsMigratedAt) return d;
  const ids = new Set(d.shortcuts.map((s) => s.id));
  const liveKeys = new Set(d.shortcuts.filter((s) => s.deletedAt == null).map((s) => desktopShortcutLinkKey(s.link)));
  let next = d;
  for (const item of items) {
    const key = desktopShortcutLinkKey(item.link);
    if (!key || liveKeys.has(key)) continue;
    const id = `qs:${key}`.slice(0, 80);
    if (ids.has(id)) continue;
    next = desktopAddShortcut(next, { id, label: item.label, icon: item.icon, link: item.link }, now);
    ids.add(id);
    liveKeys.add(key);
  }
  return { ...next, shortcutsMigratedAt: now };
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
