function formatSyncError(error: unknown): string {
  if (!error) return 'unknown error';
  const anyError = error as any;
  const name = anyError?.name ? String(anyError.name) : '';
  const message = anyError?.message ? String(anyError.message) : String(error);
  const cause = anyError?.cause ? ` cause=${String(anyError.cause)}` : '';
  const code = anyError?.code ? ` code=${String(anyError.code)}` : '';
  const stack = anyError?.stack ? `\n${String(anyError.stack)}` : '';
  return `${name ? name + ': ' : ''}${message}${code}${cause}${stack}`;
}

export function isOfflineSyncError(error: unknown): boolean {
  const lower = formatSyncError(error).toLowerCase();
  return (
    lower === 'offline' ||
    lower === 'error: offline' ||
    lower.startsWith('error: offline\n') ||
    lower.includes('\nerror: offline\n')
  );
}

