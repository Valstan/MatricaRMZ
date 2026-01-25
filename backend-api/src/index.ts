import 'dotenv/config';
import { db } from './database/db.js';
import { PermissionCode } from './auth/permissions.js';
import { permissions } from './database/schema.js';
import { logError, logInfo } from './utils/logger.js';
import { startUpdateTorrentService } from './services/updateTorrentService.js';
import { startConsistencyDiagnostics } from './services/diagnosticsConsistencyService.js';
import { startAiAgentReportsScheduler } from './services/aiAgentReportsService.js';
import { startAiAgentChatLearningService } from './services/aiAgentChatLearningService.js';
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
  const intervalMs = Number(process.env.MATRICA_DIAGNOSTICS_INTERVAL_MS ?? 600_000);
  startConsistencyDiagnostics(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 600_000);
  const reportsEnabled = String(process.env.AI_REPORT_ENABLED ?? 'true').toLowerCase() === 'true';
  if (reportsEnabled) {
    startAiAgentReportsScheduler();
  }
  startAiAgentChatLearningService();

  app.listen(port, host, () => {
    logInfo(`listening on ${host}:${port}`, { host, port }, { critical: true });
  });
}

void bootstrap();


