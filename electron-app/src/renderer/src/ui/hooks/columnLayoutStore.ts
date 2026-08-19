// Хранилище раскладок колонок списков (порядок + скрытые), общее для
// useColumnLayout и roaming-канала профиля.
//
// Два изменения против прежнего приватного кода внутри useColumnLayout:
//  1) ключ привязан к пользователю (`…:<userId>:<layoutId>`) — на общей рабочей
//     станции раскладки одного оператора больше не видны другому; легаси-ключ
//     читается один раз и переносится в скоуп;
//  2) у записи есть `updatedAt` — это LWW-граница для синхронизации раскладок
//     через ui_profile (аккаунт едет за оператором на другой компьютер).

export type ColumnLayoutState = {
  order: string[];
  hidden: string[];
};

export type ColumnLayoutEntry = ColumnLayoutState & { updatedAt: number };

const STORAGE_PREFIX = 'matrica:columnLayout:';
export const COLUMN_LAYOUT_CHANGE_EVENT = 'matrica:column-layout-changed';

let currentUserId = '';

/** Скоуп ключей: вызывается из App при логине/смене пользователя. */
export function setColumnLayoutUser(userId: string): void {
  currentUserId = String(userId ?? '').trim();
}

function scopedKey(layoutId: string): string {
  return currentUserId ? `${STORAGE_PREFIX}${currentUserId}:${layoutId}` : `${STORAGE_PREFIX}${layoutId}`;
}

function legacyKey(layoutId: string): string {
  return `${STORAGE_PREFIX}${layoutId}`;
}

function parseEntry(raw: string | null): ColumnLayoutEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ColumnLayoutEntry>;
    const updatedAt = Number(parsed.updatedAt);
    return {
      order: Array.isArray(parsed.order) ? parsed.order.map(String) : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.map(String) : [],
      // Легаси-запись без штампа: 0 — любая серверная копия считается свежее.
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function readColumnLayout(layoutId: string): ColumnLayoutEntry | null {
  try {
    const scoped = parseEntry(window.localStorage.getItem(scopedKey(layoutId)));
    if (scoped) return scoped;
    if (!currentUserId) return null;
    // Разовый перенос легаси-записи (до user-scope) в скоуп текущего оператора.
    const legacy = parseEntry(window.localStorage.getItem(legacyKey(layoutId)));
    if (!legacy) return null;
    window.localStorage.setItem(scopedKey(layoutId), JSON.stringify(legacy));
    return legacy;
  } catch {
    return null;
  }
}

export function writeColumnLayout(layoutId: string, state: ColumnLayoutState, opts?: { updatedAt?: number }): void {
  const entry: ColumnLayoutEntry = {
    order: state.order,
    hidden: state.hidden,
    updatedAt: opts?.updatedAt ?? Date.now(),
  };
  try {
    window.localStorage.setItem(scopedKey(layoutId), JSON.stringify(entry));
    window.dispatchEvent(new CustomEvent(COLUMN_LAYOUT_CHANGE_EVENT, { detail: { layoutId } }));
  } catch {
    // localStorage недоступен — раскладка живёт только в стейте страницы
  }
}

/**
 * Сброс к умолчанию — операция локальная: серверная копия остаётся, но и не
 * возвращается назад (hydrate только добавляет/обновляет по свежести, ничего не
 * удаляет). Так «сбросил у себя» не означает «сбросил всем машинам сразу».
 */
export function clearColumnLayout(layoutId: string): void {
  try {
    window.localStorage.removeItem(scopedKey(layoutId));
    window.localStorage.removeItem(legacyKey(layoutId));
    window.dispatchEvent(new CustomEvent(COLUMN_LAYOUT_CHANGE_EVENT, { detail: { layoutId } }));
  } catch {
    // ignore
  }
}

/** Все раскладки текущего пользователя — сырьё для пуша в профиль. */
export function readAllColumnLayouts(): Record<string, ColumnLayoutEntry> {
  const out: Record<string, ColumnLayoutEntry> = {};
  if (!currentUserId) return out;
  try {
    const prefix = `${STORAGE_PREFIX}${currentUserId}:`;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i) ?? '';
      if (!key.startsWith(prefix)) continue;
      const layoutId = key.slice(prefix.length);
      if (!layoutId) continue;
      const entry = parseEntry(window.localStorage.getItem(key));
      if (entry) out[layoutId] = entry;
    }
  } catch {
    // ignore
  }
  return out;
}

/**
 * Применение серверных раскладок: запись принимается, только если её штамп
 * свежее локального (LWW). Возвращает число применённых раскладок.
 */
export function hydrateColumnLayouts(entries: Record<string, ColumnLayoutEntry> | null | undefined): number {
  if (!entries || typeof entries !== 'object') return 0;
  let applied = 0;
  for (const [layoutId, raw] of Object.entries(entries)) {
    if (!layoutId || !raw || typeof raw !== 'object') continue;
    const incoming: ColumnLayoutEntry = {
      order: Array.isArray(raw.order) ? raw.order.map(String) : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden.map(String) : [],
      updatedAt: Number(raw.updatedAt) || 0,
    };
    const local = readColumnLayout(layoutId);
    if (local && local.updatedAt >= incoming.updatedAt) continue;
    writeColumnLayout(layoutId, { order: incoming.order, hidden: incoming.hidden }, { updatedAt: incoming.updatedAt });
    applied += 1;
  }
  return applied;
}
