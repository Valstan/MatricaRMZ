// Workspace-профиль пользователя (раскладка вкладок, ярлыки, «Мой Круг»),
// хранится на сервере в EAV employee.ui_profile_json и подгружается при логине
// на любом клиенте. Визуальный тюнинг живёт отдельно (uiControl.ts / ui_settings_json).

import {
  DEFAULT_V3_PREFS,
  sanitizeV2Prefs,
  type UiShellPrefs,
  type V2ButtonLayout,
  type V2ColumnId,
  type V2ColumnState,
} from './uiShellV2.js';
import { sanitizeDesktopSection, type UserUiProfileDesktop } from './desktop.js';

export type UserUiProfileTabsLayout = {
  order?: string[];
  hidden?: string[];
  trashIndex?: number | null;
  groupOrder?: string[];
  hiddenGroups?: string[];
  collapsedGroups?: string[];
  activeGroup?: string | null;
};

export type UserUiProfileRecentVisit = {
  id: string;
  at: number;
  title: string;
  /** ChatDeepLinkPayload как есть (валидируется только что это объект разумного размера). */
  link?: unknown;
};

export type UserUiProfileQuickStartScore = {
  daily: Record<string, number>;
  lastAt: number;
};

export type AiChatTemplate = {
  id: string;
  title: string;
  text: string;
  createdAt: number;
};

/**
 * Roaming-подмножество shell-настроек (v3.5.0): закреплённые кнопки меню,
 * порядок/видимость, колонки, ширины сплитов. СОЗНАТЕЛЬНО без сессий
 * (открытые вкладки/карточки — состояние конкретной машины, роумить его —
 * значит воевать с оператором за его окна).
 */
export type UserUiProfileShellPrefs = {
  v2: {
    columnOrder: V2ColumnId[];
    columns: Record<V2ColumnId, V2ColumnState>;
    buttonLayout: V2ButtonLayout;
    buttonPanelPinned: boolean;
    workspaceMode: 'single' | 'tabs' | 'split2';
  };
  v3: { sectionsPct: number | null; comparePct: number };
};

export type UserUiProfile = {
  /** LWW-штамп: PATCH со штампом старше серверного отклоняется (клиент применяет серверный). */
  updatedAt: number;
  /**
   * Per-key LWW-штампы (v3.5.0): merge принимает секцию, только если её штамп
   * не старше сохранённого; отсутствующие в PATCH секции не трогаются вовсе.
   * Раньше PATCH заменял профиль целиком — клиент, пушащий 4 ключа из 5, молча
   * стирал пятый (aiChatTemplates). Наличие поля в ответе GET — сигнал клиенту,
   * что сервер умеет merge.
   */
  keyUpdatedAt?: Record<string, number>;
  tabsLayout?: UserUiProfileTabsLayout | null;
  shortcuts?: string[];
  recentVisits?: UserUiProfileRecentVisit[];
  quickStartScores?: Record<string, UserUiProfileQuickStartScore>;
  /** Сохранённые шаблоны запросов AI-чата («Сохранить как шаблон»), синкаются между ПК оператора. */
  aiChatTemplates?: AiChatTemplate[];
  /** Roaming shell-настроек (закреплённые кнопки меню и пр.) — v3.5.0. */
  shellPrefs?: UserUiProfileShellPrefs;
  /**
   * Раскладки колонок списков (`list:engines:columns` → порядок + скрытые),
   * v3.5.0. У каждой раскладки свой `updatedAt` — LWW решается по-раскладочно,
   * поэтому правка колонок в одном списке не откатывает другой.
   */
  columnLayouts?: Record<string, UserUiProfileColumnLayout>;
  /**
   * «Рабочий стол» (v3.7.0, этап 5 пакета 19.08б): ярлыки, папки, корзина,
   * раскладка сплитов экрана «чат + рабочий стол». LWW — секцией целиком.
   */
  desktop?: UserUiProfileDesktop;
  /**
   * Именованные шаблоны фильтров отчётов по пресетам (этап 6.3, 19.08б):
   * раньше жили только в локальном client_settings машины — теперь едут за
   * пользователем. LWW — секцией целиком.
   */
  reportFilterTemplates?: Record<string, ReportFilterTemplateEntry[]>;
};

export type ReportFilterTemplateEntry = {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  disabled: string[];
};

export type UserUiProfileColumnLayout = {
  order: string[];
  hidden: string[];
  updatedAt: number;
};

const MAX_LIST = 200;
const MAX_STR = 300;
const MAX_SHORTCUT_STR = 1200;
const MAX_RATING_KEYS = 500;
const MAX_LINK_JSON = 4000;

function sanitizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((x) => String(x ?? '').trim().slice(0, MAX_STR))
    .filter(Boolean)
    .slice(0, MAX_LIST);
  return out;
}

function sanitizeShortcuts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((x) => String(x ?? '').trim().slice(0, MAX_SHORTCUT_STR))
    .filter(Boolean)
    .slice(0, MAX_LIST);
}

function sanitizeTabsLayout(raw: unknown): UserUiProfileTabsLayout | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object' || raw == null) return undefined;
  const r = raw as Record<string, unknown>;
  const out: UserUiProfileTabsLayout = {};
  const order = sanitizeStringArray(r.order);
  const hidden = sanitizeStringArray(r.hidden);
  const groupOrder = sanitizeStringArray(r.groupOrder);
  const hiddenGroups = sanitizeStringArray(r.hiddenGroups);
  const collapsedGroups = sanitizeStringArray(r.collapsedGroups);
  if (order) out.order = order;
  if (hidden) out.hidden = hidden;
  if (groupOrder) out.groupOrder = groupOrder;
  if (hiddenGroups) out.hiddenGroups = hiddenGroups;
  if (collapsedGroups) out.collapsedGroups = collapsedGroups;
  if (r.trashIndex === null) out.trashIndex = null;
  else if (Number.isFinite(Number(r.trashIndex))) out.trashIndex = Number(r.trashIndex);
  if (r.activeGroup === null) out.activeGroup = null;
  else if (typeof r.activeGroup === 'string' && r.activeGroup.trim()) out.activeGroup = r.activeGroup.trim().slice(0, MAX_STR);
  return out;
}

function sanitizeRecentVisits(raw: unknown): UserUiProfileRecentVisit[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: UserUiProfileRecentVisit[] = [];
  for (const item of raw.slice(0, MAX_LIST)) {
    if (typeof item !== 'object' || item == null) continue;
    const r = item as Record<string, unknown>;
    const id = String(r.id ?? '').trim().slice(0, MAX_STR);
    const title = String(r.title ?? '').trim().slice(0, MAX_STR);
    const at = Number(r.at ?? 0);
    if (!id || !Number.isFinite(at)) continue;
    const entry: UserUiProfileRecentVisit = { id, at, title };
    if (typeof r.link === 'object' && r.link != null) {
      try {
        if (JSON.stringify(r.link).length <= MAX_LINK_JSON) entry.link = r.link;
      } catch {
        // non-serializable link — отбрасываем
      }
    }
    out.push(entry);
  }
  return out;
}

function sanitizeQuickStartScores(raw: unknown): Record<string, UserUiProfileQuickStartScore> | undefined {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return undefined;
  const out: Record<string, UserUiProfileQuickStartScore> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = String(key).trim().slice(0, MAX_STR);
    if (!k || typeof value !== 'object' || value == null) continue;
    const v = value as Record<string, unknown>;
    const lastAt = Number(v.lastAt ?? 0);
    if (!Number.isFinite(lastAt)) continue;
    const daily: Record<string, number> = {};
    if (typeof v.daily === 'object' && v.daily != null && !Array.isArray(v.daily)) {
      let d = 0;
      for (const [day, score] of Object.entries(v.daily as Record<string, unknown>)) {
        const s = Number(score);
        if (!Number.isFinite(s)) continue;
        daily[String(day).slice(0, 20)] = s;
        d += 1;
        if (d >= 60) break;
      }
    }
    out[k] = { daily, lastAt };
    n += 1;
    if (n >= MAX_RATING_KEYS) break;
  }
  return out;
}

const MAX_TEMPLATES = 30;
const MAX_TEMPLATE_TEXT = 2000;

function sanitizeAiChatTemplates(raw: unknown): AiChatTemplate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AiChatTemplate[] = [];
  for (const item of raw.slice(0, MAX_TEMPLATES)) {
    if (typeof item !== 'object' || item == null) continue;
    const r = item as Record<string, unknown>;
    const id = String(r.id ?? '').trim().slice(0, MAX_STR);
    const title = String(r.title ?? '').trim().slice(0, MAX_STR);
    const text = String(r.text ?? '').trim().slice(0, MAX_TEMPLATE_TEXT);
    const createdAt = Number(r.createdAt ?? 0);
    if (!id || !text || !Number.isFinite(createdAt)) continue;
    out.push({ id, title: title || text.slice(0, 60), text, createdAt });
  }
  return out;
}

function clampPct(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(85, Math.max(15, n)) : fallback;
}

function sanitizeShellPrefsSection(raw: unknown): UserUiProfileShellPrefs | undefined {
  if (typeof raw !== 'object' || raw == null) return undefined;
  const r = raw as { v2?: unknown; v3?: unknown };
  // Реюз sanitizeV2Prefs (те же правила, что у локального блоба), но session в
  // roaming-подмножество не входит — отбрасывается на выходе.
  const v2 = sanitizeV2Prefs(r.v2);
  const v3raw = (typeof r.v3 === 'object' && r.v3 != null ? r.v3 : {}) as { sectionsPct?: unknown; comparePct?: unknown };
  return {
    v2: {
      columnOrder: v2.columnOrder,
      columns: v2.columns,
      buttonLayout: v2.buttonLayout,
      buttonPanelPinned: v2.buttonPanelPinned,
      workspaceMode: v2.workspaceMode,
    },
    v3: {
      sectionsPct: v3raw.sectionsPct == null ? null : clampPct(v3raw.sectionsPct, 25),
      comparePct: clampPct(v3raw.comparePct, DEFAULT_V3_PREFS.comparePct),
    },
  };
}

/** Roaming-подмножество из полного локального блоба shell-настроек (без сессий). */
export function extractUserUiProfileShellPrefs(prefs: UiShellPrefs): UserUiProfileShellPrefs {
  return {
    v2: {
      columnOrder: prefs.v2.columnOrder,
      columns: prefs.v2.columns,
      buttonLayout: prefs.v2.buttonLayout,
      buttonPanelPinned: prefs.v2.buttonPanelPinned,
      workspaceMode: prefs.v2.workspaceMode,
    },
    v3: { sectionsPct: prefs.v3.sectionsPct, comparePct: prefs.v3.comparePct },
  };
}

const MAX_LAYOUTS = 200;

function sanitizeColumnLayouts(raw: unknown): Record<string, UserUiProfileColumnLayout> | undefined {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return undefined;
  const out: Record<string, UserUiProfileColumnLayout> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const layoutId = String(key).trim().slice(0, MAX_STR);
    if (!layoutId || typeof value !== 'object' || value == null) continue;
    const v = value as Record<string, unknown>;
    const updatedAt = Number(v.updatedAt);
    out[layoutId] = {
      order: sanitizeStringArray(v.order) ?? [],
      hidden: sanitizeStringArray(v.hidden) ?? [],
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    };
    n += 1;
    if (n >= MAX_LAYOUTS) break;
  }
  return out;
}

const MAX_TEMPLATE_PRESETS = 60;
const MAX_TEMPLATES_PER_PRESET = 20;
const MAX_TEMPLATE_FILTERS_JSON = 6000;

function sanitizeReportFilterTemplatesSection(raw: unknown): Record<string, ReportFilterTemplateEntry[]> | undefined {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return undefined;
  const out: Record<string, ReportFilterTemplateEntry[]> = {};
  let presets = 0;
  for (const [presetKey, value] of Object.entries(raw as Record<string, unknown>)) {
    const presetId = String(presetKey).trim().slice(0, MAX_STR);
    if (!presetId || !Array.isArray(value)) continue;
    const templates: ReportFilterTemplateEntry[] = [];
    for (const item of value.slice(0, MAX_TEMPLATES_PER_PRESET)) {
      if (typeof item !== 'object' || item == null) continue;
      const r = item as Record<string, unknown>;
      const id = String(r.id ?? '').trim().slice(0, 80);
      const name = String(r.name ?? '').trim().slice(0, MAX_STR);
      if (!id || !name) continue;
      let filters: Record<string, unknown> = {};
      if (typeof r.filters === 'object' && r.filters != null && !Array.isArray(r.filters)) {
        try {
          if (JSON.stringify(r.filters).length <= MAX_TEMPLATE_FILTERS_JSON) filters = r.filters as Record<string, unknown>;
        } catch {
          // несериализуемые фильтры — шаблон остаётся с пустыми
        }
      }
      const disabled = Array.isArray(r.disabled)
        ? r.disabled.map((x) => String(x ?? '').trim().slice(0, MAX_STR)).filter(Boolean).slice(0, 50)
        : [];
      templates.push({ id, name, filters, disabled });
    }
    if (templates.length === 0) continue;
    out[presetId] = templates;
    presets += 1;
    if (presets >= MAX_TEMPLATE_PRESETS) break;
  }
  return out;
}

const MAX_KEY_STAMPS = 32;
const MAX_KEY_NAME = 64;

function sanitizeKeyUpdatedAt(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const k = String(key).trim().slice(0, MAX_KEY_NAME);
    const v = Number(value);
    if (!k || !Number.isFinite(v) || v <= 0) continue;
    out[k] = v;
    n += 1;
    if (n >= MAX_KEY_STAMPS) break;
  }
  return out;
}

export function sanitizeUserUiProfile(raw: unknown): UserUiProfile {
  const r = (typeof raw === 'object' && raw != null ? raw : {}) as Record<string, unknown>;
  const updatedAt = Number(r.updatedAt ?? 0);
  const out: UserUiProfile = { updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0 };
  const keyUpdatedAt = sanitizeKeyUpdatedAt(r.keyUpdatedAt);
  if (keyUpdatedAt !== undefined) out.keyUpdatedAt = keyUpdatedAt;
  const tabsLayout = sanitizeTabsLayout(r.tabsLayout);
  if (tabsLayout !== undefined) out.tabsLayout = tabsLayout;
  const shortcuts = sanitizeShortcuts(r.shortcuts);
  if (shortcuts !== undefined) out.shortcuts = shortcuts;
  const recentVisits = sanitizeRecentVisits(r.recentVisits);
  if (recentVisits !== undefined) out.recentVisits = recentVisits;
  const quickStartScores = sanitizeQuickStartScores(r.quickStartScores);
  if (quickStartScores !== undefined) out.quickStartScores = quickStartScores;
  const aiChatTemplates = sanitizeAiChatTemplates(r.aiChatTemplates);
  if (aiChatTemplates !== undefined) out.aiChatTemplates = aiChatTemplates;
  const shellPrefs = sanitizeShellPrefsSection(r.shellPrefs);
  if (shellPrefs !== undefined) out.shellPrefs = shellPrefs;
  const columnLayouts = sanitizeColumnLayouts(r.columnLayouts);
  if (columnLayouts !== undefined) out.columnLayouts = columnLayouts;
  const desktop = sanitizeDesktopSection(r.desktop);
  if (desktop !== undefined) out.desktop = desktop;
  const reportFilterTemplates = sanitizeReportFilterTemplatesSection(r.reportFilterTemplates);
  if (reportFilterTemplates !== undefined) out.reportFilterTemplates = reportFilterTemplates;
  return out;
}

function profileSectionKeys(profile: UserUiProfile): string[] {
  return Object.keys(profile).filter((k) => k !== 'updatedAt' && k !== 'keyUpdatedAt');
}

/**
 * Merge с per-key LWW (v3.5.0). Секция из PATCH применяется, только если её
 * штамп (`keyUpdatedAt[k]`, фолбэк — верхний `updatedAt`) не старше сохранённого;
 * отсутствующие в PATCH секции остаются нетронутыми. Легаси-поведение
 * сохраняется: полный PATCH без keyUpdatedAt со стейл-updatedAt отклоняется
 * целиком (`stale: true`), клиент подхватывает серверный профиль.
 */
export function mergeUserUiProfiles(
  stored: UserUiProfile | null,
  incomingRaw: unknown,
): { profile: UserUiProfile; stale: boolean } {
  const incoming = sanitizeUserUiProfile(incomingRaw);
  if (!stored || !(stored.updatedAt > 0)) {
    const stamps: Record<string, number> = { ...(incoming.keyUpdatedAt ?? {}) };
    for (const k of profileSectionKeys(incoming)) {
      if (!(k in stamps)) stamps[k] = incoming.updatedAt;
    }
    return { profile: { ...incoming, keyUpdatedAt: stamps }, stale: false };
  }
  const out: UserUiProfile = { ...stored };
  const outStamps: Record<string, number> = { ...(stored.keyUpdatedAt ?? {}) };
  let stale = false;
  for (const k of profileSectionKeys(incoming)) {
    const stampIn = incoming.keyUpdatedAt?.[k] ?? incoming.updatedAt;
    const stampStored = stored.keyUpdatedAt?.[k] ?? stored.updatedAt;
    if (stampIn >= stampStored) {
      (out as Record<string, unknown>)[k] = (incoming as Record<string, unknown>)[k];
      outStamps[k] = stampIn;
    } else {
      stale = true;
    }
  }
  out.keyUpdatedAt = outStamps;
  out.updatedAt = Math.max(stored.updatedAt, incoming.updatedAt, ...Object.values(outStamps).map(Number));
  return { profile: out, stale };
}
