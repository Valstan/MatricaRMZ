/**
 * Параметры snapshot-запроса полного состояния реплики.
 *
 * ЗАЧЕМ `include_deleted=true`.
 *
 * Полный pull (`pullFullState`) в конце ставит курсор клиента на голову журнала
 * (syncService.ts: `setSyncStateNumber(LastPulledServerSeq, serverSeq)`). Значит
 * после него курсор выше ЛЮБОЙ строки, которая была в журнале до конца pull'а.
 *
 * Если snapshot не отдаёт тумбстоуны, то строка, снятая на сервере ДО pull'а,
 * до клиента не доходит: локально остаётся живая (устаревшая) копия, а её
 * тумбстоун — уже ниже курсора и инкрементальный pull его не принесёт НИКОГДА.
 *
 * Измерено на стенде lane1 (25.11.2026): сервер снял выдачу раздела
 * (`user_section_access.deleted_at` = ts, опубликовано под seq 680), а в реплике
 * клиента осталась живая строка `level=editor` — курсор при этом стоял на
 * 683 (= голова журнала), т.е. тумбстоун был перешагнут и стал недостижим.
 *
 * Тумбстоун — обычная строка с `deleted_at`, а не «отсутствие строки»: клиент
 * помечает ею локальную копию, и читатели отсекают её по `deleted_at IS NULL`.
 */
export function buildStateSnapshotQueryParams(table: string, cursorId: string | null): URLSearchParams {
  const query = new URLSearchParams();
  query.set('table', table);
  // Тумбстоуны — часть состояния: без них pull' не умеет снять строку.
  query.set('include_deleted', 'true');
  if (cursorId) query.set('cursor_id', cursorId);
  return query;
}
