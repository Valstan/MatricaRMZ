import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
// Важно: НЕ импортируем SQLite/IPC сервисы на верхнем уровне.
// На Windows native-модуль (better-sqlite3) может падать при загрузке,
// из-за чего приложение не успевает создать окно/лог.
// Загружаем их динамически после app.whenReady().
import { initAutoUpdate, checkForUpdates } from './services/updateService.js';

let mainWindow: BrowserWindow | null = null;

function logToFile(message: string) {
  try {
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'matricarmz.log'), `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // ignore
  }
}

function resolvePreloadPath(): string {
  const candidates = [
    join(__dirname, '../preload/index.mjs'),
    join(__dirname, '../preload/index.js'),
  ];
  for (const p of candidates) if (existsSync(p)) return p;
  return candidates[0];
}

function resolveRendererIndex(): string {
  return join(__dirname, '../renderer/index.html');
}

function createWindow(): void {
  const preloadPath = resolvePreloadPath();
  const rendererIndex = resolveRendererIndex();

  logToFile(`createWindow: preload=${preloadPath}`);
  logToFile(`createWindow: renderer=${rendererIndex}`);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Матрица РМЗ',
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // electron-vite выставляет переменную VITE_DEV_SERVER_URL в dev режиме.
  const devUrl = process.env.VITE_DEV_SERVER_URL;

  if (devUrl) {
    void mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    void mainWindow.loadFile(rendererIndex);
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    logToFile(`did-fail-load: code=${code} desc=${desc} url=${url}`);
    void dialog.showMessageBox({
      type: 'error',
      title: 'Ошибка запуска',
      message: 'Не удалось загрузить интерфейс приложения.',
      detail: `code=${code}\n${desc}\n${url}\n\nЛог: ${join(app.getPath('userData'), 'matricarmz.log')}`,
    });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  // Логи Chromium/Electron в stderr (в Windows можно потом смотреть через event viewer / debug tools).
  app.commandLine.appendSwitch('enable-logging');
  app.commandLine.appendSwitch('v', '1');

  initAutoUpdate();
  process.on('uncaughtException', (e) => logToFile(`uncaughtException: ${String(e)}`));
  process.on('unhandledRejection', (e) => logToFile(`unhandledRejection: ${String(e)}`));
  // Создаём окно как можно раньше, чтобы пользователь видел ошибку, если DB не поднялась.
  createWindow();

  // Технический client_id для синхронизации (MVP).
  // Позже: хранить/обновлять через sync_state таблицу.
  const clientId = `${process.env.COMPUTERNAME ?? 'pc'}-${randomUUID()}`;
  // По умолчанию — адрес вашего VPS (чтобы Windows-клиент сразу мог синхронизироваться).
  // Можно переопределить переменной окружения MATRICА_API_URL при запуске.
  const apiBaseUrl = process.env.MATRICA_API_URL ?? 'http://a6fd55b8e0ae.vps.myjino.ru:3001';

  // Автопроверка обновлений при старте (MVP).
  void checkForUpdates();
  // Инициализируем SQLite + IPC асинхронно (после создания окна).
  void (async () => {
    try {
      const { openSqlite } = await import('./database/db.js');
      const { migrateSqlite } = await import('./database/migrate.js');
      const { seedIfNeeded } = await import('./database/seed.js');
      const { registerIpc } = await import('./ipc/registerIpc.js');

      const userData = app.getPath('userData');
      mkdirSync(userData, { recursive: true });
      const dbPath = join(userData, 'matricarmz.sqlite');
      const { db, sqlite } = openSqlite(dbPath);

      try {
        migrateSqlite(db, sqlite);
        await seedIfNeeded(db);
      } catch (e) {
        logToFile(`sqlite migrate/seed failed: ${String(e)}`);
        await dialog.showMessageBox({
          type: 'error',
          title: 'Ошибка базы данных',
          message: 'Не удалось инициализировать локальную базу данных SQLite.',
          detail: `Лог: ${join(app.getPath('userData'), 'matricarmz.log')}\n\n${String(e)}`,
        });
        app.quit();
        return;
      }

      registerIpc(db, { clientId, apiBaseUrl });
      logToFile('IPC registered, SQLite ready');
    } catch (e) {
      logToFile(`fatal init failed: ${String(e)}`);
      await dialog.showMessageBox({
        type: 'error',
        title: 'Ошибка запуска',
        message: 'Приложение не может запуститься на этом компьютере.',
        detail: `Лог: ${join(app.getPath('userData'), 'matricarmz.log')}\n\n${String(e)}`,
      });
      app.quit();
    }
  })();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Тестовый IPC: проверяем связку renderer -> main.
ipcMain.handle('app:ping', async () => {
  return { ok: true, ts: Date.now() };
});


