export type PopupItemKind = 'current' | 'history' | 'source';

export type PopupItem = {
  value: string;
  kind: PopupItemKind;
};

export const MAX_HISTORY_PER_FIELD = 6;
export const EMPTY_SOURCE_PREVIEW = 5;

export function normalizeAssistText(value: string | null | undefined): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function getDatabaseOptions(field: {
  dataset: DOMStringMap;
  getAttribute: (name: string) => string | null;
}): string[] | null {
  const raw = field.dataset.inputAssistOptions;
  if (raw) {
    try {
      const parsed = JSON.parse(String(raw)) as unknown;
      if (Array.isArray(parsed)) {
        const values = parsed.map((entry) => normalizeAssistText(String(entry ?? ''))).filter(Boolean);
        if (values.length) return Array.from(new Set(values));
      }
    } catch {
      // ignore invalid JSON
    }
  }
  const listId = field.getAttribute('list');
  if (listId && typeof document !== 'undefined') {
    const el = document.getElementById(listId);
    if (el instanceof HTMLDataListElement) {
      const values = Array.from(el.options)
        .map((option) => normalizeAssistText(option.value))
        .filter(Boolean);
      if (values.length) return Array.from(new Set(values));
    }
  }
  return null;
}

export function usesDatabaseSource(field: { dataset: DOMStringMap; getAttribute: (name: string) => string | null }): boolean {
  if (field.dataset.inputAssist === 'database') return true;
  return getDatabaseOptions(field) !== null;
}

export function buildAssistPopupItems(args: {
  value: string;
  historyEntries: string[];
  databaseOptions: string[] | null;
  databaseOnly: boolean;
}): PopupItem[] {
  const value = normalizeAssistText(args.value);
  const dbOptions = args.databaseOptions;
  const dbMode = args.databaseOnly && !!dbOptions?.length;
  const items: PopupItem[] = [];

  if (value) items.push({ value, kind: 'current' });

  for (const entry of args.historyEntries) {
    if (entry === value) continue;
    if (dbMode && dbOptions && !dbOptions.includes(entry)) continue;
    if (items.some((item) => item.value === entry)) continue;
    items.push({ value: entry, kind: 'history' });
    if (items.length >= MAX_HISTORY_PER_FIELD) break;
  }

  const slotsLeft = Math.max(0, MAX_HISTORY_PER_FIELD - items.length);
  if (slotsLeft > 0 && dbOptions?.length) {
    const query = value.toLowerCase();
    const candidates = dbOptions.filter((option) => {
      if (items.some((item) => item.value === option)) return false;
      if (!query) return true;
      return option.toLowerCase().includes(query);
    });
    const previewLimit = !value ? EMPTY_SOURCE_PREVIEW : slotsLeft;
    for (const option of candidates.slice(0, Math.min(slotsLeft, previewLimit))) {
      items.push({ value: option, kind: 'source' });
    }
  }

  return items;
}

export function canRememberAssistValue(args: {
  value: string;
  databaseOptions: string[] | null;
  databaseOnly: boolean;
}): boolean {
  const value = normalizeAssistText(args.value);
  if (!value) return false;
  if (!args.databaseOnly || !args.databaseOptions?.length) return true;
  return args.databaseOptions.includes(value);
}

export function assistItemKindLabel(kind: PopupItemKind): string {
  if (kind === 'current') return 'Текущее значение';
  if (kind === 'history') return 'Недавнее значение';
  return 'Из базы данных';
}
