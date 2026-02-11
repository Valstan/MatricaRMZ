export const FORBIDDEN_FILENAME_CHARS_RE = /[\\/:*?"<>|\u0000-\u001F]/g;

export function splitNameAndExt(fileName: string): { stem: string; extWithDot: string } {
  const safe = String(fileName || '').replaceAll('\\', '/').split('/').pop() || 'file';
  const dot = safe.lastIndexOf('.');
  if (dot <= 0) return { stem: safe || 'file', extWithDot: '' };
  return { stem: safe.slice(0, dot) || 'file', extWithDot: safe.slice(dot) };
}

export function sanitizeFileNameStem(stem: string): { value: string; forbiddenChar: string | null } {
  const src = String(stem ?? '');
  const match = src.match(FORBIDDEN_FILENAME_CHARS_RE);
  return {
    value: src.replace(FORBIDDEN_FILENAME_CHARS_RE, ''),
    forbiddenChar: match?.[0] ?? null,
  };
}

