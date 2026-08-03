// Шим 'node:crypto' для android-бандла (vite-плагин androidShims).
// Реализуем ТОЛЬКО то, что реально используют портируемые сервисы; остальное
// должно падать громко и адресно. createHash sync поверх WebCrypto невозможен —
// потребители хэшей портируются на async (crypto.subtle) по месту.

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export function createHash(algorithm: string): never {
  throw new Error(
    `node:crypto shim: createHash('${algorithm}') недоступен в WebView — портируй вызов на async crypto.subtle`,
  );
}

export default { randomUUID, createHash };
