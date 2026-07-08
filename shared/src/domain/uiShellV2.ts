// V2 UI shell («Трезубец»): per-user prefs for the alternative 3-column layout.
// Persisted client-side (sysDb KV, keyed by userId) via ui:prefs:get/set.

export type UiShellVersion = 'v1' | 'v2';

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

export type V2Prefs = {
  columnOrder: V2ColumnId[];
  columns: Record<V2ColumnId, V2ColumnState>;
  buttonLayout: V2ButtonLayout;
  /** Overlay mode: the button panel floats over the other columns inside the app window. */
  buttonPanelPinned: boolean;
  workspaceMode: 'single' | 'tabs' | 'split2';
};

export type UiShellPrefs = {
  shellVersion: UiShellVersion;
  v2: V2Prefs;
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
};

export const DEFAULT_UI_SHELL_PREFS: UiShellPrefs = {
  shellVersion: 'v1',
  v2: DEFAULT_V2_PREFS,
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
  };
}

export function sanitizeUiShellPrefs(value: unknown): UiShellPrefs {
  if (!value || typeof value !== 'object') return structuredClone(DEFAULT_UI_SHELL_PREFS);
  const raw = value as Partial<UiShellPrefs>;
  return {
    shellVersion: raw.shellVersion === 'v2' ? 'v2' : 'v1',
    v2: sanitizeV2Prefs(raw.v2),
  };
}
