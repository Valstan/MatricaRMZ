// Шим 'node:path' (android): переносимый минимум — join в POSIX-стиле.
//
// `resolve` добавлен для `ipc/pathOriginRegistry.ts` (allowlist путей, которые
// выдал main-процесс): на планшете пути псевдо-файловые («/android/…»), и
// абсолютизация должна быть предсказуемой — без обращения к файловой системе.
export function join(...parts: string[]): string {
  return parts
    .filter((p) => p != null && p !== '')
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/** Абсолютизация пути: без диска (POSIX-стиль), как и `join` выше. */
export function resolve(...parts: string[]): string {
  const joined = join(...parts);
  if (joined.startsWith('/')) return joined;
  return join('/', joined);
}

export function basename(p: string, ext?: string): string {
  const parts = String(p ?? '').split('/');
  const name = parts[parts.length - 1] ?? '';
  return ext && name.endsWith(ext) ? name.slice(0, name.length - ext.length) : name;
}

export function dirname(p: string): string {
  const parts = String(p ?? '').split('/');
  parts.pop();
  return join('/', ...parts);
}

export function extname(p: string): string {
  const name = basename(p);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

export default { join, resolve, basename, dirname, extname };
