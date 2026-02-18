import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import cors from 'cors';

import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { syncRouter } from './routes/sync.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { adminAuditRouter } from './routes/adminAudit.js';
import { adminMasterdataRouter } from './routes/adminMasterdata.js';
import { chatRouter } from './routes/chat.js';
import { presenceRouter } from './routes/presence.js';
import { filesRouter } from './routes/files.js';
import { partsRouter } from './routes/parts.js';
import { logsRouter } from './routes/logs.js';
import { changesRouter } from './routes/changes.js';
import { backupsRouter } from './routes/backups.js';
import { updatesRouter } from './routes/updates.js';
import { clientSettingsRouter } from './routes/clientSettings.js';
import { adminClientsRouter } from './routes/adminClients.js';
import { employeesRouter } from './routes/employees.js';
import { checklistsRouter } from './routes/checklists.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { aiAgentRouter } from './routes/aiAgent.js';
import { ledgerRouter } from './routes/ledger.js';
import { notesRouter } from './routes/notes.js';
import { reportsRouter } from './routes/reports.js';
import { erpRouter } from './routes/erp.js';
import { noteStatisticsRequestActivity } from './services/statisticsAuditService.js';
import { requireAuth, requirePermission } from './auth/middleware.js';
import { PermissionCode } from './auth/permissions.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  // За reverse-proxy (nginx / панель провайдера) важно корректно понимать X-Forwarded-* заголовки.
  app.set('trust proxy', true);
  app.use(cors());
  // Согласовано с nginx client_max_body_size (см. /etc/nginx/conf.d/matricarmz-backend.conf).
  app.use(express.json({ limit: '20mb' }));
  app.use((_req, _res, next) => {
    noteStatisticsRequestActivity();
    next();
  });

  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/sync', requireAuth, requirePermission(PermissionCode.SyncUse), syncRouter);
  app.use('/ledger', requireAuth, requirePermission(PermissionCode.SyncUse), ledgerRouter);
  app.use('/chat', requireAuth, requirePermission(PermissionCode.ChatUse), chatRouter);
  app.use('/notes', notesRouter);
  app.use('/presence', presenceRouter);
  app.use('/admin', adminUsersRouter);
  app.use('/admin', adminClientsRouter);
  app.use('/admin/audit', adminAuditRouter);
  app.use('/admin/masterdata', adminMasterdataRouter);
  app.use('/changes', changesRouter);
  app.use('/files', filesRouter);
  app.use('/parts', partsRouter);
  app.use('/logs', logsRouter);
  app.use('/backups', backupsRouter);
  app.use('/updates', updatesRouter);
  app.use('/client', clientSettingsRouter);
  app.use('/employees', employeesRouter);
  app.use('/checklists', checklistsRouter);
  app.use('/diagnostics', diagnosticsRouter);
  app.use('/ai', aiAgentRouter);
  app.use('/reports', requireAuth, requirePermission(PermissionCode.ReportsView), reportsRouter);
  app.use('/erp', erpRouter);

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
  return app;
}
