/**
 * Чтение секретов из комнаты КАРМАНА — на лету, из рантайма.
 *
 * Зачем: секреты бокса лежат в env (`/etc/matricarmz/matricarmz.env`), а комната —
 * наш «сейф» и источник правды. Скрипты умеют читать комнату сами (см.
 * `scripts/measureAnswer.ts`), но рантайм бэкенда брал секреты только из env, и
 * положить новый ключ в комнату было мало — его ещё надо было руками переписать в env
 * на боксе и перезапустить сервис. Здесь комната становится МЕСТОМ, откуда рантайм берёт
 * токен сам: положил в комнату — перезапустил сервис, и канал работает.
 *
 * Доступ у бокса к своей комнате — read-only (`SECRETS_TOKEN` + `SECRETS_VAULT_URL` в его
 * env). Писать комнату отсюда нельзя: право записи с бокса расширяет радиус поражения
 * без нужды (AGENTS.md §Prod server). Поэтому из рантайма комната только читается.
 */
import { logWarn } from '../utils/logger.js';

const FETCH_TIMEOUT_MS = 10_000;

/** Кэш: комната читается редко, но не на каждый запрос — токен не должен гоняться по сети. */
const cache = new Map<string, { value: string; at: number }>();
const CACHE_TTL_MS = 5 * 60_000;

function envText(name: string): string {
  return String(process.env[name] ?? '').trim();
}

function vaultUrl(): string | null {
  const value = envText('SECRETS_VAULT_URL');
  return value ? value.replace(/\/+$/, '') : null;
}

function vaultToken(): string | null {
  const value = envText('SECRETS_TOKEN');
  return value ? value : null;
}

/** Комната настроена (адрес и читающий токен на месте). */
export function isVaultConfigured(): boolean {
  return vaultUrl() !== null && vaultToken() !== null;
}

/**
 * Ключ из комнаты. Пустая строка — «ключа нет» (не ошибка): комната может быть не
 * настроена, и тогда канал просто молчит.
 */
export async function readVaultSecret(key: string): Promise<string | null> {
  const name = String(key ?? '').trim();
  if (!name) return null;
  const cached = cache.get(name);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value || null;

  const url = vaultUrl();
  const token = vaultToken();
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/api/secrets?key=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logWarn('комната КАРМАНА: секрет не прочитан', { key: name, status: res.status });
      return null;
    }
    const body = (await res.json().catch(() => null)) as { secrets?: Record<string, string> } | null;
    const value = String(body?.secrets?.[name] ?? '').trim();
    cache.set(name, { value, at: Date.now() });
    return value || null;
  } catch (e) {
    logWarn('комната КАРМАНА: недоступна', { key: name, error: String(e) });
    return null;
  }
}

/** Сбросить кэш (тесты, смена значения в комнате). */
export function resetVaultSecretCache(): void {
  cache.clear();
}
