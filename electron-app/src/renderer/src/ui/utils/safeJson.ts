/**
 * JSON из строки — в объект. Мусор, пустая строка и не-объект дают `null`: читатель
 * сам решает, что значит «нет данных» (обычно — взять запасной источник).
 */
export function safeJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
