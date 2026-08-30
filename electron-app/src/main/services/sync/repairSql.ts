/**
 * SQL-заготовки ремонта локальной реплики.
 *
 * Вынесено из syncService ради одного: это единственные строки в клиенте,
 * которые УДАЛЯЮТ данные исходя из схемы, полученной с сервера. Ошибка здесь
 * не даёт исключения — она молча выносит строки, и заметно это становится
 * через недели. Поэтому форма запроса должна быть проверяема тестом.
 */

export function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/** Псевдоним таблицы-родителя в подзапросе. Имя заведомо не может совпасть с настоящей таблицей. */
const REF_ALIAS = '__matrica_ref';

/**
 * DELETE строк-сирот по внешнему ключу.
 *
 * Родитель ОБЯЗАН идти под псевдонимом. Пока таблица и таблица-родитель были
 * разными, запрос работал и без него. На самоссылке (`users.delete_requested_by
 * -> users.id`, первая такая в sync-контракте) оба имени в условии связались бы
 * с ВНУТРЕННИМ `users`: корреляции с внешней строкой нет, подзапрос вырождается
 * в «есть ли строка, ссылающаяся сама на себя», таких обычно нет — и `NOT EXISTS`
 * истинно для КАЖДОЙ строки. Ремонт вынес бы из реплики все аккаунты с заявкой
 * на удаление, а следом их доступы как FK-сирот.
 */
export function buildOrphanCleanupSql(args: {
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
  pendingGuard: string;
}): string {
  const { table, column, refTable, refColumn, pendingGuard } = args;
  return `DELETE FROM ${quoteIdent(table)}
        WHERE ${quoteIdent(column)} IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${quoteIdent(refTable)} AS ${quoteIdent(REF_ALIAS)}
            WHERE ${quoteIdent(REF_ALIAS)}.${quoteIdent(refColumn)} = ${quoteIdent(table)}.${quoteIdent(column)}
          )${pendingGuard}`;
}
