import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// clientId изначально жил только в settings внутри matricarmz.sqlite. Любая
// пересборка локальной БД (self-heal повреждённой базы, schema-rebuild после
// обновления) удаляла файл целиком — и клиент представлялся серверу НОВЫМ
// client_id. На сервере копились призрачные строки client_settings, а свежий
// призрак 10 минут «активен» рядом с новым id → ложное «логин активен на
// 2 машинах» (инцидент PC69 2026-07-27: старый id замолчал в 08:05:37,
// новый родился в 08:05:39).
//
// Sidecar-файл живёт в %APPDATA%\MatricaRMZ — той же папке, что watchdog
// handshake: её не трогают ни NSIS-инсталлер, ни пересборка userData-БД.
// Порядок чтения при старте: БД → sidecar → генерация; записываем всегда в оба.
function sidecarPath(): string {
  return join(app.getPath('appData'), 'MatricaRMZ', 'client-id.json');
}

export function readSidecarClientId(): string {
  try {
    const raw = readFileSync(sidecarPath(), 'utf8');
    const parsed = JSON.parse(raw) as { clientId?: unknown };
    const clientId = String(parsed?.clientId ?? '').trim();
    // Формат `<hostname>-<uuid>`; чужой мусор в файле не принимаем.
    return /^[\w.-]{1,64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)
      ? clientId
      : '';
  } catch {
    return '';
  }
}

export function writeSidecarClientId(clientId: string): void {
  const value = String(clientId ?? '').trim();
  if (!value) return;
  try {
    const target = sidecarPath();
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify({ clientId: value, updatedAtMs: Date.now() }, null, 2), 'utf8');
  } catch {
    // Best-effort: без sidecar клиент просто вернётся к прежнему поведению.
  }
}
