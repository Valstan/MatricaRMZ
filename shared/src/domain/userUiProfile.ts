// Workspace-профиль пользователя (раскладка вкладок, ярлыки, «Мой Круг»),
// хранится на сервере в EAV employee.ui_profile_json и подгружается при логине
// на любом клиенте. Визуальный тюнинг живёт отдельно (uiControl.ts / ui_settings_json).

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

export type UserUiProfile = {
  /** LWW-штамп: PATCH со штампом старше серверного отклоняется (клиент применяет серверный). */
  updatedAt: number;
  tabsLayout?: UserUiProfileTabsLayout | null;
  shortcuts?: string[];
  recentVisits?: UserUiProfileRecentVisit[];
  quickStartScores?: Record<string, UserUiProfileQuickStartScore>;
  /** Сохранённые шаблоны запросов AI-чата («Сохранить как шаблон»), синкаются между ПК оператора. */
  aiChatTemplates?: AiChatTemplate[];
};

const MAX_LIST = 200;
const MAX_STR = 300;
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

export function sanitizeUserUiProfile(raw: unknown): UserUiProfile {
  const r = (typeof raw === 'object' && raw != null ? raw : {}) as Record<string, unknown>;
  const updatedAt = Number(r.updatedAt ?? 0);
  const out: UserUiProfile = { updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0 };
  const tabsLayout = sanitizeTabsLayout(r.tabsLayout);
  if (tabsLayout !== undefined) out.tabsLayout = tabsLayout;
  const shortcuts = sanitizeStringArray(r.shortcuts);
  if (shortcuts !== undefined) out.shortcuts = shortcuts;
  const recentVisits = sanitizeRecentVisits(r.recentVisits);
  if (recentVisits !== undefined) out.recentVisits = recentVisits;
  const quickStartScores = sanitizeQuickStartScores(r.quickStartScores);
  if (quickStartScores !== undefined) out.quickStartScores = quickStartScores;
  const aiChatTemplates = sanitizeAiChatTemplates(r.aiChatTemplates);
  if (aiChatTemplates !== undefined) out.aiChatTemplates = aiChatTemplates;
  return out;
}
