// Сторож прогресса передачи файлов.
//
// Проверяем по коду то, что нельзя проверить без живого клиента: что полоса идёт
// СОБЫТИЕМ из main, что процент настоящий (а не выдуманный таймером), что второй клик
// по уже качающемуся файлу не запускает вторую загрузку, и что ни один путь загрузки
// или скачивания не остался «молчащим».
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(HERE, rel), 'utf8');

const BUS = read('./fileTransferProgress.ts');
const NET_FETCH = read('./netFetch.ts');
const FILE_SERVICE = read('./fileService.ts');
const CHAT_SERVICE = read('./chatService.ts');
const FILES_IPC = read('../ipc/register/files.ts');
const PRELOAD = read('../../preload/index.ts');
const UPLOAD_FLOW = read('../../renderer/src/ui/hooks/useFileUploadFlow.tsx');
const CHAT_PANEL = read('../../renderer/src/ui/components/ChatPanel.tsx');
const PANEL = read('../../renderer/src/ui/components/FileTransferProgressPanel.tsx');
const SHELL = read('../../renderer/src/ui/shellV3/V3TabShell.tsx');

describe('прогресс передачи файлов', () => {
  it('main шлёт событие прогресса в окна — по образцу sync:progress', () => {
    expect(BUS).toContain("webContents.send('files:progress'");
    expect(BUS).toContain('BrowserWindow.getAllWindows()');
  });

  it('окно может запросить текущие передачи (открылось посреди операции)', () => {
    expect(FILES_IPC).toContain("ipcMain.handle('files:progress:list'");
    expect(PRELOAD).toContain('progressList');
    expect(PRELOAD).toContain('onProgress');
  });

  it('скачивание идёт потоком с честным счётчиком байт, а не «буфер в память и тишина»', () => {
    expect(NET_FETCH).toContain('downloadToFileWithProgress');
    expect(FILE_SERVICE).toContain('downloadToFileWithProgress');
    // Прежний путь держал файл целиком в памяти и не сообщал ни о чём.
    const downloadBody = FILE_SERVICE.slice(FILE_SERVICE.indexOf('export async function filesDownload'));
    expect(downloadBody.slice(0, 4000)).not.toContain('arrayBuffer()');
  });

  it('отправка идёт через net.request — у него есть настоящий счётчик байт', () => {
    expect(NET_FETCH).toContain('putBufferWithProgress');
    expect(NET_FETCH).toContain('getUploadProgress');
    expect(CHAT_SERVICE).toContain('putBufferWithProgress');
    expect(FILE_SERVICE).toContain('putBufferWithProgress');
  });

  it('выдуманного прогресса больше нет: полоса в загрузках считается по событию', () => {
    // Прежде здесь был таймер «+2% каждые 120 мс» — оператор не мог отличить его от
    // настоящей передачи.
    expect(UPLOAD_FLOW).not.toContain('animatedPercent');
    expect(UPLOAD_FLOW).toContain('fileTransferPercent');
    expect(UPLOAD_FLOW).toContain('transferId');
  });

  it('идентификатор операции задаёт инициатор — renderer знает свою операцию', () => {
    expect(CHAT_SERVICE).toContain('beginFileTransfer');
    expect(CHAT_SERVICE).toContain('transferId');
    expect(CHAT_PANEL).toContain('transferId: crypto.randomUUID()');
  });

  it('второй клик по уже качающемуся файлу не запускает вторую загрузку', () => {
    expect(CHAT_PANEL).toContain('Уже качается');
    expect(CHAT_PANEL).toContain('transferById(running)');
  });

  it('полоса видна на любом экране и показывает неопределённое состояние честно', () => {
    expect(SHELL).toContain('<FileTransferProgressPanel />');
    expect(PANEL).toContain('data-file-progress-panel');
    // Процент известен не всегда — тогда «крутилка», а не выдуманные нули.
    expect(PANEL).toContain('fileTransferPercent');
    expect(PANEL).toContain('mx-file-progress-indeterminate');
  });
});
