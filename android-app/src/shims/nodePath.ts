// Шим 'node:path' (android): переносимый минимум — join в POSIX-стиле.
export function join(...parts: string[]): string {
  return parts
    .filter((p) => p != null && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export default { join };
