// Шим модуля 'electron' для android-бандла (подставляется vite-плагином
// androidShims). Портированные main-сервисы Electron-клиента используют из
// 'electron' узкую поверхность — только её и реализуем; обращение к
// чему-то ещё должно упасть громко на этапе бандла/теста, а не тихо в проде.
//
// БЕЗОПАСНОСТЬ (safeStorage): на десктопе сессия шифруется ОС (DPAPI/Keychain)
// поверх шифрованной БД. На Android слой один — SQLCipher-реплика с ключом в
// Keystore; когда platform-хук encryptionAvailable()=true, «шифрование» здесь —
// identity (сессия хранится внутри уже шифрованной БД). Когда Keystore/ключа
// нет — false, и authService сам уходит в fail-closed (сессия только в памяти,
// перелогин после рестарта) — правило то же, что на десктопе без keyring.

import { tabletChannelRefusalReason } from '../core/tabletDomains.js';
import { getAndroidPlatformHooks } from './platform.js';

export const net = {
  fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init),
  // Явный false из WebView = офлайн; navigator без onLine (Node/vitest) = онлайн.
  isOnline: (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false,
};

export const safeStorage = {
  isEncryptionAvailable(): boolean {
    return getAndroidPlatformHooks().encryptionAvailable();
  },
  // authService: encryptString(json).toString('hex') → в БД; при чтении
  // Buffer.from(hex,'hex') → decryptString(buf). Identity-режим = честная
  // hex-кодировка UTF-8 без шифра (см. шапку файла). Buffer в WebView даёт
  // полифилл (vite alias 'buffer'); в vitest на Node он нативный.
  encryptString(value: string): { toString(encoding?: string): string } {
    const bytes = new TextEncoder().encode(value);
    const hex = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { toString: () => hex };
  },
  decryptString(buf: unknown): string {
    return new TextDecoder().decode(buf as Uint8Array);
  },
};

export const app = {
  relaunch(): void {
    getAndroidPlatformHooks().relaunch();
  },
  // Реального каталога у WebView нет: путь — только ключ для шима
  // node:fs/promises (см. его шапку), а не место на диске.
  getPath(name: string): string {
    return `/android/${name}`;
  },
  exit(_code?: number): void {
    // На Android процесс не завершаем — relaunch-хук решает сам.
  },
  // Тот же контракт, что у `exit`: процесс на Android не закрывает себя — перезапуск
  // решает платформенный хук (пересоздание WebView/Activity).
  quit(): void {
    // no-op
  },
  getVersion(): string {
    return getAndroidPlatformHooks().appVersion();
  },
};

// ── In-process IPC-шина (Ф2) ────────────────────────────────────────────────
// main- и renderer-код исполняются в одном WebView, поэтому ipcMain/ipcRenderer
// сводятся к общему реестру хэндлеров + слушателей. Это позволяет реюзать
// НАСТОЯЩИЕ preload/index.ts и ipc/register/*-модули Electron-клиента: весь
// маппинг window.matrica → сервисы приходит без форка (метод Ф1 — шимить края).

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
type IpcListener = (event: unknown, ...args: unknown[]) => void;

const ipcHandlers = new Map<string, IpcHandler>();
const ipcListeners = new Map<string, Set<IpcListener>>();
const missedChannels = new Set<string>();

const ipcEvent = Object.freeze({ sender: { send: sendToRenderer } });

function sendToRenderer(channel: string, ...args: unknown[]): void {
  const set = ipcListeners.get(channel);
  if (!set) return;
  for (const listener of [...set]) {
    try {
      listener(ipcEvent, ...args);
    } catch (e) {
      console.error(`[electron-shim] listener error on ${channel}:`, e);
    }
  }
}

// sectionGate монкипатчит ipcMain.handle — объект должен оставаться мутируемым.
export const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    ipcHandlers.set(channel, handler);
  },
  removeHandler(channel: string): void {
    ipcHandlers.delete(channel);
  },
  on(channel: string, listener: IpcListener): void {
    // send-каналы renderer→main (activity:report и т.п.) — та же таблица слушателей.
    let set = ipcListeners.get(channel);
    if (!set) ipcListeners.set(channel, (set = new Set()));
    set.add(listener);
  },
};

export const ipcRenderer = {
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = ipcHandlers.get(channel);
    if (!handler) {
      // Незарегистрированный канал (домен вне рамки android-клиента) — громко в лог,
      // мягко в UI: тот же контракт, что у спайк-моста Ф0.
      //
      // Промт КАРМАНА #142: отказ должен НАЗЫВАТЬ причину. Раньше все отказы выглядели
      // одинаково («недоступно на планшете: <канал>»), и оператор с админом гадали,
      // чего не хватает — прав или функции. Теперь у каждого канала есть причина
      // (см. core/tabletDomains.ts), и она в ответе.
      if (!missedChannels.has(channel)) {
        missedChannels.add(channel);
        console.warn(`[electron-shim] no IPC handler: ${channel}`);
      }
      const reason = tabletChannelRefusalReason(channel);
      return {
        ok: false,
        error: reason
          ? `канал не заведён на планшете: ${channel} — ${reason}`
          : `канал не заведён на планшете: ${channel}`,
      };
    }
    return handler(ipcEvent, ...args);
  },
  send(channel: string, ...args: unknown[]): void {
    sendToRenderer(channel, ...args);
  },
  on(channel: string, listener: IpcListener): void {
    let set = ipcListeners.get(channel);
    if (!set) ipcListeners.set(channel, (set = new Set()));
    set.add(listener);
  },
  removeListener(channel: string, listener: IpcListener): void {
    ipcListeners.get(channel)?.delete(listener);
  },
};

// Проводника у планшета нет: файловой системы у WebView нет, показывать нечего.
// Канал «показать файл» на планшете до сюда не доходит (шим node:fs отвечает
// «файла нет»), но если дойдёт — падать надо громко и с причиной, а не молча.
export const shell = {
  showItemInFolder(_fullPath: string): void {
    throw new Error('на планшете нет файловой системы — показывать файл негде');
  },
};

/**
 * Нативные диалоги на планшете невозможны (нет файловой системы), но модули,
 * которые их тянут, должны собираться: иначе сборка APK падает на rollup
 * («dialog is not exported by …»). Поэтому диалог — заглушка, которая честно
 * отменяет выбор.
 *
 * Каналы, где отмена бессмысленна (выгрузка переписки в файл, отправка файла
 * из локальной папки), мост перекрывает явным отказом с причиной — см.
 * `core/tabletDomains.ts`.
 */
export const dialog = {
  async showSaveDialog(..._args: unknown[]): Promise<{ canceled: true; filePath: string }> {
    return { canceled: true, filePath: '' };
  },
  async showOpenDialog(..._args: unknown[]): Promise<{ canceled: true; filePaths: string[] }> {
    return { canceled: true, filePaths: [] };
  },
  async showMessageBox(..._args: unknown[]): Promise<{ response: number }> {
    return { response: 1 };
  },
  showErrorBox(_title: string, _content: string): void {
    // Диалогового окна на планшете нет — ошибку оператору покажет интерфейс.
  },
};

/**
 * Буфер обмена: на десктопе это системный буфер, на планшете — тоже системный,
 * но Electron-API к нему нет. Оставляем поверхность, чтобы модуль, который её
 * тянет, собирался; читает пустое, пишет — в никуда.
 */
export const clipboard = {
  availableFormats(): string[] {
    return [];
  },
  readBuffer(_format?: string): Uint8Array {
    return new Uint8Array(0);
  },
  readImage(): { isEmpty: () => boolean } {
    return { isEmpty: () => true };
  },
  readText(): string {
    return '';
  },
  writeText(_text: string): void {
    // no-op
  },
  writeImage(_image: unknown): void {
    // no-op
  },
};

/**
 * Растровые изображения: на десктопе Electron декодирует их нативно, на
 * планшете декодировать нечем (файловой системы нет). Поверхность оставлена,
 * чтобы портированный модуль собирался; картинка всегда пустая.
 */
const EMPTY_IMAGE = {
  isEmpty: () => true,
  getSize: () => ({ width: 0, height: 0 }),
  resize: () => EMPTY_IMAGE,
  crop: () => EMPTY_IMAGE,
  toPNG: () => new Uint8Array(0),
  toDataURL: () => '',
  toBitmap: () => new Uint8Array(0),
};

export const nativeImage = {
  createFromPath(_path: string): typeof EMPTY_IMAGE {
    return EMPTY_IMAGE;
  },
  createFromDataURL(_dataUrl: string): typeof EMPTY_IMAGE {
    return EMPTY_IMAGE;
  },
  createFromBuffer(_buffer: unknown): typeof EMPTY_IMAGE {
    return EMPTY_IMAGE;
  },
  createEmpty(): typeof EMPTY_IMAGE {
    return EMPTY_IMAGE;
  },
};

export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    (globalThis as Record<string, unknown>)[key] = value;
  },
};

// Пути к файлам на планшете нет: у WebView нет доступа к файловой системе, а
// загрузка вложений там пойдёт своим путём (из Blob), не через путь на диске.
// Пустая строка отфильтровывается вызывающим, и перетаскивание честно отвечает
// «перетащите файлы», а не падает.
export const webUtils = {
  getPathForFile(_file: unknown): string {
    return '';
  },
};

// Единственное «окно» — сам WebView; webContents.send доставляет событие
// слушателям ipcRenderer.on (sync:progress, auth:changed и т.п.).
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: sendToRenderer },
};

export const BrowserWindow = {
  getAllWindows(): Array<typeof fakeWindow> {
    return [fakeWindow];
  },
  // Нативных окон у WebView нет: «окно» для диалогов всегда отсутствует, и
  // вызывающий код обязан это пережить (диалог отменяется).
  getFocusedWindow(): null {
    return null;
  },
};
