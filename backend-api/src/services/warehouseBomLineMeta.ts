type BomLineMetaPayload = {
  format: 'bom_line_meta_v1';
  text?: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
};

export type WarehouseBomLineMeta = {
  text: string | null;
  lineKey: string | null;
  parentLineKey: string | null;
};

function normalizeNodeKey(raw: unknown): string | null {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
  return value || null;
}

export function parseWarehouseBomLineMeta(raw: unknown): WarehouseBomLineMeta {
  const fallbackText = typeof raw === 'string' ? raw : raw == null ? null : String(raw);
  if (typeof raw !== 'string') {
    return { text: fallbackText, lineKey: null, parentLineKey: null };
  }
  const text = raw.trim();
  if (!text) return { text: null, lineKey: null, parentLineKey: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { text, lineKey: null, parentLineKey: null };
    }
    const rec = parsed as Record<string, unknown>;
    if (String(rec.format ?? '') !== 'bom_line_meta_v1') {
      return { text, lineKey: null, parentLineKey: null };
    }
    const lineKey = normalizeNodeKey(rec.lineKey);
    const parentLineKey = normalizeNodeKey(rec.parentLineKey);
    const textValue = rec.text == null ? null : String(rec.text);
    return { text: textValue, lineKey, parentLineKey };
  } catch {
    return { text, lineKey: null, parentLineKey: null };
  }
}

export function serializeWarehouseBomLineMeta(meta: {
  text?: string | null;
  lineKey?: string | null;
  parentLineKey?: string | null;
}): string | null {
  const text = meta.text == null ? null : String(meta.text);
  const lineKey = normalizeNodeKey(meta.lineKey);
  let parentLineKey = normalizeNodeKey(meta.parentLineKey);
  if (lineKey && parentLineKey === lineKey) parentLineKey = null;
  if (!lineKey && !parentLineKey) {
    return text && text.trim() ? text : null;
  }
  const payload: BomLineMetaPayload = {
    format: 'bom_line_meta_v1',
    ...(text && text.trim() ? { text } : {}),
    ...(lineKey ? { lineKey } : {}),
    ...(parentLineKey ? { parentLineKey } : {}),
  };
  return JSON.stringify(payload);
}
