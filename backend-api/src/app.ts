import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

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
import { enginesRouter } from './routes/engines.js';
import { maintenanceRouter } from './routes/maintenance.js';
import { checklistsRouter } from './routes/checklists.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { aiAgentRouter } from './routes/aiAgent.js';
import { searchRouter } from './routes/search.js';
import { ledgerRouter } from './routes/ledger.js';
import { notesRouter } from './routes/notes.js';
import { reportsRouter } from './routes/reports.js';
import { erpRouter } from './routes/erp.js';
import { warehouseRouter } from './routes/warehouse.js';
import { warehouseLocationsRouter } from './routes/warehouseLocations.js';
import { workOrdersRouter } from './routes/workOrders.js';
import { workOrderTemplatesRouter } from './routes/workOrderTemplates.js';
import { engineActTemplatesRouter } from './routes/engineActTemplates.js';
import { workOrderSignatureCaptionsRouter } from './routes/workOrderSignatureCaptions.js';
import { workshopsRouter } from './routes/workshops.js';
import { timesheetsRouter } from './routes/timesheets.js';
import { servicePricingRouter } from './routes/servicePricing.js';
import { noteStatisticsRequestActivity } from './services/statisticsAuditService.js';
import { requireAuth, requirePermission } from './auth/middleware.js';
import { PermissionCode } from './auth/permissions.js';
import { errorHandler } from './middleware/errorHandler.js';

/**
 * CORS allow-list. Электронный клиент не шлёт Origin, поэтому ему ничего не блокирует;
 * это защита от обращения с произвольных браузерных origin'ов.
 *
 * MATRICA_CORS_ORIGINS — CSV: 'https://admin.example.com,https://web.example.com'.
 * Пустое значение / отсутствие переменной = разрешать любой Origin (legacy-режим, для миграции).
 * '*' — явно разрешить все. Любое другое значение — строгий allow-list.
 */
function buildCorsMiddleware() {
  const raw = String(process.env.MATRICA_CORS_ORIGINS ?? '').trim();
  if (!raw || raw === '*') {
    return cors();
  }
  const allow = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  return cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allow.has(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin not allowed: ${origin}`));
    },
    credentials: true,
  });
}

/** Глобальный rate-limit. Электронный клиент шлёт много запросов, но в пределах разумного. */
const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.MATRICA_RATE_LIMIT_GLOBAL ?? 600),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
/**
 * Жёсткий rate-limit только для НЕаутентифицированных credential-эндпойнтов
 * (`/auth/login`, `/auth/register`) — защита от перебора пароля / спама регистраций.
 * НЕ навешивается на весь `/auth`: аутентифицированные частые вызовы (`/auth/me`,
 * `/auth/refresh`, `/auth/ui-*`, `/auth/profile`, `/auth/settings`) идут под общий
 * `globalLimiter`. Иначе за офисным NAT (один внешний IP на десятки клиентов)
 * поллинг `/auth/me` + refresh выжирал бюджет 30/15мин и давал шторм 429.
 */
const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: Number(process.env.MATRICA_RATE_LIMIT_AUTH ?? 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many auth attempts, please slow down.' },
});
/**
 * Dedicated, looser limiter for the unauthenticated login typeahead
 * (`/auth/login-suggest`). NOT under `authLimiter` (30/15min) — that budget is
 * for credential attempts; a per-keystroke (debounced) typeahead behind office
 * NAT would exhaust it and 429 real logins. 60/min per IP is ample for a
 * debounced, min-2-char suggest and still throttles bulk enumeration.
 */
const suggestLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.MATRICA_RATE_LIMIT_SUGGEST ?? 60),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { ok: false, error: 'Too many suggest requests, please slow down.' },
});

export function createApp() {
  const app = express();
  // За reverse-proxy nginx (1 hop) корректно читаем X-Forwarded-*.
  // Значение `true` слишком разрешительно: позволяет любому источнику подделать X-Forwarded-For
  // и обойти rate-limit, поэтому фиксируем число прокси (configurable через ENV для нестандартных схем).
  const trustProxyHops = Number(process.env.MATRICA_TRUST_PROXY_HOPS ?? 1);
  app.set('trust proxy', Number.isFinite(trustProxyHops) && trustProxyHops >= 0 ? trustProxyHops : 1);
  // Helmet: безопасные HTTP-заголовки. HSTS на 1 год (мы за HTTPS через nginx),
  // CSP отключаем — есть статический /admin-ui SPA, который ломается жёсткими дефолтами,
  // включим её отдельным шагом в report-only режиме после ручной проверки.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: false },
    }),
  );
  app.use(buildCorsMiddleware());
  app.use(globalLimiter);
  // Согласовано с nginx client_max_body_size (см. /etc/nginx/conf.d/matricarmz-backend.conf).
  // Лимит выставлен глобально под крупные ledger / files эндпойнты; роуты с мелкими телами не страдают.
  app.use(express.json({ limit: '20mb' }));
  app.use((_req, _res, next) => {
    noteStatisticsRequestActivity();
    next();
  });

  app.use('/health', healthRouter);
  // Строгий лимитер — только на credential-эндпойнты (см. коммент к authLimiter).
  app.use('/auth/login', authLimiter);
  app.use('/auth/register', authLimiter);
  app.use('/auth/login-suggest', suggestLimiter);
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
  app.use('/engines', enginesRouter);
  app.use('/maintenance', maintenanceRouter);
  app.use('/checklists', checklistsRouter);
  app.use('/diagnostics', diagnosticsRouter);
  app.use('/ai', aiAgentRouter);
  app.use('/reports', requireAuth, requirePermission(PermissionCode.ReportsView), reportsRouter);
  app.use('/erp', erpRouter);
  app.use('/warehouse', warehouseRouter);
  app.use('/search', requireAuth, searchRouter);
  app.use('/work-orders', workOrdersRouter);
  app.use('/work-order-templates', workOrderTemplatesRouter);
  app.use('/engine-act-templates', engineActTemplatesRouter);
  app.use('/work-order-signature-captions', workOrderSignatureCaptionsRouter);
  app.use('/workshops', workshopsRouter);
  app.use('/timesheets', timesheetsRouter);
  app.use('/warehouse-locations', warehouseLocationsRouter);
  app.use('/service-pricing', servicePricingRouter);

  // Web admin UI (served as static SPA from /admin-ui)
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webAdminDir = path.resolve(__dirname, '../../web-admin/dist');
  if (existsSync(webAdminDir)) {
    // CSP только для /admin-ui (vite-сборка без inline-скриптов; 'unsafe-inline' —
    // для style-атрибутов React). API-ответы CSP не несут — их читают Electron/скрипты,
    // а глобальная CSP в helmet выключена именно из-за этой SPA (см. createApp выше).
    const adminUiCsp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ].join('; ');
    app.use('/admin-ui', (_req, res, next) => {
      res.setHeader('Content-Security-Policy', adminUiCsp);
      next();
    });
    app.use('/admin-ui', express.static(webAdminDir));
    app.get('/admin-ui/*', (_req, res) => {
      res.sendFile(path.join(webAdminDir, 'index.html'));
    });
  }

  // Must be last: centralized error handler.
  app.use(errorHandler);
  return app;
}
