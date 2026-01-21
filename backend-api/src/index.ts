import 'dotenv/config';
import { db } from './database/db.js';
import { PermissionCode } from './auth/permissions.js';
import { permissions } from './database/schema.js';
import { logError, logInfo } from './utils/logger.js';
import { startUpdateTorrentService } from './services/updateTorrentService.js';
import { createApp } from './app.js';

const app = createApp();

const port = Number(process.env.PORT ?? 3001);
// По умолчанию слушаем только localhost и открываем наружу через nginx.
// Для отладки можно выставить HOST=0.0.0.0 (но лучше не делать в проде).
const host = process.env.HOST ?? '127.0.0.1';

async function ensurePermissionsSeeded() {
  const ts = Date.now();
  const codes = Object.values(PermissionCode);
  if (codes.length === 0) return;
  await db
    .insert(permissions)
    .values(codes.map((code) => ({ code, description: code, createdAt: ts })))
    .onConflictDoNothing();
}

async function bootstrap() {
  await ensurePermissionsSeeded().catch((e) => {
    logError('permissions seed failed', { error: String(e) });
  });

  startUpdateTorrentService();

  app.listen(port, host, () => {
    logInfo(`listening on ${host}:${port}`, { host, port }, { critical: true });
  });
}

void bootstrap();


