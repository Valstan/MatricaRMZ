/**
 * План записи доступа по разделам (`user_section_access`).
 *
 * Вынесено отдельно от писателя: правило восстановления тумбстоуна — это
 * ЗАКОН БАЗЫ, а не деталь реализации, и его должен видеть юнит-тест без БД.
 *
 * ГЛАВНОЕ — `revive`. Строка (user_id, section_id) в базе навсегда одна:
 * UNIQUE(user_id, section_id) не смотрит на deleted_at. Поэтому повторная выдача
 * снятого (тумбстоунного) раздела обязана ВОЗВРАЩАТЬ строку (deleted_at = NULL),
 * а не вставлять новую: вставка отвергается constraint'ом, выдача падает с
 * ошибкой БД, и раздел становится невыдаваемым навсегда.
 *
 * Замер на стенде lane1 (25.11.2026): после снятия «Производства» повторная
 * выдача давала `Failed query: insert into "user_section_access" ...` — раздел
 * не выдавался больше никогда, и клиент честно писал «раздел не выдан».
 */

/** Строка доступа раздела глазами писателя. */
export type SectionAccessRow = { id: string; sectionId: string; level: string; deletedAt: number | null };

/** Что писатель сделает со строкой доступа раздела. */
export type SectionAccessWrite =
  | { kind: 'keep'; sectionId: string }
  | { kind: 'update'; sectionId: string; rowId: string; level: string }
  | { kind: 'revive'; sectionId: string; rowId: string; level: string }
  | { kind: 'insert'; sectionId: string; level: string }
  | { kind: 'revoke'; sectionId: string; rowId: string };

export function planSectionAccessWrites(
  rows: ReadonlyArray<SectionAccessRow>,
  membership: Record<string, string>,
): SectionAccessWrite[] {
  const out: SectionAccessWrite[] = [];
  const liveBySection = new Map(rows.filter((r) => r.deletedAt == null).map((r) => [String(r.sectionId), r]));
  const deadBySection = new Map(rows.filter((r) => r.deletedAt != null).map((r) => [String(r.sectionId), r]));
  for (const [sectionId, level] of Object.entries(membership)) {
    const live = liveBySection.get(sectionId);
    if (live) {
      out.push(
        String(live.level) === String(level)
          ? { kind: 'keep', sectionId }
          : { kind: 'update', sectionId, rowId: String(live.id), level: String(level) },
      );
      continue;
    }
    const dead = deadBySection.get(sectionId);
    if (dead) {
      out.push({ kind: 'revive', sectionId, rowId: String(dead.id), level: String(level) });
      continue;
    }
    out.push({ kind: 'insert', sectionId, level: String(level) });
  }
  for (const row of rows) {
    if (row.deletedAt != null) continue;
    if (String(row.sectionId) in membership) continue;
    out.push({ kind: 'revoke', sectionId: String(row.sectionId), rowId: String(row.id) });
  }
  return out;
}
