import { app } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Сессия изначально жила только в settings внутри matricarmz.sqlite. Любая
// пересборка локальной БД (self-heal, schema-rebuild) удаляла файл целиком — и
// оператор оказывался разлогинен, хотя его refresh-токен на сервере оставался
// валидным. Sidecar живёт в %APPDATA%\MatricaRMZ (та же папка, что client-id.json
// и watchdog handshake): её не трогают ни NSIS-инсталлер, ни пересборка userData-БД.
//
// В sidecar кладётся ТОЛЬКО зашифрованный DPAPI/safeStorage payload (StoredSession
// с enc:true) — тот же формат, что в БД. На машинах без safeStorage сессия
// по-прежнему живёт только в памяти процесса (fail-closed, см. authService).
// Порядок чтения: БД → sidecar; запись — в оба; явный logout чистит оба.

type SidecarSession = {
  enc: true;
  data: string; // encrypted hex (safeStorage)
  updatedAtMs?: number;
};

function sidecarPath(): string {
  return join(app.getPath('appData'), 'MatricaRMZ', 'auth-session.json');
}

export function readSidecarSession(): { enc: true; data: string } | null {
  try {
    const raw = readFileSync(sidecarPath(), 'utf8');
    const parsed = JSON.parse(raw) as SidecarSession | null;
    if (!parsed || parsed.enc !== true || typeof parsed.data !== 'string' || !parsed.data) return null;
    if (!/^[0-9a-f]+$/i.test(parsed.data)) return null;
    return { enc: true, data: parsed.data };
  } catch {
    return null;
  }
}

export function writeSidecarSession(stored: { enc: boolean; data: string }): void {
  // Never persist a plaintext session to disk — encrypted payloads only.
  if (stored.enc !== true || !stored.data) return;
  try {
    const target = sidecarPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ enc: true, data: stored.data, updatedAtMs: Date.now() }, null, 2), 'utf8');
  } catch {
    // Best-effort: без sidecar клиент просто вернётся к прежнему поведению
    // («пересборка БД = повторный вход»).
  }
}

export function clearSidecarSession(): void {
  try {
    rmSync(sidecarPath(), { force: true });
  } catch {
    // ignore
  }
}
