/**
 * Operator-built screens (UI builder pilot, docs/plans/ui-builder-pilot-2026-07.md).
 *
 * A screen is a JSON spec: a flat vertical list of blocks from a closed set
 * (heading / text / button-with-intent / list widget). Specs are stored
 * factory-wide as the EAV entity type `ui_screen` (attr `spec_json`) and ride
 * the regular sync — every client receives every screen on disk; access is
 * enforced in UI + IPC only (screen belongs to one AccessSection, view needs
 * viewer+, edit needs editor). Specs carry no sensitive data by design.
 *
 * Intents are validated against a closed allowlist here; the renderer runtime
 * additionally checks the viewer's own section-gated tabs before executing
 * (a button to an inaccessible tab renders disabled).
 */

export type UiIntent =
  | { type: 'navigate_tab'; tabId: string }
  | { type: 'open_report'; presetId?: string };

export const UI_LIST_WIDGET_IDS = ['recent_engines', 'my_work_orders'] as const;
export type UiListWidgetId = (typeof UI_LIST_WIDGET_IDS)[number];

export const UI_LIST_WIDGET_LABELS_RU: Record<UiListWidgetId, string> = {
  recent_engines: 'Последние двигатели',
  my_work_orders: 'Наряды',
};

export type UiBlock =
  | { id: string; kind: 'heading'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'button'; label: string; intent: UiIntent }
  | { id: string; kind: 'list'; widget: UiListWidgetId; limit?: number };

export type UiBlockKind = UiBlock['kind'];

export type UiSpecV1 = {
  version: 1;
  blocks: UiBlock[];
};

export const UI_SPEC_MAX_BLOCKS = 60;
export const UI_LIST_WIDGET_DEFAULT_LIMIT = 10;
export const UI_LIST_WIDGET_MAX_LIMIT = 50;

export const EMPTY_UI_SPEC: UiSpecV1 = { version: 1, blocks: [] };

function sanitizeIntent(raw: unknown): UiIntent | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type === 'navigate_tab') {
    const tabId = String(obj.tabId ?? '').trim();
    if (!tabId) return null;
    return { type: 'navigate_tab', tabId };
  }
  if (obj.type === 'open_report') {
    const presetId = String(obj.presetId ?? '').trim();
    return { type: 'open_report', ...(presetId ? { presetId } : {}) };
  }
  return null;
}

function sanitizeBlock(raw: unknown, index: number): UiBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const id = String(obj.id ?? '').trim() || `b${index}`;
  if (obj.kind === 'heading' || obj.kind === 'text') {
    const text = String(obj.text ?? '').slice(0, 2000);
    return { id, kind: obj.kind, text };
  }
  if (obj.kind === 'button') {
    const intent = sanitizeIntent(obj.intent);
    if (!intent) return null;
    const label = String(obj.label ?? '').slice(0, 200).trim();
    if (!label) return null;
    return { id, kind: 'button', label, intent };
  }
  if (obj.kind === 'list') {
    const widget = String(obj.widget ?? '');
    if (!(UI_LIST_WIDGET_IDS as readonly string[]).includes(widget)) return null;
    const limitNum = Number(obj.limit);
    const limit =
      Number.isFinite(limitNum) && limitNum >= 1
        ? Math.min(UI_LIST_WIDGET_MAX_LIMIT, Math.floor(limitNum))
        : null;
    return { id, kind: 'list', widget: widget as UiListWidgetId, ...(limit != null ? { limit } : {}) };
  }
  return null;
}

/**
 * Tolerant parse of a stored spec: object, JSON string, or DOUBLE-encoded JSON
 * string (setEntityAttribute JSON.stringify's the already serialized spec —
 * same gotcha as parseSectionMembership). Unknown block kinds / intents are
 * dropped, never fatal. Returns null only when nothing spec-shaped is found.
 */
export function sanitizeUiSpec(raw: unknown): UiSpecV1 | null {
  let obj: unknown = raw;
  for (let depth = 0; typeof obj === 'string' && depth < 2; depth += 1) {
    try {
      obj = JSON.parse(obj);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const rawBlocks = (obj as Record<string, unknown>).blocks;
  if (!Array.isArray(rawBlocks)) return null;
  const blocks: UiBlock[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < rawBlocks.length && blocks.length < UI_SPEC_MAX_BLOCKS; i += 1) {
    const block = sanitizeBlock(rawBlocks[i], i);
    if (!block) continue;
    let id = block.id;
    while (seenIds.has(id)) id = `${id}_`;
    seenIds.add(id);
    blocks.push(id === block.id ? block : { ...block, id });
  }
  return { version: 1, blocks };
}

export function serializeUiSpec(spec: UiSpecV1): string {
  return JSON.stringify(spec);
}
