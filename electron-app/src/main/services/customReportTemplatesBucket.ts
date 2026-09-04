import { CUSTOM_REPORT_TEMPLATES_LIMIT, sanitizeCustomReportSpec, type CustomReportTemplate } from '@matricarmz/shared';

// Бакет шаблонов «Моих отчётов» одного scope (личный userId или '__shared__') в блобе
// sync_state. Правило сохранности: запись трогает ТОЛЬКО свою строку. Всё остальное в
// бакете — включая строки, которые сегодняшний санитайзер не понимает (спека под
// переименованный источник, чужой формат) — переписывается на диск как лежало. До этого
// любое сохранение пере-санитайзило весь бакет и молча выбрасывало непонятое; серверной
// копии у шаблонов нет, восстановить было неоткуда (PENDING §«Сохранение шаблона…»).

export type BucketRow = Record<string, unknown>;

function rowId(row: unknown): string {
  return String((row as any)?.id ?? '').trim();
}

function rowName(row: unknown): string {
  return String((row as any)?.name ?? '').trim();
}

function asRows(raw: unknown): BucketRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is BucketRow => !!r && typeof r === 'object' && !Array.isArray(r));
}

export function sanitizeTemplateRow(row: unknown): CustomReportTemplate | null {
  const id = rowId(row);
  const name = rowName(row);
  const spec = sanitizeCustomReportSpec((row as any)?.spec);
  if (!id || !name || !spec) return null;
  const createdAtRaw = Number((row as any)?.createdAt ?? 0);
  const ownerId = String((row as any)?.ownerId ?? '').trim();
  return {
    id,
    name,
    createdAt: Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : 0,
    spec,
    ...(ownerId ? { ownerId } : {}),
  };
}

// Чтение для показа: непонятые строки пропускаются здесь, но не на диске.
export function listTemplates(raw: unknown): CustomReportTemplate[] {
  const out: CustomReportTemplate[] = [];
  for (const row of asRows(raw)) {
    const t = sanitizeTemplateRow(row);
    if (t) out.push(t);
  }
  return out;
}

export function findTemplate(raw: unknown, args: { id?: string; name?: string }): CustomReportTemplate | null {
  const id = String(args.id ?? '').trim();
  const name = String(args.name ?? '').trim();
  for (const row of asRows(raw)) {
    if ((id && rowId(row) === id) || (name && rowName(row) === name)) return sanitizeTemplateRow(row);
  }
  return null;
}

export type UpsertOutcome = { ok: true; bucket: BucketRow[] } | { ok: false; error: string };

// Замена по id или по имени (пересохранение под тем же именем перезаписывает шаблон);
// новый — в начало. Лимит — отказ, а не молчаливое усечение хвоста.
export function upsertTemplate(raw: unknown, entry: CustomReportTemplate): UpsertOutcome {
  const rows = asRows(raw);
  const rest = rows.filter((r) => rowId(r) !== entry.id && rowName(r) !== entry.name);
  if (rest.length + 1 > CUSTOM_REPORT_TEMPLATES_LIMIT) {
    return { ok: false, error: `Достигнут предел шаблонов (${CUSTOM_REPORT_TEMPLATES_LIMIT}). Удалите ненужный, чтобы сохранить новый.` };
  }
  return { ok: true, bucket: [entry as unknown as BucketRow, ...rest] };
}

// Удаляется ровно одна строка по id; всё остальное — как лежало.
export function removeTemplate(raw: unknown, id: string): { bucket: BucketRow[]; removed: boolean } {
  const rows = asRows(raw);
  const bucket = rows.filter((r) => rowId(r) !== id);
  return { bucket, removed: bucket.length !== rows.length };
}
