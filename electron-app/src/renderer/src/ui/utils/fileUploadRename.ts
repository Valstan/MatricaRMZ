const FORBIDDEN_FILENAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

function isForbiddenFilenameChar(ch: string): boolean {
  if (FORBIDDEN_FILENAME_CHARS.has(ch)) return true;
  const cp = ch.codePointAt(0);
  return cp != null && cp >= 0 && cp <= 31;
}

export function splitNameAndExt(fileName: string): { stem: string; extWithDot: string } {
  const safe = String(fileName || '').replaceAll('\\', '/').split('/').pop() || 'file';
  const dot = safe.lastIndexOf('.');
  if (dot <= 0) return { stem: safe || 'file', extWithDot: '' };
  return { stem: safe.slice(0, dot) || 'file', extWithDot: safe.slice(dot) };
}

export function sanitizeFileNameStem(stem: string): { value: string; forbiddenChar: string | null } {
  const src = String(stem ?? '');
  let forbiddenChar: string | null = null;
  let value = '';
  for (const ch of src) {
    if (isForbiddenFilenameChar(ch)) {
      if (forbiddenChar == null) forbiddenChar = ch;
      continue;
    }
    value += ch;
  }
  return {
    value,
    forbiddenChar,
  };
}

