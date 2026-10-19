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
  /** Ручные ширины колонок, px (владелец 01.10.2026): тянуть за край шапки. Нет записи — авто. */
  widths?: Record<string, number>;
};

export type ColumnLayoutEntry = Omit<ColumnLayoutState, 'widths'> & {
  widths: Record<string, number>;
  updatedAt: number;
};

const STORAGE_PREFIX = 'matrica:columnLayout:';
const HIDE_ONCE_PREFIX = 'matrica:columnLayout:hideOnce:';
export const COLUMN_LAYOUT_CHANGE_EVENT = 'matrica:column-layout-changed';

/**
 * Колонки, спрятанные задним числом у уже сохранённых раскладок (владелец 19.10.2026, P6:
 * «дата внесения — убрать из показа по умолчанию, оставить в настройках колонок»). Обычное
 * правило `defaultHidden` такие колонки не трогает: сохранённая запись их знает, а «оператор
 * уже видел» (см. `layoutFromPersisted`). Поэтому смена умолчания для жившей колонки названа
 * здесь явно и срабатывает один раз на пользователя: включил обратно в «Колонках списка» —
 * значит, так и надо, второй раз прятать не станем.
 */
const HIDE_ONCE: Record<string, readonly string[]> = {
  'list:engines:columns': ['updatedAt'],
};

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

/** Ручная ширина: 48..1200px, мусор отбрасывается. */
export function normalizeColumnWidths(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const px = Math.round(Number(value));
    if (!id || !Number.isFinite(px)) continue;
    out[id] = Math.max(48, Math.min(1200, px));
  }
  return out;
}

function parseEntry(raw: string | null): ColumnLayoutEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ColumnLayoutEntry>;
    const updatedAt = Number(parsed.updatedAt);
    return {
      order: Array.isArray(parsed.order) ? parsed.order.map(String) : [],
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.map(String) : [],
      widths: normalizeColumnWidths(parsed.widths),
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
    widths: normalizeColumnWidths(state.widths),
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

/**
 * Раскладка после разовой миграции умолчаний; `null` — менять нечего либо миграция этому
 * пользователю уже применялась. Отметка локальная (не едет в профиль): на другой машине
 * раскладка обычно приходит уже с этой колонкой скрытой, и прятать нечего; если там колонку
 * включали руками, новое умолчание сработает один раз и там — дальше решает оператор.
 */
export function applyHideOnce(layoutId: string, knownIds: readonly string[], state: ColumnLayoutState): ColumnLayoutState | null {
  const ids = HIDE_ONCE[layoutId];
  if (!ids || ids.length === 0) return null;
  const key = `${HIDE_ONCE_PREFIX}${currentUserId}:${layoutId}`;
  try {
    if (window.localStorage.getItem(key)) return null;
    window.localStorage.setItem(key, '1');
  } catch {
    return null;
  }
  const known = new Set(knownIds);
  const hidden = new Set(state.hidden);
  let changed = false;
  for (const id of ids) {
    if (!known.has(id) || hidden.has(id)) continue;
    hidden.add(id);
    changed = true;
  }
  return changed ? { ...state, hidden: Array.from(hidden) } : null;
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
export function hydrateColumnLayouts(
  entries: Record<string, { order?: unknown; hidden?: unknown; widths?: unknown; updatedAt?: unknown }> | null | undefined,
): number {
  if (!entries || typeof entries !== 'object') return 0;
  let applied = 0;
  for (const [layoutId, raw] of Object.entries(entries)) {
    if (!layoutId || !raw || typeof raw !== 'object') continue;
    const incoming: ColumnLayoutEntry = {
      order: Array.isArray(raw.order) ? raw.order.map(String) : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden.map(String) : [],
      widths: normalizeColumnWidths(raw.widths),
      updatedAt: Number(raw.updatedAt) || 0,
    };
    const local = readColumnLayout(layoutId);
    if (local && local.updatedAt >= incoming.updatedAt) continue;
    writeColumnLayout(layoutId, { order: incoming.order, hidden: incoming.hidden, widths: incoming.widths }, { updatedAt: incoming.updatedAt });
    applied += 1;
  }
  return applied;
}
