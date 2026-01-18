import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import cors from 'cors';

import { db } from './database/db.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { adminMasterdataRouter } from './routes/adminMasterdata.js';
import { chatRouter } from './routes/chat.js';
import { presenceRouter } from './routes/presence.js';
import { filesRouter } from './routes/files.js';
import { partsRouter } from './routes/parts.js';
import { logsRouter } from './routes/logs.js';
import { changesRouter } from './routes/changes.js';
import { backupsRouter } from './routes/backups.js';
import { requireAuth, requirePermission } from './auth/middleware.js';
import { PermissionCode } from './auth/permissions.js';
import { permissions } from './database/schema.js';
import { errorHandler } from './middleware/errorHandler.js';
import { logError, logInfo } from './utils/logger.js';

const app = express();
// За reverse-proxy (nginx / панель провайдера) важно корректно понимать X-Forwarded-* заголовки.
app.set('trust proxy', true);
app.use(cors());
// Согласовано с nginx client_max_body_size (см. /etc/nginx/conf.d/matricarmz-backend.conf).
app.use(express.json({ limit: '20mb' }));

app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/sync', requireAuth, requirePermission(PermissionCode.SyncUse), syncRouter);
app.use('/chat', requireAuth, requirePermission(PermissionCode.ChatUse), chatRouter);
app.use('/presence', presenceRouter);
app.use('/admin', adminUsersRouter);
app.use('/admin/masterdata', adminMasterdataRouter);
app.use('/changes', changesRouter);
app.use('/files', filesRouter);
app.use('/parts', partsRouter);
app.use('/logs', logsRouter);
app.use('/backups', backupsRouter);

// Web admin UI (served as static SPA from /admin-ui)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webAdminDir = path.resolve(__dirname, '../../web-admin/dist');
if (existsSync(webAdminDir)) {
  app.use('/admin-ui', express.static(webAdminDir));
  app.get('/admin-ui/*', (_req, res) => {
    res.sendFile(path.join(webAdminDir, 'index.html'));
  });
}

// Must be last: centralized error handler.
app.use(errorHandler);

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

  app.listen(port, host, () => {
    logInfo(`listening on ${host}:${port}`, { host, port }, { critical: true });
  });
}

void bootstrap();


