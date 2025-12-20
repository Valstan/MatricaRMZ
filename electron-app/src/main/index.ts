import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { openSqlite } from './database/db.js';
import { migrateSqlite } from './database/migrate.js';
import { seedIfNeeded } from './database/seed.js';
import { registerIpc } from './ipc/registerIpc.js';
import { initAutoUpdate, checkForUpdates } from './services/updateService.js';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Матрица РМЗ',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // electron-vite выставляет переменную VITE_DEV_SERVER_URL в dev режиме.
  const devUrl = process.env.VITE_DEV_SERVER_URL;

  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  initAutoUpdate();
  // Инициализация локальной SQLite (в userData).
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  const dbPath = join(userData, 'matricarmz.sqlite');
  const { db, sqlite } = openSqlite(dbPath);
  try {
    migrateSqlite(db, sqlite);
    void seedIfNeeded(db);
  } catch (e) {
    console.error('[electron] migrate failed', e);
  }

  // Технический client_id для синхронизации (MVP).
  // Позже: хранить/обновлять через sync_state таблицу.
  const clientId = `${process.env.COMPUTERNAME ?? 'pc'}-${randomUUID()}`;
  // По умолчанию — адрес вашего VPS (чтобы Windows-клиент сразу мог синхронизироваться).
  // Можно переопределить переменной окружения MATRICА_API_URL при запуске.
  const apiBaseUrl = process.env.MATRICA_API_URL ?? 'http://a6fd55b8e0ae.vps.myjino.ru:3001';
  registerIpc(db, { clientId, apiBaseUrl });

  // Автопроверка обновлений при старте (MVP).
  void checkForUpdates();

  createWindow();

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


