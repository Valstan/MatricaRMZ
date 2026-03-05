import 'dotenv/config';
import { db } from './database/db.js';
import { PermissionCode } from './auth/permissions.js';
import { permissions } from './database/schema.js';
import { logError, logInfo } from './utils/logger.js';
import { startUpdateTorrentService } from './services/updateTorrentService.js';
import { startConsistencyDiagnostics } from './services/diagnosticsConsistencyService.js';
import { startAiAgentReportsScheduler } from './services/aiAgentReportsService.js';
import { startAiAgentChatLearningService } from './services/aiAgentChatLearningService.js';
import { startSyncPipelineSupervisorService } from './services/syncPipelineSupervisorService.js';
import { startAuditStatisticsScheduler } from './services/statisticsAuditService.js';
import { startCriticalEventsTelegramService } from './services/criticalEventsTelegramService.js';
import { ensureBaseMasterdata } from './services/baseMasterdataService.js';
import { ensureSyncSchemaGuard } from './services/sync/syncSchemaGuard.js';
import { createApp } from './app.js';

if (!process.env.TZ) {
  process.env.TZ = 'Europe/Moscow';
}

const app = createApp();

process.on('uncaughtException', (error) => {
  logError('backend uncaught exception', { error: String(error) });
});

process.on('unhandledRejection', (reason) => {
  logError('backend unhandled rejection', { error: String(reason) });
});

const port = Number(process.env.MATRICA_INSTANCE_PORT ?? process.env.PORT ?? 3001);
// По умолчанию слушаем только localhost и открываем наружу через nginx.
// Для отладки можно выставить HOST=0.0.0.0 (но лучше не делать в проде).
const host = process.env.HOST ?? '127.0.0.1';
const instanceRole = String(process.env.MATRICA_INSTANCE_ROLE ?? '').trim().toLowerCase();
const runBackgroundJobs = !['secondary', 'readonly', 'worker'].includes(instanceRole);

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
  await ensureBaseMasterdata().catch((e) => {
    logError('base masterdata seed failed', { error: String(e) });
  });
  await ensureSyncSchemaGuard().catch((e) => {
    logError('sync schema guard failed', { error: String(e) });
    throw e;
  });

  if (runBackgroundJobs) {
    startUpdateTorrentService();
  }
  const intervalMs = Number(process.env.MATRICA_DIAGNOSTICS_INTERVAL_MS ?? 600_000);
  if (runBackgroundJobs) {
    startConsistencyDiagnostics(Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 600_000);
  }
  const reportsEnabled = String(process.env.AI_REPORT_ENABLED ?? 'true').toLowerCase() === 'true';
  if (runBackgroundJobs && reportsEnabled) {
    startAiAgentReportsScheduler();
  }
  if (runBackgroundJobs) {
    startAuditStatisticsScheduler();
    startAiAgentChatLearningService();
    startSyncPipelineSupervisorService();
    startCriticalEventsTelegramService();
  }

  app.listen(port, host, () => {
    logInfo(`listening on ${host}:${port}`, { host, port }, { critical: true });
  });
}

void bootstrap();


