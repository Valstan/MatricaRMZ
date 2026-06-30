// Pure helpers for detecting that SQLite self-heal is stuck in a loop on the
// same broken migration (so retrying yields no value — emergency mode is
// the only way out). Boot-path module: no Electron imports.

/**
 * Extracts the failing SQL statement from a DrizzleError-style message.
 *
 * Drizzle formats errors as:
 *   `DrizzleError: Failed to run the query '<sql>'`
 * where `<sql>` may span multiple lines (comments + statement).
 *
 * Returns `null` if the marker is not found.
 */
export function extractFailedSql(errorMessage: string): string | null {
  if (typeof errorMessage !== 'string') return null;
  const marker = "Failed to run the query '";
  const start = errorMessage.indexOf(marker);
  if (start < 0) return null;
  const sqlStart = start + marker.length;
  const close = errorMessage.lastIndexOf("'");
  if (close <= sqlStart) return null;
  return errorMessage.slice(sqlStart, close);
}

/**
 * Normalize SQL for comparison: trim, collapse runs of whitespace.
 * Migration files contain comments + ALTER statements; whitespace normalization
 * makes the comparison robust to platform line endings and incidental edits.
 */
export function normalizeSqlForCompare(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * True when both failures look like the same migration failing.
 *
 * Compares the extracted SQL when both errors carry it; otherwise falls back
 * to comparing the full normalized error string. Used to decide that the
 * second self-heal attempt (which created a fresh empty DB) reproduced the
 * same structural failure — no further retries will succeed.
 */
export function isSameMigrationFailure(err1: unknown, err2: unknown): boolean {
  const msg1 = String(err1 ?? '');
  const msg2 = String(err2 ?? '');
  if (!msg1 || !msg2) return false;

  const sql1 = extractFailedSql(msg1);
  const sql2 = extractFailedSql(msg2);
  if (sql1 !== null && sql2 !== null) {
    return normalizeSqlForCompare(sql1) === normalizeSqlForCompare(sql2);
  }

  return normalizeSqlForCompare(msg1) === normalizeSqlForCompare(msg2);
}
