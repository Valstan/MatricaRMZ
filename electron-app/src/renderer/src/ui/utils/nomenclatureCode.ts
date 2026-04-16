export function buildNomenclatureCode(prefix: string, timestamp: number = Date.now()): string {
  const normalizedPrefix = String(prefix || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const suffix = String(Math.trunc(Math.abs(timestamp))).slice(-8).padStart(8, '0');
  return normalizedPrefix ? `${normalizedPrefix}-${suffix}` : suffix;
}
