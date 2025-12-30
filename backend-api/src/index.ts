import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { db } from './database/db.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { filesRouter } from './routes/files.js';
import { partsRouter } from './routes/parts.js';
import { logsRouter } from './routes/logs.js';
import { changesRouter } from './routes/changes.js';
import { requireAuth, requirePermission } from './auth/middleware.js';
import { PermissionCode } from './auth/permissions.js';
import { permissions } from './database/schema.js';
import { errorHandler } from './middleware/errorHandler.js';

const app = express();
// За reverse-proxy (nginx / панель провайдера) важно корректно понимать X-Forwarded-* заголовки.
app.set('trust proxy', true);
app.use(cors());
// Согласовано с nginx client_max_body_size (см. /etc/nginx/conf.d/matricarmz-backend.conf).
app.use(express.json({ limit: '20mb' }));

app.use('/health', healthRouter);
app.use('/auth', authRouter);
app.use('/sync', requireAuth, requirePermission(PermissionCode.SyncUse), syncRouter);
app.use('/admin', adminUsersRouter);
app.use('/changes', changesRouter);
app.use('/files', filesRouter);
app.use('/parts', partsRouter);
app.use('/logs', logsRouter);

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
    console.error('[backend-api] permissions seed failed', e);
  });

  app.listen(port, host, () => {
    console.log(`[backend-api] listening on ${host}:${port}`);
  });
}

void bootstrap();


