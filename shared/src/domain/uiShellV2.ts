// UI shell prefs, persisted client-side (sysDb KV, keyed by userId) via ui:prefs:get/set.
// v3 «Вкладки» is the ONLY shell since 2026-07-28 (этап 6): v1/v2 renderers removed,
// sanitize maps any stored shellVersion to 'v3'. V2Prefs live on — v3 reuses the
// button layout and workspace session (open cards / focus / secondary).

export type UiShellVersion = 'v1' | 'v2' | 'v3';

export type V2ColumnId = 'buttons' | 'lists' | 'workspace';

export type V2ColumnState = {
  /** Percent of the panel group width (react-resizable-panels layout unit). */
  sizePct: number;
  collapsed: boolean;
};

export type V2ButtonLayout = {
  /** Flat operator-defined order of menu tab ids (unknown ids are appended in default order). */
  order: string[];
  /** Pinned tab ids — always rendered as the top section of the button panel. */
  pinned: string[];
  /** Hidden tab ids — removed from the panel (restorable via panel settings). */
  hidden: string[];
};

/** Open-card descriptor persisted for session restore (kind is a renderer TabId, opaque here). */
export type V2SessionCard = {
  kind: string;
  entityId: string;
  title: string;
};

/** Workspace session: open card tabs + focus + split, restored on next app start. */
export type V2Session = {
  openCards: V2SessionCard[];
  /** `${kind}:${entityId}` of the focused card, if any. */
  focusedKey: string | null;
  secondary: V2SessionCard | null;
};

export type V2Prefs = {
  columnOrder: V2ColumnId[];
  columns: Record<V2ColumnId, V2ColumnState>;
  buttonLayout: V2ButtonLayout;
  /** Overlay mode: the button panel floats over the other columns inside the app window. */
  buttonPanelPinned: boolean;
  workspaceMode: 'single' | 'tabs' | 'split2';
  session: V2Session;
};

/**
 * V3 shell («Вкладки»): одно окно с полосой вкладок. МЕНЮ — незакрываемая вкладка
 * слева; разделы, карточки, Чат, ИИваныч и Настройки — обычные члены полосы.
 * Кнопочная раскладка меню переиспользуется из v2 (buttonLayout) — операторская
 * настройка общая.
 *
 * Вид вкладки в персисте — не renderer-union, а строка: домен о разделах не знает
 * (тот же приём, что у V2SessionCard.kind).
 */
export type V3SessionTab =
  | { kind: 'list'; tabId: string }
  | { kind: 'card'; card: V2SessionCard }
  | { kind: 'chat' }
  | { kind: 'ai_chat' }
  | { kind: 'settings' };

/**
 * Сессия полосы вкладок. До R3-PR2 персистились только карточки (в `V2Prefs.session`,
 * потолок 3) — списки, синглтоны и активная вкладка не переживали перезапуск.
 */
export type V3Session = {
  /** Полный состав полосы, кроме МЕНЮ (он есть всегда), в порядке отрисовки. */
  tabs: V3SessionTab[];
  /** id активной вкладки в формате tabsModel; '' — не задан. */
  activeId: string;
  secondaryCard: V2SessionCard | null;
};

export type V3Prefs = {
  session: V3Session;
  /**
   * Ширина «РАЗДЕЛЫ» в сплите закреплённых вкладок, % (разделитель тянется мышкой).
   * `null` — ширина не выбрана оператором: колонка встаёт ровно по ширине кнопок
   * раздела, остаток отдаётся списку.
   */
  sectionsPct: number | null;
  /** Ширина левой карточки в сравнении «2 рядом», % (дефолт — пополам). */
  comparePct: number;
};

export type UiShellPrefs = {
  shellVersion: UiShellVersion;
  v2: V2Prefs;
  v3: V3Prefs;
};

export const V2_COLUMN_IDS: readonly V2ColumnId[] = ['buttons', 'lists', 'workspace'];

export const DEFAULT_V2_PREFS: V2Prefs = {
  columnOrder: ['buttons', 'lists', 'workspace'],
  columns: {
    buttons: { sizePct: 16, collapsed: false },
    lists: { sizePct: 30, collapsed: false },
    workspace: { sizePct: 54, collapsed: false },
  },
  buttonLayout: { order: [], pinned: [], hidden: [] },
  buttonPanelPinned: false,
  workspaceMode: 'single',
  session: { openCards: [], focusedKey: null, secondary: null },
};

export const V2_SESSION_MAX_CARDS = 3;

/** V3: всего вкладок ≤ 10 (2 закреплённые + карточки) → карточек не больше 8. */
export const V3_PINNED_TABS = 2;
export const V3_MAX_TOTAL_TABS = 10;
export const V3_MAX_CARD_TABS = V3_MAX_TOTAL_TABS - V3_PINNED_TABS;
/** Красное предупреждение «вкладок многовато», когда всего открыто больше 5. */
export const V3_WARN_TOTAL_TABS = 5;

export function v3TotalTabs(cardCount: number): number {
  return V3_PINNED_TABS + Math.max(0, cardCount);
}

export function v3CanOpenCard(cardCount: number): boolean {
  return cardCount < V3_MAX_CARD_TABS;
}

export function v3ShowTabsWarning(cardCount: number): boolean {
  return v3TotalTabs(cardCount) > V3_WARN_TOTAL_TABS;
}

export const DEFAULT_V3_PREFS: V3Prefs = {
  session: { tabs: [], activeId: '', secondaryCard: null },
  sectionsPct: null,
  comparePct: 50,
};

function sanitizePct(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(85, Math.max(15, n)) : fallback;
}

export const DEFAULT_UI_SHELL_PREFS: UiShellPrefs = {
  shellVersion: 'v3',
  v2: DEFAULT_V2_PREFS,
  v3: DEFAULT_V3_PREFS,
};

function isColumnId(value: unknown): value is V2ColumnId {
  return value === 'buttons' || value === 'lists' || value === 'workspace';
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x).trim()).filter((s) => s.length > 0);
}

function sanitizeColumnState(value: unknown, fallback: V2ColumnState): V2ColumnState {
  if (!value || typeof value !== 'object') return { ...fallback };
  const raw = value as Partial<V2ColumnState>;
  const sizePct = Number(raw.sizePct);
  return {
    sizePct: Number.isFinite(sizePct) ? Math.min(90, Math.max(2, sizePct)) : fallback.sizePct,
    collapsed: raw.collapsed === true,
  };
}

function sanitizeSessionCard(value: unknown): V2SessionCard | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<V2SessionCard>;
  const kind = String(raw.kind ?? '').trim();
  const entityId = String(raw.entityId ?? '').trim();
  if (!kind || !entityId) return null;
  return { kind, entityId, title: String(raw.title ?? '').trim() };
}

function sanitizeSession(value: unknown): V2Session {
  if (!value || typeof value !== 'object') return { openCards: [], focusedKey: null, secondary: null };
  const raw = value as Partial<V2Session>;
  const openCards = (Array.isArray(raw.openCards) ? raw.openCards : [])
    .map(sanitizeSessionCard)
    .filter((c): c is V2SessionCard => c !== null)
    .slice(0, V2_SESSION_MAX_CARDS);
  const focusedKey = typeof raw.focusedKey === 'string' && raw.focusedKey.trim() ? raw.focusedKey.trim() : null;
  return { openCards, focusedKey, secondary: sanitizeSessionCard(raw.secondary) };
}

export function sanitizeV2Prefs(value: unknown): V2Prefs {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_V2_PREFS);
  const raw = value as Partial<V2Prefs>;
  const rawOrder = Array.isArray(raw.columnOrder) ? raw.columnOrder.filter(isColumnId) : [];
  const columnOrder: V2ColumnId[] = [...rawOrder];
  for (const id of V2_COLUMN_IDS) if (!columnOrder.includes(id)) columnOrder.push(id);
  const rawColumns = raw.columns && typeof raw.columns === 'object' ? raw.columns : ({} as Record<string, unknown>);
  const rawButtons = raw.buttonLayout && typeof raw.buttonLayout === 'object' ? raw.buttonLayout : ({} as Partial<V2ButtonLayout>);
  const workspaceMode =
    raw.workspaceMode === 'tabs' || raw.workspaceMode === 'split2' ? raw.workspaceMode : 'single';
  return {
    columnOrder,
    columns: {
      buttons: sanitizeColumnState((rawColumns as Record<string, unknown>).buttons, DEFAULT_V2_PREFS.columns.buttons),
      lists: sanitizeColumnState((rawColumns as Record<string, unknown>).lists, DEFAULT_V2_PREFS.columns.lists),
      workspace: sanitizeColumnState((rawColumns as Record<string, unknown>).workspace, DEFAULT_V2_PREFS.columns.workspace),
    },
    buttonLayout: {
      order: sanitizeStringList((rawButtons as Partial<V2ButtonLayout>).order),
      pinned: sanitizeStringList((rawButtons as Partial<V2ButtonLayout>).pinned),
      hidden: sanitizeStringList((rawButtons as Partial<V2ButtonLayout>).hidden),
    },
    buttonPanelPinned: raw.buttonPanelPinned === true,
    workspaceMode,
    session: sanitizeSession(raw.session),
  };
}

export function sanitizeV3SessionTab(value: unknown): V3SessionTab | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { kind?: unknown; tabId?: unknown; card?: unknown };
  switch (raw.kind) {
    case 'list': {
      const tabId = String(raw.tabId ?? '').trim();
      return tabId ? { kind: 'list', tabId } : null;
    }
    case 'card': {
      const card = sanitizeSessionCard(raw.card);
      return card === null ? null : { kind: 'card', card };
    }
    case 'chat':
      return { kind: 'chat' };
    case 'ai_chat':
      return { kind: 'ai_chat' };
    case 'settings':
      return { kind: 'settings' };
    default:
      return null;
  }
}

/** Ключ дедупликации: 1:1 с id вкладки у редьюсера, но без импорта tabsModel (цикл). */
function v3SessionTabKey(tab: V3SessionTab): string {
  if (tab.kind === 'list') return `list:${tab.tabId}`;
  if (tab.kind === 'card') return `card:${tab.card.kind}:${tab.card.entityId}`;
  return tab.kind;
}

/**
 * Валидатор ФОРМЫ, не место продуктовых решений: лимит стоит только на карточках
 * (он есть и в редьюсере, и там сопровождается уведомлением). Списки ограничены
 * лишь дедупом — молча терять вкладку на пути записи в sysDb нельзя.
 */
export function sanitizeV3Session(value: unknown): V3Session {
  if (!value || typeof value !== 'object') return { tabs: [], activeId: '', secondaryCard: null };
  const raw = value as Partial<V3Session>;
  const tabs: V3SessionTab[] = [];
  const seen = new Set<string>();
  let cards = 0;
  for (const item of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = sanitizeV3SessionTab(item);
    if (tab === null) continue;
    const key = v3SessionTabKey(tab);
    if (seen.has(key)) continue;
    if (tab.kind === 'card') {
      if (cards >= V3_MAX_CARD_TABS) continue;
      cards += 1;
    }
    seen.add(key);
    tabs.push(tab);
  }
  // Именно typeof, а не String(): на старом блобе (поля нет) String(undefined) дал бы
  // строку 'undefined' и активной оказалась бы несуществующая вкладка.
  const activeId = typeof raw.activeId === 'string' ? raw.activeId.trim() : '';
  return { tabs, activeId, secondaryCard: sanitizeSessionCard(raw.secondaryCard) };
}

export function sanitizeV3Prefs(value: unknown): V3Prefs {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_V3_PREFS);
  const raw = value as Partial<V3Prefs>;
  return {
    session: sanitizeV3Session(raw.session),
    sectionsPct: raw.sectionsPct == null ? null : sanitizePct(raw.sectionsPct, 25),
    comparePct: sanitizePct(raw.comparePct, DEFAULT_V3_PREFS.comparePct),
  };
}

export function sanitizeUiShellPrefs(value: unknown): UiShellPrefs {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_UI_SHELL_PREFS);
  const raw = value as Partial<UiShellPrefs>;
  return {
    shellVersion: 'v3',
    v2: sanitizeV2Prefs(raw.v2),
    v3: sanitizeV3Prefs(raw.v3),
  };
}
