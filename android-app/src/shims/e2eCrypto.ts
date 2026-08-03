// Шим sync/e2eCrypto.ts для android-бандла: E2E-шифрование полей ledger НЕ
// портируется (план §Серверные изменения: на проде MATRICA_LEDGER_E2E=off;
// оригинал тянет node:crypto cipher, e2eKeyService и process.env).
// Поверхность экспорта идентична, поведение = «E2E выключен».

export function isE2eEnabled(): boolean {
  return false;
}

export function getE2eKeys(): { primary: null; all: never[] } {
  return { primary: null, all: [] };
}

export function encryptRowSensitive(row: Record<string, unknown>, _key: unknown): Record<string, unknown> {
  return row;
}

export function decryptRowSensitive(row: Record<string, unknown>, _keys: unknown[]): Record<string, unknown> {
  return row;
}
