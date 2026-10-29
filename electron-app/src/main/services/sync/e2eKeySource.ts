// Кольцо E2E-ключей строк синка — через провайдер, а не импортом.
//
// Причина та же, что у сессии и хоста: файл кольца зашифрован ключом ОС
// (`safeStorage`/DPAPI), а в процессе движка синка его нет. Провайдер ставит тот
// процесс, где ключ ОС живёт; движок только спрашивает.
//
// Молча «ключей нет» здесь недопустимо: при включённом E2E это означало бы запись
// открытым текстом строк, которые соседние клиенты читают как зашифрованные. Поэтому
// отсутствие источника — громкая ошибка, а не пустой список ключей.
export type E2eKeyRingView = {
  primary: string;
  previous: string[];
};

type E2eKeySource = () => E2eKeyRingView;

let source: E2eKeySource | null = null;

export function setE2eKeyRingSource(next: E2eKeySource | null): void {
  source = next;
}

export function readE2eKeyRing(): E2eKeyRingView | null {
  if (!source) return null;
  try {
    return source();
  } catch {
    // Кольцо на диске нечитаемо (сменился профиль ОС, файл повреждён) — это тот же
    // отказ, что и «источника нет»: E2E-строки расшифровать нечем.
    return null;
  }
}

/** Первичный ключ первым: им шифруем, остальными пробуем расшифровать. */
export function keyRingToBuffers(ring: E2eKeyRingView): Buffer[] {
  const all = [ring.primary, ...ring.previous];
  return all.map((k) => Buffer.from(k, 'base64')).filter((buf) => buf.length > 0);
}
