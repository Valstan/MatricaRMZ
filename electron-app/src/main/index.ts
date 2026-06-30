import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import type { ChatDeepLinkPayload } from '@matricarmz/shared';

if (!process.env.TZ) {
  process.env.TZ = 'Europe/Moscow';
}

// Важно: НЕ импортируем SQLite/IPC сервисы на верхнем уровне.
// На Windows native-модуль (better-sqlite3) может падать при загрузке,
// из-за чего приложение не успевает создать окно/лог.
// Загружаем их динамически после app.whenReady().
import { initNetworkService } from './services/networkService.js';
import {
  applyPendingUpdateIfAny,
  configureUpdateService,
  initAutoUpdate,
  recoverStuckUpdateState,
  runAutoUpdateFlow,
  runUpdateHelperFlow,
  simulateUpdateUiForDev,
  startBackgroundUpdatePolling,
} from './services/updateService.js';
import { applyRemoteClientSettings, getCachedClientSettings, setReportedActivity } from './services/clientAdminService.js';
import { isSameMigrationFailure } from './services/dbSelfHealLoopDetector.js';
import { tryEmergencyUpdate } from './services/emergencyUpdate.js';
import { appDirname, resolvePreloadPath, resolveRendererIndex } from './utils/appPaths.js';
import { createFileLogger } from './utils/logger.js';
import { setupMenu } from './utils/menu.js';
import { registerInputContextMenu } from './utils/contextMenu.js';

let mainWindow: BrowserWindow | null = null;
let mainWindowReady = false;
let allowMainWindowShow = false;
let forceQuit = false;
let writeSessionAuditEvent:
  | ((action: 'app.session.start' | 'app.session.stop') => Promise<void>)
  | null = null;
let stopAuditWritten = false;
const APP_TITLE = () => `Матрица РМЗ v${app.getVersion()}`;

const { logToFile, getLogPath } = createFileLogger(app);
const baseDir = appDirname(import.meta.url);

// Headless/CDP verification hook (verifier-electron skill, used by /verify):
// when MATRICA_CDP_PORT is set we expose the Chrome DevTools Protocol so the
// renderer can be driven without computer-use. Command-line switches are read
// once at startup, so this MUST run before the `ready` event (it does — this is
// top-level module code). No-op when the var is unset, so prod (whose .env never
// defines MATRICA_CDP_PORT) is completely unaffected.
const cdpPort = process.env.MATRICA_CDP_PORT?.trim();
if (cdpPort && app.isPackaged) {
  // Defense-in-depth: the CDP remote-debugging port must NEVER open in a packaged
  // (production) build, even if MATRICA_CDP_PORT somehow leaks into the prod
  // environment. The /verify flow runs an UNPACKAGED dev build (app.isPackaged ===
  // false), so it stays on the enabling branch below; a prod .exe ignores the var.
  logToFile(`CDP requested via MATRICA_CDP_PORT=${cdpPort} but IGNORED in packaged build (security)`);
} else if (cdpPort) {
  app.commandLine.appendSwitch('remote-debugging-port', cdpPort);
  // Permit the local ws driver to attach to the DevTools endpoint.
  app.commandLine.appendSwitch('remote-allow-origins', '*');
  // Isolate userData for the CDP/dev verifier instance, keyed by port. Without this
  // the dev instance shares %APPDATA%\@matricarmz\electron-app with an installed prod
  // client, which causes two verifier-rot failures: (1) requestSingleInstanceLock
  // collides → the dev instance self-quits or relaunches mid-run; (2) the prod client's
  // periodic auth sync rewrites the shared AuthSession with a prod user whose perms can
  // lack codes the verify user needs (e.g. engines.view), so the IPC guard denies the
  // freshly-logged-in verify session. A dedicated userData dir makes the verify login
  // authoritative and removes the single-instance contention. setPath must run before
  // app.whenReady / requestSingleInstanceLock — it does (top-level module code).
  const isolatedUserData = `${app.getPath('userData')}-cdp-${cdpPort}`;
  app.setPath('userData', isolatedUserData);
  logToFile(`CDP enabled: remote-debugging-port=${cdpPort}, isolated userData=${isolatedUserData}`);
}

export function setForceQuit(value: boolean) {
  forceQuit = value;
}

function maybeShowMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindowReady || !allowMainWindowShow) return;
  mainWindow.maximize();
  mainWindow.show();
}

function scheduleShowMainWindow(delayMs = 0) {
  setTimeout(() => {
    allowMainWindowShow = true;
    maybeShowMainWindow();
  }, delayMs);
}

// Security: the renderer only ever legitimately loads our own origin — the dev
// vite URL (http://127.0.0.1:5173) in development, or a packaged file:// document
// in production. Any attempt to navigate the main window elsewhere, or to open a
// new in-app window, is treated as hostile (compromised renderer / injected link)
// and blocked; legitimate external links are routed to the OS browser instead.
function safeOrigin(u: string): string | null {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

function isAppNavigation(url: string, appOrigin: string | null): boolean {
  try {
    const t = new URL(url);
    if (t.protocol === 'file:') return true; // packaged renderer document
    if (appOrigin && t.origin === appOrigin) return true; // dev vite origin
    return false;
  } catch {
    return false;
  }
}

function openExternalIfSafe(url: string): void {
  try {
    const p = new URL(url).protocol;
    if (p === 'http:' || p === 'https:' || p === 'mailto:') void shell.openExternal(url);
  } catch {
    // ignore malformed url
  }
}

function installNavigationGuards(win: BrowserWindow): void {
  const appOrigin = process.env.ELECTRON_RENDERER_URL ? safeOrigin(process.env.ELECTRON_RENDERER_URL) : null;
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The print/preview feature opens a blank same-process popup via
    // window.open('', '_blank') and writes its HTML into the returned handle — allow
    // those (url is '' / 'about:blank'). The child inherits the main window's locked
    // webPreferences (contextIsolation on, nodeIntegration off).
    if (url === '' || url === 'about:blank') return { action: 'allow' };
    // Any real URL is an external target: open it in the OS browser if safe, and
    // never spawn an in-app window for it.
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  // Block navigation away from our own origin; open safe external targets externally.
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppNavigation(url, appOrigin)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  });
}

function createWindow(): void {
  const preloadPath = resolvePreloadPath(baseDir);
  const rendererIndex = resolveRendererIndex(baseDir);

  logToFile(`createWindow: preload=${preloadPath}`);
  logToFile(`createWindow: renderer=${rendererIndex}`);

  // In a packaged build the window inherits the executable's icon (set via
  // electron-builder `win.icon`). In dev there is no packaged exe, so point the
  // window at the committed icon directly for taskbar/title-bar parity.
  const devWindowIcon = process.env.ELECTRON_RENDERER_URL ? join(app.getAppPath(), 'build', 'icon.ico') : undefined;
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_TITLE(),
    ...(devWindowIcon ? { icon: devWindowIcon } : {}),
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      // В sandbox режиме preload требует CommonJS. Явно отключаем sandbox для стабильности.
      sandbox: false,
      nodeIntegration: false,
    },
  });
  registerInputContextMenu(mainWindow);
  installNavigationGuards(mainWindow);

  // Не даём web-странице менять title — фиксируем заголовок окна.
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow?.setTitle(APP_TITLE());
  });

  // electron-vite 2.x выставляет переменную ELECTRON_RENDERER_URL в dev режиме.
  const devUrl = process.env.ELECTRON_RENDERER_URL;

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(rendererIndex);
  }

  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const href = mainWindow?.webContents.getURL() ?? '';
      logToFile(`renderer did-finish-load: href=${href}`);
    } catch (e) {
      logToFile(`renderer did-finish-load inspect failed: ${String(e)}`);
    }
  });

  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    logToFile(`renderer console[level=${level}] ${message} (line=${line} src=${sourceId})`);
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    logToFile(`renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on('preload-error', (_e, preloadPath, error) => {
    logToFile(`preload-error: path=${preloadPath} err=${String(error)}`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindowReady = true;
    maybeShowMainWindow();
  });

  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.focus();
    }
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logToFile(`did-fail-load: code=${code} desc=${desc} url=${url}`);
    void dialog.showMessageBox(mainWindow!, {
      type: 'error',
      title: 'Ошибка запуска',
      message: 'Не удалось загрузить интерфейс приложения.',
      detail: `code=${code}\n${desc}\n${url}\n\nЛог: ${getLogPath()}`,
    });
  });

  mainWindow.on('close', (event) => {
    if (forceQuit) return;
    event.preventDefault();
    mainWindow?.webContents.send('app:close-request');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getArgValue(argv: string[], key: string) {
  const idx = argv.indexOf(key);
  if (idx < 0) return null;
  return argv[idx + 1] ?? null;
}

function getUpdateHelperArgs(argv: string[]) {
  if (!argv.includes('--update-helper')) return null;
  const installerPath = getArgValue(argv, '--installer');
  const launchPath = getArgValue(argv, '--launch');
  if (!installerPath || !launchPath) return null;
  const version = getArgValue(argv, '--version') ?? undefined;
  const parentPidRaw = getArgValue(argv, '--parent-pid');
  const parentPid = parentPidRaw ? Number.parseInt(parentPidRaw, 10) : undefined;
  return { installerPath, launchPath, version, parentPid };
}

app.whenReady().then(() => {
  // Логи Chromium/Electron в stderr (в Windows можно потом смотреть через event viewer / debug tools).
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('v', '1');

  // Network bootstrap: proxy/PAC + ipv4first + online monitor.
  const apiBaseUrl = process.env.MATRICA_API_URL ?? 'https://a6fd55b8e0ae.vps.myjino.ru';
  void initNetworkService({ probeUrl: `${apiBaseUrl.replace(/\/+$/, '')}/health` });

  initAutoUpdate();
  process.on('uncaughtException', (e) => logToFile(`uncaughtException: ${String(e)}`));
  process.on('unhandledRejection', (e) => logToFile(`unhandledRejection: ${String(e)}`));
  setupMenu();

  const helperArgs = getUpdateHelperArgs(process.argv);
  if (helperArgs) {
    void runUpdateHelperFlow(helperArgs as any);
    return;
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Security: clear any plaintext full-DB backup snapshots left in userData from a
  // prior session that exited while viewing a backup (stolen-laptop hygiene). Only
  // the primary instance runs this, after acquiring the single-instance lock.
  void import('./services/backupService.js')
    .then(({ sweepBackupCache }) => sweepBackupCache(app.getPath('userData')))
    .catch((e) => logToFile(`backup cache sweep failed: ${String(e)}`));

  // По умолчанию — адрес вашего VPS (чтобы Windows-клиент сразу мог синхронизироваться).
  // Можно переопределить переменной окружения MATRICА_API_URL при запуске.
  // В проде обычно ходим через reverse-proxy (nginx) на 80/443, поэтому порт 3001 не указываем.
  // apiBaseUrl defined above for network/bootstrap and IPC.

  // Инициализируем SQLite + IPC асинхронно (до создания окна).
  void (async () => {
    try {
      const { loadRuntimeInitDeps } = await import('./bootstrap/runtimeInitDeps.js');
      const {
        alignSchemaWithServer,
        getSqliteHandle,
        openSqlite,
        migrateSqlite,
        seedIfNeeded,
        registerIpc,
        SettingsKey,
        settingsGetString,
        settingsSetString,
        getSession,
        addAudit,
      } = loadRuntimeInitDeps();

      const userData = app.getPath('userData');
      mkdirSync(userData, { recursive: true });
      const dbPath = join(userData, 'matricarmz.sqlite');
      let dbRecovered = false;

      const openMigrateSeed = async () => {
        const opened = openSqlite(dbPath);
        const migrationsFolder = join(app.getAppPath(), 'drizzle');
        logToFile(`sqlite migrationsFolder=${migrationsFolder}`);
        migrateSqlite(opened.db, opened.sqlite, migrationsFolder);
        const alignResult = await alignSchemaWithServer(opened.db, apiBaseUrl, { allowUnauthenticated: true }).catch(
          (e) => ({ ok: false as const, reason: String(e) }),
        );
        if (!alignResult.ok && alignResult.reason !== 'auth_required') {
          logToFile(`schema align before seed skipped: ${alignResult.reason}`);
        }
        await seedIfNeeded(opened.db);
        return opened.db;
      };

      let db!: Awaited<ReturnType<typeof openMigrateSeed>>;
      try {
        db = await openMigrateSeed();
      } catch (initError) {
        logToFile(`sqlite init failed, attempting self-heal: ${String(initError)}`);

        try {
          const broken = getSqliteHandle();
          if (broken) {
            try {
              broken.pragma('wal_checkpoint(TRUNCATE)');
            } catch {
              logToFile('failed to checkpoint WAL during db recovery');
            }
            try {
              broken.close();
            } catch {
              logToFile('failed to close broken db handle during recovery');
            }
          }
        } catch {
          logToFile('failed to load or close existing sqlite handle during recovery');
        }

        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        for (const suffix of ['', '-wal', '-shm']) {
          await rename(`${dbPath}${suffix}`, `${dbPath}${suffix}.corrupted-${ts}`).catch(() => {});
        }
        await rm(join(userData, 'ledger'), { recursive: true, force: true }).catch(() => {});
        await rm(join(userData, 'ledger-client-key.json'), { force: true }).catch(() => {});
        logToFile(`corrupted db backed up (.corrupted-${ts})`);

        try {
          db = await openMigrateSeed();
          dbRecovered = true;
          logToFile('DB self-heal succeeded — fresh database created');
          await dialog.showMessageBox({
            type: 'warning',
            title: 'База данных восстановлена',
            message: 'Локальная база данных была повреждена и автоматически пересоздана.',
            detail:
              'Пожалуйста, войдите в систему.\n' +
              'Данные будут загружены с сервера при синхронизации.\n\n' +
              'Резервная копия повреждённой базы сохранена в папке приложения.',
          });
        } catch (retryError) {
          logToFile(`DB self-heal failed: ${String(retryError)}`);

          // Loop detection: if the SAME migration failed on a fresh empty DB,
          // there is nothing self-heal can do — the migration is structurally
          // broken on this version. The only recovery is to install a newer
          // release that ships a fixed migration. Try to do that automatically
          // before giving up.
          if (isSameMigrationFailure(initError, retryError)) {
            logToFile(
              'DB self-heal LOOP detected (same migration failed twice on fresh DB) — entering emergency update mode',
            );
            const emergency = await tryEmergencyUpdate({
              apiBaseUrl,
              currentVersion: app.getVersion(),
              onLog: (line) => logToFile(line),
            });
            if (emergency.launched) {
              logToFile(`emergency installer launched (version=${emergency.version}); quitting`);
              setForceQuit(true);
              app.quit();
              return;
            }
            logToFile(`emergency update did not run: ${emergency.reason}`);
            await dialog.showMessageBox({
              type: 'error',
              title: 'Критическая ошибка базы данных',
              message:
                'Локальная база данных не может быть инициализирована: миграция повторно упала на пустой базе. ' +
                'Это значит, что в установленной версии клиента миграция структурно битая.',
              detail:
                `Автоматическая попытка скачать и установить более свежий релиз не удалась: ${emergency.reason}\n\n` +
                'Что делать:\n' +
                '1) Скачайте и установите свежую версию клиента вручную с сервера обновлений.\n' +
                '2) Если на сервере ещё нет фикса — обратитесь к администратору.\n\n' +
                `Исходная ошибка: ${String(initError)}\n` +
                `Лог: ${getLogPath()}`,
            });
            app.quit();
            return;
          }

          await dialog.showMessageBox({
            type: 'error',
            title: 'Ошибка базы данных',
            message: 'Не удалось инициализировать базу данных.\nАвтоматическое восстановление не помогло.',
            detail:
              `Исходная ошибка: ${String(initError)}\n` +
              `Повторная ошибка: ${String(retryError)}\n\n` +
              `Лог: ${getLogPath()}`,
          });
          app.quit();
          return;
        }
      }

      // Стабильный clientId (один раз на рабочее место): нужен для корректного sync_state на сервере и диагностики.
      if (dbRecovered) {
        logToFile('database recovered on startup; startup sync may repopulate data');
      }
      let stableClientId = (await settingsGetString(db, SettingsKey.ClientId).catch(() => null)) ?? '';
      stableClientId = String(stableClientId).trim();
      if (!stableClientId) {
        const prefix = String(process.env.COMPUTERNAME ?? 'pc').trim() || 'pc';
        stableClientId = `${prefix}-${randomUUID()}`;
        await settingsSetString(db, SettingsKey.ClientId, stableClientId).catch(() => {});
        logToFile(`generated stable clientId=${stableClientId}`);
      }

      writeSessionAuditEvent = async (action) => {
        try {
          const session = await getSession(db);
          const actor = String(session?.user?.username ?? '').trim();
          if (!actor) return;
          await addAudit(db, {
            actor,
            action,
            payload: {
              clientId: stableClientId,
              version: app.getVersion(),
              platform: process.platform,
              hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
            },
          });
        } catch {
          // ignore audit write failures
        }
      };

      registerIpc(db, { clientId: stableClientId, apiBaseUrl });
      logToFile('IPC registered, SQLite ready');
      configureUpdateService({ apiBaseUrl, db });
      await writeSessionAuditEvent('app.session.start');

      const remote = await applyRemoteClientSettings({
        db,
        apiBaseUrl,
        clientId: stableClientId,
        version: app.getVersion(),
        log: logToFile,
      });
      const cached = remote ?? (await getCachedClientSettings(db));

      const updatesEnabled = cached.updatesEnabled !== false;

      // Dev-only верификация окна обновления симуляцией (в проде env не выставлен).
      const simUpdate = process.env.MATRICA_SIMULATE_UPDATE;
      if (simUpdate) {
        const simScenario = simUpdate === 'error' ? 'error' : simUpdate === 'loop' ? 'loop' : 'happy';
        void simulateUpdateUiForDev(simScenario);
      } else if (updatesEnabled) {
        await recoverStuckUpdateState();
        const pendingApplied = await applyPendingUpdateIfAny(null);
        if (pendingApplied) return;
        const updateResult = await runAutoUpdateFlow({ reason: 'startup', parentWindow: null });
        if (updateResult?.action === 'update_started') {
          app.quit();
          return;
        }
        startBackgroundUpdatePolling();
      }

      // Создаём окно только после завершения update-flow.
      createWindow();
      const delay = updatesEnabled ? 800 : 0;
      scheduleShowMainWindow(delay);
    } catch (e) {
      logToFile(`fatal init failed: ${String(e)}`);
      await dialog.showMessageBox({
        type: 'error',
        title: 'Ошибка запуска',
        message: 'Приложение не может запуститься на этом компьютере.',
        detail: `Лог: ${getLogPath()}\n\n${String(e)}`,
      });
      app.quit();
    }
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return;
  // During startup update flow, the update window can be the only window.
  // Prevent quitting before the main window is ready.
  if (!allowMainWindowShow) return;
  app.quit();
});

app.on('before-quit', () => {
  if (stopAuditWritten) return;
  stopAuditWritten = true;
  if (writeSessionAuditEvent) void writeSessionAuditEvent('app.session.stop');
});

// Тестовый IPC: проверяем связку renderer -> main.
ipcMain.handle('app:ping', async () => {
  return { ok: true, ts: Date.now() };
});

ipcMain.handle('app:version', async () => {
  return { ok: true, version: app.getVersion() };
});

// «Активное» время от renderer: кладём последнее значение, оно поедет на ближайшем heartbeat'е.
ipcMain.on('activity:report', (_event, args: { activeDate?: unknown; activeMs?: unknown }) => {
  setReportedActivity(args ?? null);
});

ipcMain.handle('app:navigateDeepLink', async (_event, link: ChatDeepLinkPayload) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { ok: false as const, error: 'Main window not available' };
  }
  mainWindow.webContents.send('app:deep-link-event', link);
  return { ok: true as const };
});

ipcMain.on('app:close-response', (_event, args: { allowClose: boolean }) => {
  if (args?.allowClose) {
    setForceQuit(true);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    } else {
      app.quit();
    }
  }
});


