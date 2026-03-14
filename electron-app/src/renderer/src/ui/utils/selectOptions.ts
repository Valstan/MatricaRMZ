export type SearchableSelectOption = {
  id: string;
  label: string;
  hintText?: string;
  searchText?: string;
};

type EntityRowLike = {
  id: string;
  displayName?: string;
  searchText?: string;
};

type WarehouseLookupLike = {
  id: string;
  label: string;
  code: string | null;
  isActive?: boolean;
  meta?: Record<string, unknown>;
};

function normalizeOptionText(value: unknown): string {
  return String(value ?? '').trim();
}

export function joinOptionHint(parts: Array<unknown>): string | undefined {
  const items = parts.map(normalizeOptionText).filter(Boolean);
  return items.length > 0 ? items.join(' • ') : undefined;
}

export function joinOptionSearch(parts: Array<unknown>): string | undefined {
  const items = parts.map(normalizeOptionText).filter(Boolean);
  return items.length > 0 ? items.join(' ') : undefined;
}

export function sortSearchOptions<T extends SearchableSelectOption>(options: T[]): T[] {
  return [...options].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

export function buildSearchOption(args: {
  id: string;
  label: string;
  hintText?: string;
  searchText?: string;
}): SearchableSelectOption {
  return {
    id: args.id,
    label: args.label,
    ...(args.hintText ? { hintText: args.hintText } : {}),
    ...(args.searchText ? { searchText: args.searchText } : {}),
  };
}

export function mapEntityRowsToSearchOptions(
  rows: EntityRowLike[],
  options?: { fallbackToShortId?: boolean },
): SearchableSelectOption[] {
  return sortSearchOptions(
    rows.map((row) => {
      const id = normalizeOptionText(row.id);
      const label = normalizeOptionText(row.displayName) || (options?.fallbackToShortId ? id.slice(0, 8) : id);
      return buildSearchOption({
        id,
        label,
        searchText: joinOptionSearch([label, id, row.searchText]),
      });
    }),
  );
}

export function mapWarehouseLookupOptions(rows: WarehouseLookupLike[]): SearchableSelectOption[] {
  return sortSearchOptions(
    rows.map((row) => {
      const code = normalizeOptionText(row.code);
      const label = code ? `${row.label} (${code})` : row.label;
      const note =
        typeof row.meta?.description === 'string'
          ? row.meta.description
          : typeof row.meta?.address === 'string'
            ? row.meta.address
            : '';
      return buildSearchOption({
        id: row.id,
        label,
        hintText: joinOptionHint([code && `Код ${code}`, row.isActive === false ? 'Неактивно' : '', note]),
        searchText: joinOptionSearch([row.label, label, row.id, code, note]),
      });
    }),
  );
}

export function mapPartRowsToSearchOptions(
  rows: Array<{ id: string; name?: string; article?: string; templateName?: string }>,
): SearchableSelectOption[] {
  return sortSearchOptions(
    rows.map((row) => {
      const label = normalizeOptionText(row.name) || normalizeOptionText(row.article) || normalizeOptionText(row.id);
      return buildSearchOption({
        id: normalizeOptionText(row.id),
        label,
        hintText: joinOptionHint([row.article && `Арт. ${row.article}`, row.templateName]),
        searchText: joinOptionSearch([label, row.id, row.article, row.templateName]),
      });
    }),
  );
}
