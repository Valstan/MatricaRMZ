import { app, BrowserWindow } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Окно «программа запускается».
 *
 * Долгий старт (миграции SQLite, выравнивание схемы с сервером, лечение битой базы,
 * поток обновления) шёл БЕЗ единого окна на экране: владелец несколько раз щёлкал
 * ярлык, решил, что зависло, и ушёл на полчаса — а программа в это время чинилась.
 * Окно показывает текущий этап и живой индикатор.
 */

type StartupStatusState = { stage: string; note: string };

/**
 * Задержка показа. Здоровый старт тут — это загрузка нативного SQLite, ключ из keyring
 * и два сетевых запроса к серверу, то есть уверенные секунды: порог ниже трёх секунд
 * заставлял бы окно мигать почти на каждом запуске.
 */
const SHOW_DELAY_MS = 3500;

/** Dev-проверка: MATRICA_SIMULATE_STARTUP=slow растягивает каждый этап (в проде env не выставлен). */
const SIMULATED_STAGE_DELAY_MS = process.env.MATRICA_SIMULATE_STARTUP === 'slow' ? 2500 : 0;

let statusWindow: BrowserWindow | null = null;
let showTimer: NodeJS.Timeout | null = null;
let state: StartupStatusState = { stage: 'Запускаю программу', note: '' };
let disposed = false;
let dismissedByUser = false;

// Выход из приложения важнее окна статуса: оно не должно ни задерживать закрытие,
// ни всплыть уже после него по сработавшему таймеру.
app.on('before-quit', () => {
  disposed = true;
  hideStartupStatus();
});

function resolveStartupPreloadPath(): string | null {
  const appPath = app.getAppPath();
  const candidates = [
    join(appPath, 'dist/preload/startup.cjs'),
    join(appPath, 'dist/preload/startup.js'),
    join(appPath, 'dist/preload/startup.mjs'),
    join(process.resourcesPath, 'app/dist/preload/startup.cjs'),
    join(process.resourcesPath, 'app.asar/dist/preload/startup.cjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveStartupHtmlUrl(): string {
  const appPath = app.getAppPath();
  const candidates = [
    join(appPath, 'dist/renderer/startup.html'),
    join(process.resourcesPath, 'app/dist/renderer/startup.html'),
    join(process.resourcesPath, 'app.asar/dist/renderer/startup.html'),
  ];
  for (const candidate of candidates) {
    // loadFile() спотыкается о .asar на Windows (ERR_FAILED), хотя файл виден —
    // собираем file:// сами, ровно как окно обновления.
    if (existsSync(candidate)) return `file:///${candidate.replaceAll('\\', '/')}`;
  }
  // В dev renderer отдаёт vite и dist/renderer не собран — берём тот же файл из publicDir.
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  return devUrl ? `${devUrl.replace(/\/+$/, '')}/startup.html` : 'about:blank';
}

function push() {
  const w = statusWindow;
  if (!w || w.isDestroyed()) return;
  w.webContents.send('startup:stage', state);
}

function ensureWindow(): BrowserWindow | null {
  if (disposed || dismissedByUser) return null;
  if (statusWindow && !statusWindow.isDestroyed()) return statusWindow;
  const preload = resolveStartupPreloadPath();
  const win = new BrowserWindow({
    width: 520,
    height: 300,
    show: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    // Не modal и не alwaysOnTop: окно не должно перекрывать чужие программы и
    // не должно спорить с модальными диалогами самого запуска.
    alwaysOnTop: false,
    autoHideMenuBar: true,
    title: 'Матрица РМЗ — запуск',
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      ...(preload ? { preload } : {}),
    },
  });
  win.setMenuBarVisibility(false);
  win.on('closed', () => {
    if (statusWindow !== win) return;
    statusWindow = null;
    // Закрыл человек (hideStartupStatus обнуляет ссылку ДО destroy) — больше не
    // всплываем сами: иначе окно, которое только что прогнали, возвращается на
    // каждом следующем этапе.
    dismissedByUser = true;
  });
  win.webContents.on('did-finish-load', () => push());
  void win.loadURL(resolveStartupHtmlUrl()).catch(() => {});
  statusWindow = win;
  return win;
}

function reveal(focus: boolean) {
  const w = ensureWindow();
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  // Без фокуса показываем showInactive: окно не должно выдёргивать человека из
  // той программы, в которой он работает, пока Матрица заводится в фоне.
  if (!w.isVisible()) {
    if (focus) w.show();
    else w.showInactive();
  }
  if (focus) w.focus();
  push();
}

function armShowTimer() {
  if (disposed || dismissedByUser || showTimer) return;
  if (statusWindow && !statusWindow.isDestroyed() && statusWindow.isVisible()) return;
  showTimer = setTimeout(() => {
    showTimer = null;
    reveal(false);
  }, SHOW_DELAY_MS);
  // Таймер не должен один держать процесс живым.
  showTimer.unref();
}

/** Взвести окно статуса: создаётся сразу (скрытым), показывается по таймеру. */
export function showStartupStatus(stage: string, note?: string): void {
  if (disposed) return;
  state = { stage, note: note ?? '' };
  ensureWindow();
  push();
  armShowTimer();
}

/**
 * Отметить этап и отдать главному потоку такт цикла событий.
 *
 * Окно статуса рисуется только МЕЖДУ синхронными шагами: миграции SQLite блокируют
 * главный поток целиком, и таймер показа внутри них не сработает — поэтому вызов
 * ставится ПЕРЕД тяжёлым шагом, а не после него.
 */
export async function setStartupStage(stage: string, note?: string): Promise<void> {
  if (disposed) return;
  state = { stage, note: note ?? '' };
  ensureWindow();
  push();
  armShowTimer();
  await new Promise<void>((resolve) => setTimeout(resolve, SIMULATED_STAGE_DELAY_MS));
}

/** Убрать окно статуса: перед модальным диалогом и при показе окна обновления. */
export function hideStartupStatus(): void {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  const w = statusWindow;
  statusWindow = null;
  if (w && !w.isDestroyed()) w.destroy();
}

/**
 * Запуск закончился — окно статуса больше не появится никогда. Без этого
 * повторный клик по ярлыку уже после показа главного окна построил бы новое
 * окно статуса, застывшее на последнем этапе, и закрыть его было бы нечем.
 */
export function finishStartupStatus(): void {
  disposed = true;
  hideStartupStatus();
}

/** Показать немедленно, без задержки: повторный клик по ярлыку и старт лечения базы. */
export function raiseStartupStatus(): void {
  if (disposed) return;
  // Если на экране уже есть другое своё окно (обновление, главное) — поднимаем его,
  // а не спорим с ним вторым окном.
  for (const w of BrowserWindow.getAllWindows()) {
    if (w === statusWindow || w.isDestroyed() || !w.isVisible()) continue;
    if (w.isMinimized()) w.restore();
    w.focus();
    return;
  }
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  // Человек сам просит показать — снимаем его же прежний отказ.
  dismissedByUser = false;
  reveal(true);
}
