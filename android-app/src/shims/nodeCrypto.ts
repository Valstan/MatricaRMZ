// Шим 'node:crypto' для android-бандла (vite-плагин androidShims).
// Реализуем ТОЛЬКО то, что реально используют портируемые сервисы; остальное
// должно падать громко и адресно. createHash sync поверх WebCrypto невозможен —
// потребители хэшей портируются на async (crypto.subtle) по месту.

export function randomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/** Случайные байты — через WebCrypto (тот же источник энтропии, что и на десктопе). */
export function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, Number(size) || 0));
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function createHash(algorithm: string): never {
  throw new Error(
    `node:crypto shim: createHash('${algorithm}') недоступен в WebView — портируй вызов на async crypto.subtle`,
  );
}

export default { randomUUID, randomBytes, createHash };
