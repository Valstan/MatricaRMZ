export const HIDDEN_TABLES: ReadonlyArray<string> = [
  'refresh_tokens',
  'ledger_data_keys',
  'session_keys',
];

export const HIDDEN_COLUMNS: ReadonlyArray<string> = [
  'password_hash',
  'tokenhash',
  'token_hash',
  'refresh_token',
  'salt',
  'private_key',
  'enc_key',
  'encryption_key',
  'secret',
];

export const HIDDEN_ATTRIBUTE_NAMES: ReadonlyArray<string> = [
  'salary',
  'зарплата',
  'оклад',
  'паспорт',
  'passport',
  'inn',
  'snils',
  'снилс',
  'инн',
];

const REDACTED = '[hidden]';

const HIDDEN_COLUMNS_LC = new Set(HIDDEN_COLUMNS.map((s) => s.toLowerCase()));
const HIDDEN_TABLES_LC = new Set(HIDDEN_TABLES.map((s) => s.toLowerCase()));
const HIDDEN_ATTRIBUTE_NAMES_LC = HIDDEN_ATTRIBUTE_NAMES.map((s) => s.toLowerCase());

export function sanitizeRow<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row } as Record<string, unknown>;
  for (const key of Object.keys(out)) {
    if (HIDDEN_COLUMNS_LC.has(key.toLowerCase())) {
      out[key] = REDACTED;
    }
  }
  return out as T;
}

export function sanitizeRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => sanitizeRow(r));
}

export function isHiddenAttributeName(name: unknown): boolean {
  const s = String(name ?? '').trim().toLowerCase();
  if (!s) return false;
  for (const needle of HIDDEN_ATTRIBUTE_NAMES_LC) {
    if (s === needle || s.includes(needle)) return true;
  }
  return false;
}

export type AttributeRow = {
  attribute_name?: string | null;
  attr_name?: string | null;
  name?: string | null;
  attribute_code?: string | null;
  code?: string | null;
  value?: unknown;
  value_text?: unknown;
};

export function sanitizeAttributeValueRows<T extends AttributeRow>(rows: T[]): T[] {
  return rows.filter((r) => {
    const candidates = [r.attribute_name, r.attr_name, r.name, r.attribute_code, r.code];
    return !candidates.some((c) => isHiddenAttributeName(c));
  });
}

const SQL_IDENTIFIER_RE = /[a-zA-Z_][a-zA-Z0-9_]*/g;

export function findForbiddenIdentifiers(sql: string): string[] {
  const text = String(sql ?? '').toLowerCase();
  const tokens = text.match(SQL_IDENTIFIER_RE) ?? [];
  const hit = new Set<string>();
  for (const t of tokens) {
    if (HIDDEN_TABLES_LC.has(t) || HIDDEN_COLUMNS_LC.has(t)) hit.add(t);
  }
  return Array.from(hit);
}

export function sqlReferencesHiddenIdentifiers(sql: string): boolean {
  return findForbiddenIdentifiers(sql).length > 0;
}
