// Ф2: настоящий мост window.matrica поверх портированного ядра. Вместо ручной
// реализации ~100 методов реюзаем НАСТОЯЩИЕ ipc/register/*-модули и preload
// Electron-клиента: электрон-шим даёт in-process ipcMain/ipcRenderer-шину, здесь
// собирается IpcContext и регистрируются домены android-рамки (план
// docs/plans/android-tablet-client-2026-08.md, Ф2). Домены вне рамки (файлы,
// печать, чат, AI, отчёты, бэкапы) не регистрируются — их каналы отвечают
// мягким «недоступно на планшете» (см. ipcRenderer.invoke в шиме).
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { ipcMain } from 'electron';

import { getSession } from '../../../electron-app/src/main/services/authService.js';
import type { IpcContext } from '../../../electron-app/src/main/ipc/ipcContext.js';
import { installSectionIpcGate } from '../../../electron-app/src/main/ipc/sectionGate.js';
import { registerAdminIpc } from '../../../electron-app/src/main/ipc/register/admin.js';
import { registerAuthAndSyncIpc } from '../../../electron-app/src/main/ipc/register/authAndSync.js';
import { registerChangesIpc } from '../../../electron-app/src/main/ipc/register/changes.js';
import { registerChecklistsIpc } from '../../../electron-app/src/main/ipc/register/checklists.js';
import { registerDraftsIpc } from '../../../electron-app/src/main/ipc/register/drafts.js';
import { registerEmployeesIpc } from '../../../electron-app/src/main/ipc/register/employees.js';
import { registerEngineActTemplatesIpc } from '../../../electron-app/src/main/ipc/register/engineActTemplates.js';
import { registerEnginesOpsAuditIpc } from '../../../electron-app/src/main/ipc/register/enginesOpsAudit.js';
import { registerErpIpc } from '../../../electron-app/src/main/ipc/register/erp.js';
import { registerLoggingIpc } from '../../../electron-app/src/main/ipc/register/logging.js';
import { registerNotesIpc } from '../../../electron-app/src/main/ipc/register/notes.js';
import { registerPartsIpc } from '../../../electron-app/src/main/ipc/register/parts.js';
import { registerSettingsIpc } from '../../../electron-app/src/main/ipc/register/settings.js';
import { registerSupplyRequestsIpc } from '../../../electron-app/src/main/ipc/register/supplyRequests.js';
import { registerWarehouseLocationsIpc } from '../../../electron-app/src/main/ipc/register/warehouseLocations.js';
import { registerWorkOrderSignatureCaptionsIpc } from '../../../electron-app/src/main/ipc/register/workOrderSignatureCaptions.js';
import { registerWorkOrderTemplatesIpc } from '../../../electron-app/src/main/ipc/register/workOrderTemplates.js';
import { registerWorkOrdersIpc } from '../../../electron-app/src/main/ipc/register/workOrders.js';
import { registerWorkshopsIpc } from '../../../electron-app/src/main/ipc/register/workshops.js';

import { getAndroidPlatformHooks } from '../shims/platform.js';
import type { AndroidCore } from './boot.js';

export function wireIpcForAndroid(core: AndroidCore): IpcContext {
  const db = core.serviceDb;

  async function currentActor(): Promise<string> {
    const s = await getSession(db).catch(() => null);
    const u = s?.user?.username;
    return u && u.trim() ? u.trim() : 'local';
  }

  async function currentViewer(): Promise<{ login: string; role: string }> {
    const s = await getSession(db).catch(() => null);
    return { login: String(s?.user?.username ?? '').trim(), role: String(s?.user?.role ?? '').trim() };
  }

  // Та же admin-поправка, что в десктопном registerIpc: backend шлёт только
  // masterdata.view — карточки админа должны оставаться редактируемыми.
  async function currentPermissions(): Promise<Record<string, boolean>> {
    const s = await getSession(db).catch(() => null);
    const perms = { ...((s?.permissions ?? {}) as Record<string, boolean>) };
    const role = String(s?.user?.role ?? '').trim().toLowerCase();
    if ((role === 'admin' || role === 'superadmin') && perms['masterdata.view'] === true) {
      perms['masterdata.edit'] = true;
    }
    return perms;
  }

  const ctx: IpcContext = {
    sysDb: db,
    dataDb: (): BetterSQLite3Database => db, // режима «просмотр бэкапа» на планшете нет
    mode: () => ({ mode: 'live' as const }),
    mgr: core.syncManager,
    logToFile: (message: string) => console.info(`[android-main] ${message}`),
    currentActor,
    currentViewer,
    currentPermissions,
  };

  const restoreIpcHandle = installSectionIpcGate(ctx);
  registerLoggingIpc(ctx);
  registerAuthAndSyncIpc(ctx);
  registerChangesIpc(ctx);
  registerEnginesOpsAuditIpc(ctx);
  registerDraftsIpc(ctx);
  registerEmployeesIpc(ctx);
  registerAdminIpc(ctx);
  registerChecklistsIpc(ctx);
  registerEngineActTemplatesIpc(ctx);
  registerWorkshopsIpc(ctx);
  registerSupplyRequestsIpc(ctx);
  // Ф3 — наряды и склад. Локально-офлайн: workOrderService (локальная БД) и
  // складские документы (warehouseCommandOutbox). Сборочные действия
  // (issue/post/close) и справочники шаблонов/подписей ходят по HTTP — на
  // планшете это штатный «нужна сеть», как на десктопе.
  registerWorkOrdersIpc(ctx);
  registerWorkOrderTemplatesIpc(ctx);
  registerWorkOrderSignatureCaptionsIpc(ctx);
  registerWarehouseLocationsIpc(ctx);
  registerSettingsIpc(ctx);
  registerNotesIpc(ctx);
  registerPartsIpc(ctx);
  registerErpIpc(ctx);
  restoreIpcHandle();

  // Каналы, живущие в electron-app/src/main/index.ts (не портируется целиком).
  ipcMain.handle('app:ping', async () => 'pong');
  ipcMain.handle('app:version', async () => getAndroidPlatformHooks().appVersion());

  return ctx;
}

/**
 * Полная установка моста: регистрация хэндлеров + настоящий preload
 * (contextBridge-шим кладёт window.matrica). Порядок обязателен — preload
 * исполняется на импорте и должен видеть готовую шину только в момент вызовов,
 * но wiring до него держит инварианты простыми.
 */
export async function installAndroidBridge(core: AndroidCore): Promise<IpcContext> {
  const ctx = wireIpcForAndroid(core);
  await import('../../../electron-app/src/preload/index.js');
  return ctx;
}
