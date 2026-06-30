export function buildNomenclatureCode(prefix: string, timestamp: number = Date.now()): string {
  const normalizedPrefix = String(prefix || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const timeSuffix = String(Math.trunc(Math.abs(timestamp))).slice(-8).padStart(8, '0');
  const randomSuffix = String(Math.floor(Math.random() * 900) + 100);
  const suffix = `${timeSuffix}${randomSuffix}`;
  return normalizedPrefix ? `${normalizedPrefix}-${suffix}` : suffix;
}
