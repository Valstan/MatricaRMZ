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

// ─── Файловые ярлыки (этап D) ────────────────────────────────────────────────
//
// Файл на столе — полезная нагрузка ВНУТРИ существующего `link`, а не новое поле ярлыка:
// поле, не известное санитайзеру, исчезло бы при первом же сохранении, а `link` проходит
// как есть (см. sanitizeShortcut). Ключ дедупа для него заложен ещё этапом B —
// desktopShortcutLinkKey отдаёт `file:<fileId>`.
//
// Ярлык на столе НЕ даёт доступа к файлу: `ui_profile_json` намеренно не входит в список
// файло-несущих атрибутов сервера, иначе любой, кто узнал id, выдавал бы файл себе сам
// (PENDING_FOLLOWUPS §Security п.6). Обычно это незаметно — файл загрузил сам оператор, и
// его открывает ранняя ветка `createdByUserId`.

export type DesktopFileLink = { kind: 'file'; fileId: string; name: string; mime?: string };

export function desktopFileLink(file: { id: string; name: string; mime?: string | null }): DesktopFileLink {
  return {
    kind: 'file',
    fileId: String(file.id),
    name: String(file.name ?? '').slice(0, MAX_LABEL) || 'Файл',
    ...(file.mime ? { mime: String(file.mime).slice(0, 120) } : {}),
  };
}

export function desktopFileFromLink(link: unknown): { fileId: string; name: string; mime: string | null } | null {
  if (typeof link !== 'object' || link == null) return null;
  const l = link as Record<string, unknown>;
  if (String(l.kind ?? '') !== 'file') return null;
  const fileId = String(l.fileId ?? '').trim();
  if (!fileId) return null;
  return {
    fileId,
    name: String(l.name ?? '').trim() || 'Файл',
    mime: typeof l.mime === 'string' && l.mime.trim() ? l.mime.trim() : null,
  };
}

/** Значок плитки по расширению. Оператор узнаёт документ по виду, а не по подписи. */
const FILE_ICONS: Array<{ ext: string[]; icon: string }> = [
  { ext: ['pdf'], icon: '📕' },
  { ext: ['doc', 'docx', 'rtf', 'odt'], icon: '📘' },
  { ext: ['xls', 'xlsx', 'xlsm', 'csv', 'ods'], icon: '📗' },
  { ext: ['ppt', 'pptx', 'odp'], icon: '📙' },
  { ext: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic'], icon: '🖼️' },
  { ext: ['zip', 'rar', '7z', 'tar', 'gz'], icon: '🗜️' },
  { ext: ['txt', 'md', 'log'], icon: '📄' },
  { ext: ['dwg', 'dxf', 'cdw', 'frw', 'spw', 'step', 'stp', 'igs'], icon: '📐' },
  { ext: ['mp4', 'avi', 'mkv', 'mov', 'wmv'], icon: '🎬' },
  { ext: ['mp3', 'wav', 'ogg', 'm4a'], icon: '🎵' },
];

export function desktopFileIcon(fileName: string): string {
  const name = String(fileName ?? '');
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!ext) return '📎';
  return FILE_ICONS.find((row) => row.ext.includes(ext))?.icon ?? '📎';
}

// ─── Сетка стола (этап C) ────────────────────────────────────────────────────
//
// Координата плитки хранится в ЯЧЕЙКАХ (см. DesktopShortcutPos), а рисуется всегда через
// раскладку ниже. Разница принципиальная: стол — резиновая половина экрана, число колонок
// плавает вместе с разделителем, и плитка, лежащая в 8-й колонке, при узком столе просто
// не имеет своего места. Раскладка в этом случае переносит её на свободное — но
// СОХРАНЁННУЮ координату не трогает: иначе одно движение разделителя переписало бы стол у
// всех машин пользователя (каждая запись профиля = две строки в ledger, грабля M79).

/** Шаг размера плитки. Ноль — сегодняшний вид, его метрики менять нельзя. */
export type DesktopTileStep = -1 | 0 | 1 | 2 | 3 | 4;

/** Ячейка сетки. Вертикального растяжения нет ни на одном шаге — упаковка одномерная. */
export const DESKTOP_CELL_W = 112;
export const DESKTOP_CELL_H = 116;

export type DesktopTileMetrics = {
  step: DesktopTileStep;
  width: number;
  icon: number;
  iconLine: number;
  label: number;
  labelLine: number;
  height: number;
  /** Сколько ячеек по горизонтали занимает плитка. */
  cells: 1 | 2;
};

const TILE_METRICS: Record<DesktopTileStep, DesktopTileMetrics> = {
  [-1]: { step: -1, width: 76, icon: 24, iconLine: 27, label: 10, labelLine: 12, height: 71, cells: 1 },
  0: { step: 0, width: 92, icon: 30, iconLine: 34, label: 11, labelLine: 13, height: 80, cells: 1 },
  1: { step: 1, width: 108, icon: 35, iconLine: 39, label: 12, labelLine: 14, height: 87, cells: 1 },
  2: { step: 2, width: 124, icon: 40, iconLine: 44, label: 12, labelLine: 14, height: 92, cells: 2 },
  3: { step: 3, width: 144, icon: 46, iconLine: 50, label: 13, labelLine: 15, height: 100, cells: 2 },
  4: { step: 4, width: 168, icon: 54, iconLine: 58, label: 14, labelLine: 16, height: 110, cells: 2 },
};

/** Метрики шага. Значение вне диапазона зажимается — рейтинг считает числами, не литералами. */
export function desktopTileMetrics(step: number): DesktopTileMetrics {
  const n = Number.isFinite(step) ? Math.round(step) : 0;
  const clamped = (n < -1 ? -1 : n > 4 ? 4 : n) as DesktopTileStep;
  return TILE_METRICS[clamped];
}

export type DesktopPlacement = { id: string; col: number; row: number; cells: 1 | 2 };

export type DesktopGridInput = {
  /** Папки в порядке отображения. Координат у папки нет: поле `pos` сегодняшний клиент
   *  срезал бы санитайзером, а по правилу прививки это стёрло бы раскладку у всех машин
   *  пользователя. До прививки папки занимают начало сетки потоком. */
  folderIds: string[];
  shortcuts: Array<{ id: string; pos?: DesktopShortcutPos | undefined; cells: 1 | 2 }>;
  cols: number;
};

export type DesktopGrid = {
  folders: DesktopPlacement[];
  shortcuts: DesktopPlacement[];
  /** Сколько строк занято — высота полотна. */
  rows: number;
};

/**
 * Куда какая плитка ложится при `cols` колонках.
 *
 * Порядок разбора: папки → ярлыки с координатой (по строкам сверху вниз, слева направо) →
 * всё остальное первым свободным местом. Ярлык, чья координата не помещается в текущую
 * ширину или занята, попадает в последнюю очередь — то есть узкий стол не теряет плиток и
 * не накладывает их друг на друга.
 */
export function desktopLayoutGrid(input: DesktopGridInput): DesktopGrid {
  const cols = Math.max(1, Math.trunc(input.cols) || 1);
  const taken = new Set<string>();
  const key = (row: number, col: number) => `${row}:${col}`;

  /** Плитка шире всего стола занимает столько, сколько есть: иначе места ей не нашлось бы никогда. */
  const span = (cells: number): 1 | 2 => (Math.min(cells, cols) >= 2 ? 2 : 1);

  function free(row: number, col: number, cells: number): boolean {
    if (col + cells > cols) return false;
    for (let i = 0; i < cells; i += 1) if (taken.has(key(row, col + i))) return false;
    return true;
  }
  function occupy(row: number, col: number, cells: number): void {
    for (let i = 0; i < cells; i += 1) taken.add(key(row, col + i));
  }
  function firstFree(cells: number): { row: number; col: number } {
    for (let row = 0; ; row += 1) {
      for (let col = 0; col + cells <= cols; col += 1) if (free(row, col, cells)) return { row, col };
    }
  }

  const folders: DesktopPlacement[] = [];
  for (const id of input.folderIds) {
    const spot = firstFree(1);
    occupy(spot.row, spot.col, 1);
    folders.push({ id, col: spot.col, row: spot.row, cells: 1 });
  }

  const placed = new Map<string, DesktopPlacement>();
  const positioned = input.shortcuts
    .filter((s) => s.pos != null)
    .sort((a, b) => a.pos!.row - b.pos!.row || a.pos!.col - b.pos!.col);
  for (const s of positioned) {
    const { row, col } = s.pos!;
    const cells = span(s.cells);
    if (!free(row, col, cells)) continue;
    occupy(row, col, cells);
    placed.set(s.id, { id: s.id, col, row, cells });
  }

  const shortcuts: DesktopPlacement[] = [];
  for (const s of input.shortcuts) {
    const already = placed.get(s.id);
    if (already) {
      shortcuts.push(already);
      continue;
    }
    const cells = span(s.cells);
    const spot = firstFree(cells);
    occupy(spot.row, spot.col, cells);
    shortcuts.push({ id: s.id, col: spot.col, row: spot.row, cells });
  }

  let rows = 0;
  for (const p of [...folders, ...shortcuts]) rows = Math.max(rows, p.row + 1);
  return { folders, shortcuts, rows };
}

/**
 * Записать координаты пачкой — одно изменение стола на один жест, а не на плитку.
 * Совпадающие с текущими координаты не считаются изменением: дроп плитки на её же место
 * не должен стоить записи профиля.
 */
export function desktopSetPositions(
  d: UserUiProfileDesktop,
  updates: Array<{ id: string; pos: DesktopShortcutPos }>,
): UserUiProfileDesktop {
  const byId = new Map(updates.map((u) => [u.id, u.pos]));
  let changed = false;
  const shortcuts = d.shortcuts.map((s) => {
    const pos = byId.get(s.id);
    if (!pos) return s;
    if (s.pos && s.pos.col === pos.col && s.pos.row === pos.row) return s;
    changed = true;
    return { ...s, pos };
  });
  return changed ? { ...d, shortcuts } : d;
}

/** Пачка ярлыков — в корзину. Выделение удаляется одним действием, а не N подряд. */
export function desktopMoveToTrashMany(
  d: UserUiProfileDesktop,
  shortcutIds: string[],
  now: number,
): UserUiProfileDesktop {
  const ids = new Set(shortcutIds);
  if (ids.size === 0) return d;
  let changed = false;
  const shortcuts = d.shortcuts.map((s) => {
    if (!ids.has(s.id) || s.deletedAt != null) return s;
    changed = true;
    return { ...s, deletedAt: now, folderId: null };
  });
  return changed ? { ...d, shortcuts } : d;
}

/** Пачка ярлыков — в папку (или на стол при null). Координаты снимаются: место в папке своё. */
export function desktopMoveToFolderMany(
  d: UserUiProfileDesktop,
  shortcutIds: string[],
  folderId: string | null,
): UserUiProfileDesktop {
  const ids = new Set(shortcutIds);
  if (ids.size === 0) return d;
  let changed = false;
  const shortcuts = d.shortcuts.map((s) => {
    if (!ids.has(s.id) || s.deletedAt != null || s.folderId === folderId) return s;
    changed = true;
    const { pos: _pos, ...rest } = s;
    return { ...rest, folderId };
  });
  return changed ? { ...d, shortcuts } : d;
}

// ─── Рейтинг использования (этап C) ──────────────────────────────────────────
//
// Размер плитки — не абсолютное число открытий, а МЕСТО В ЛИЧНОМ РАСПРЕДЕЛЕНИИ. Отсюда
// приятное следствие, которое стоит знать: на заброшенном столе плитки не скачут — все
// счета падают синхронно, порядок не меняется. Плитка уменьшается только относительно тех,
// которыми продолжают пользоваться.

/** Пустой счётчик. */
export function createEmptyDesktopUsage(): DesktopUsage {
  return { buckets: {}, foldedAt: 0 };
}

/** День бакета по МЕСТНОМУ времени: «сегодня» у оператора — по его часам, не по UTC. */
export function desktopUsageDay(ts: number): string {
  const d = new Date(ts);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function dayIndex(day: string): number {
  const [y, m, d] = day.split('-').map((x) => Number(x));
  return Math.floor(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000);
}

/** Выбросить дни за окном — иначе карта растёт бесконечно, а санитайзер срежет молча. */
function trimDays(days: Record<string, number>, now: number): Record<string, number> {
  const oldest = dayIndex(desktopUsageDay(now)) - DESKTOP_USAGE_MAX_DAYS + 1;
  const out: Record<string, number> = {};
  for (const [day, count] of Object.entries(days)) {
    if (!USAGE_DAY_RE.test(day) || count <= 0) continue;
    if (dayIndex(day) < oldest) continue;
    out[day] = Math.min(MAX_USAGE_COUNT, Math.trunc(count));
  }
  return out;
}

/** +1 открытие ярлыка. */
export function desktopUsageBump(usage: DesktopUsage, shortcutId: string, now: number): DesktopUsage {
  const day = desktopUsageDay(now);
  const prev = usage.buckets[shortcutId] ?? {};
  const days = trimDays({ ...prev, [day]: (prev[day] ?? 0) + 1 }, now);
  return { ...usage, buckets: { ...usage.buckets, [shortcutId]: days } };
}

/**
 * Сложить счётчики: локальный, накопленный с прошлой свёртки, вливается в роумящийся.
 * Складывать, а не заменять: иначе свёртка стёрла бы то, что насчитала вторая машина.
 */
export function desktopUsageAdd(base: DesktopUsage, delta: DesktopUsage, now: number): DesktopUsage {
  const buckets: Record<string, Record<string, number>> = {};
  for (const id of new Set([...Object.keys(base.buckets), ...Object.keys(delta.buckets)])) {
    const a = base.buckets[id] ?? {};
    const b = delta.buckets[id] ?? {};
    const days: Record<string, number> = { ...a };
    for (const [day, count] of Object.entries(b)) days[day] = (days[day] ?? 0) + count;
    const trimmed = trimDays(days, now);
    if (Object.keys(trimmed).length > 0) buckets[id] = trimmed;
  }
  return { buckets, foldedAt: Math.max(base.foldedAt, delta.foldedAt) };
}

/** Счётчик без ярлыков, которых больше нет: карта не должна помнить снесённое вечно. */
export function desktopUsageKeepOnly(usage: DesktopUsage, shortcutIds: string[]): DesktopUsage {
  const keep = new Set(shortcutIds);
  const buckets: Record<string, Record<string, number>> = {};
  for (const [id, days] of Object.entries(usage.buckets)) if (keep.has(id)) buckets[id] = days;
  return Object.keys(buckets).length === Object.keys(usage.buckets).length ? usage : { ...usage, buckets };
}

/** Период полураспада счёта: неделя простоя делит его пополам. */
const USAGE_HALF_LIFE_DAYS = 7;

/** Счёт ярлыка: сумма дней с весом `0.5^(возраст/7)`. */
export function desktopUsageScore(usage: DesktopUsage, shortcutId: string, now: number): number {
  const days = usage.buckets[shortcutId];
  if (!days) return 0;
  const today = dayIndex(desktopUsageDay(now));
  let score = 0;
  for (const [day, count] of Object.entries(days)) {
    const age = today - dayIndex(day);
    if (age < 0 || age >= DESKTOP_USAGE_MAX_DAYS) continue;
    score += count * Math.pow(0.5, age / USAGE_HALF_LIFE_DAYS);
  }
  return score;
}

/** Доли сверху вниз: 5 % / 10 % / 15 % / 20 % / 30 % / 20 %. */
const STEP_BANDS: Array<{ upTo: number; step: DesktopTileStep }> = [
  { upTo: 0.05, step: 4 },
  { upTo: 0.15, step: 3 },
  { upTo: 0.3, step: 2 },
  { upTo: 0.5, step: 1 },
  { upTo: 0.8, step: 0 },
  { upTo: 1.01, step: -1 },
];

/** Потолок шага от числа ярлыков: «топ из трёх» — не топ, и раздувать плитку нелепо. */
function stepCeiling(n: number): DesktopTileStep {
  if (n >= 20) return 4;
  if (n >= 12) return 3;
  if (n >= 6) return 2;
  if (n >= 3) return 1;
  return 0;
}

/**
 * Шаг размера каждого ярлыка.
 *
 * Равные счета получают ОДИН шаг — по середине своей группы. Это важно на старте: пока
 * оператор ничего не открывал, счета у всех нулевые, середина списка попадает в полосу
 * 30 %, и весь стол стоит на шаге 0 — ровно сегодняшним видом. Без правила ничьих первый
 * же ярлык случайно оказался бы гигантским.
 */
export function desktopUsageSteps(
  usage: DesktopUsage,
  shortcutIds: string[],
  now: number,
): Record<string, DesktopTileStep> {
  const n = shortcutIds.length;
  const out: Record<string, DesktopTileStep> = {};
  if (n === 0) return out;
  const ceiling = stepCeiling(n);

  const ranked = shortcutIds
    .map((id) => ({ id, score: desktopUsageScore(usage, id, now) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && ranked[j + 1]!.score === ranked[i]!.score) j += 1;
    const middle = (i + j) / 2;
    const frac = (middle + 0.5) / n;
    const band = STEP_BANDS.find((b) => frac < b.upTo) ?? STEP_BANDS[STEP_BANDS.length - 1]!;
    const step = (band.step > ceiling ? ceiling : band.step) as DesktopTileStep;
    for (let k = i; k <= j; k += 1) out[ranked[k]!.id] = step;
    i = j + 1;
  }
  return out;
}
