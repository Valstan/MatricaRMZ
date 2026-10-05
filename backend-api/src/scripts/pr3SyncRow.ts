// PR3 helper: сырая pg-строка operations (snake_case, bigint строкой) →
// camelCase-DTO для SyncTableRegistry.toSyncRow.
//
// toSyncRow ждёт camelCase (как отдаёт drizzle), а pool.query отдаёт snake_case:
// без конверсии DTO выходит почти пустым ({id} + ничего) и валидатор
// syncRowSchemaByTable режет пачку с sync_invalid_row. Числа bigint из pg —
// строки, zod хочет number: приводим здесь же.
export function camelOperationRowForSync(r: Record<string, unknown>): Record<string, unknown> {
  const num = (v: unknown): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const req = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error('битая дата строки operations');
    return n;
  };
  return {
    id: String(r.id ?? ''),
    engineEntityId: String(r.engine_entity_id ?? ''),
    operationType: String(r.operation_type ?? ''),
    status: String(r.status ?? ''),
    note: r.note == null ? null : String(r.note),
    performedAt: num(r.performed_at),
    performedBy: r.performed_by == null ? null : String(r.performed_by),
    metaJson: r.meta_json == null ? null : String(r.meta_json),
    createdAt: req(r.created_at),
    updatedAt: req(r.updated_at),
    lastServerSeq: num(r.last_server_seq),
    deletedAt: num(r.deleted_at),
    syncStatus: String(r.sync_status ?? 'synced'),
  };
}
