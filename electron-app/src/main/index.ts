import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
  startBackgroundUpdatePolling,
} from './services/updateService.js';
import { applyRemoteClientSettings, getCachedClientSettings } from './services/clientAdminService.js';
import { appDirname, resolvePreloadPath, resolveRendererIndex } from './utils/appPaths.js';
import { createFileLogger } from './utils/logger.js';
import { setupMenu } from './utils/menu.js';

let mainWindow: BrowserWindow | null = null;
let mainWindowReady = false;
let allowMainWindowShow = false;
let writeSessionAuditEvent:
  | ((action: 'app.session.start' | 'app.session.stop') => Promise<void>)
  | null = null;
let stopAuditWritten = false;
const APP_TITLE = () => `Матрица РМЗ v${app.getVersion()}`;

const { logToFile, getLogPath } = createFileLogger(app);
const baseDir = appDirname(import.meta.url);

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

function createWindow(): void {
  const preloadPath = resolvePreloadPath(baseDir);
  const rendererIndex = resolveRendererIndex(baseDir);

  logToFile(`createWindow: preload=${preloadPath}`);
  logToFile(`createWindow: renderer=${rendererIndex}`);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_TITLE(),
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      // В sandbox режиме preload требует CommonJS. Явно отключаем sandbox для стабильности.
      sandbox: false,
      nodeIntegration: false,
    },
  });

  // Не даём web-странице менять title — фиксируем заголовок окна.
  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
    mainWindow?.setTitle(APP_TITLE());
  });

  // electron-vite выставляет переменную VITE_DEV_SERVER_URL в dev режиме.
  const devUrl = process.env.VITE_DEV_SERVER_URL;

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(rendererIndex);
  }

  mainWindow.webContents.on('did-finish-load', async () => {
    try {
      const href = await mainWindow?.webContents.executeJavaScript('location.href', true);
      const scripts = await mainWindow?.webContents.executeJavaScript(
        "Array.from(document.scripts).map(s => s.src || s.type || '').join(' | ')",
        true,
      );
      logToFile(`renderer did-finish-load: href=${String(href)}`);
      logToFile(`renderer scripts: ${String(scripts)}`);
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

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logToFile(`did-fail-load: code=${code} desc=${desc} url=${url}`);
    void dialog.showMessageBox({
      type: 'error',
      title: 'Ошибка запуска',
      message: 'Не удалось загрузить интерфейс приложения.',
      detail: `code=${code}\n${desc}\n${url}\n\nЛог: ${getLogPath()}`,
    });
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
  const apiBaseUrl = process.env.MATRICA_API_URL ?? 'http://a6fd55b8e0ae.vps.myjino.ru';
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

  // По умолчанию — адрес вашего VPS (чтобы Windows-клиент сразу мог синхронизироваться).
  // Можно переопределить переменной окружения MATRICА_API_URL при запуске.
  // В проде обычно ходим через reverse-proxy (nginx) на 80/443, поэтому порт 3001 не указываем.
  // apiBaseUrl defined above for network/bootstrap and IPC.

  // Инициализируем SQLite + IPC асинхронно (до создания окна).
  void (async () => {
    try {
      const { openSqlite } = await import('./database/db.js');
      const { migrateSqlite } = await import('./database/migrate.js');
      const { seedIfNeeded } = await import('./database/seed.js');
      const { registerIpc } = await import('./ipc/registerIpc.js');
      const { SettingsKey, settingsGetString, settingsSetString } = await import('./services/settingsStore.js');
      const { getSession } = await import('./services/authService.js');
      const { addAudit } = await import('./services/auditService.js');

      const userData = app.getPath('userData');
      mkdirSync(userData, { recursive: true });
      const dbPath = join(userData, 'matricarmz.sqlite');
      const { db, sqlite } = openSqlite(dbPath);

      try {
        // В packaged-версии миграции лежат внутри app.asar.
        // Поэтому используем абсолютный путь от app.getAppPath().
        const migrationsFolder = join(app.getAppPath(), 'drizzle');
        logToFile(`sqlite migrationsFolder=${migrationsFolder}`);
        migrateSqlite(db, sqlite, migrationsFolder);
        await seedIfNeeded(db);
      } catch (e) {
        logToFile(`sqlite migrate/seed failed: ${String(e)}`);
        await dialog.showMessageBox({
          type: 'error',
          title: 'Ошибка базы данных',
          message: 'Не удалось инициализировать локальную базу данных SQLite.',
          detail: `Лог: ${getLogPath()}\n\n${String(e)}`,
        });
        app.quit();
        return;
      }

      // Стабильный clientId (один раз на рабочее место): нужен для корректного sync_state на сервере и диагностики.
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

      if (updatesEnabled) {
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


