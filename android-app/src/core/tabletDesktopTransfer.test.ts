// Планшет и передача файлов между Верстаками (промт КАРМАНА #143).
//
// Исключение «DesktopTransfer» на планшете было устаревшим: причина в нём говорила
// про «отправку клиенту по локальной сети», а транспорт с прошлого изменения —
// личное сообщение чата с файлом (локальной сети в нём нет). Из-за этого оператор
// с планшета не мог ни отправить файл коллеге, ни принять присланный, а программа
// отвечала ему «передавать нечего» — то есть враньём.
//
// Что ловит этот тест: возвращение исключения, отказ от проверки доступа (шим
// `filesMeta`) и потерю домена в мосте планшета.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TABLET_DOMAIN_EXCEPTIONS } from './tabletDomains.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const WIRING = read(resolve(repoRoot, 'android-app/src/core/ipcWiring.ts'));
const FILE_SHIM = read(resolve(repoRoot, 'android-app/src/shims/fileService.ts'));
const DESKTOP_SERVICE = read(resolve(repoRoot, 'electron-app/src/main/services/desktopTransferService.ts'));

describe('передача файлов на планшете', () => {
  it('домен подключён в мосте планшета', () => {
    expect(WIRING).toContain('registerDesktopTransferIpc(ctx)');
  });

  it('исключение убрано: домен на планшете работает', () => {
    const stale = TABLET_DOMAIN_EXCEPTIONS.filter((e) => e.domain === 'DesktopTransfer').map((e) => e.domain);
    expect(stale, 'домен объявлен исключением, но на планшете он подключён').toEqual([]);
  });

  it('шим файлов умеет проверять доступ: filesMeta на месте', () => {
    // Отправить коллеге можно только то, к чему у отправителя есть доступ. Проверка
    // делается запросом метаданных файла — на планшете шим обязан его уметь.
    expect(FILE_SHIM).toContain('export async function filesMeta(');
    expect(DESKTOP_SERVICE).toContain('const meta = await filesMeta(');
  });

  it('планшет шлёт файл тем же каналом, что и компьютер: по id файла, без пути на диске', () => {
    expect(WIRING).toContain('registerDesktopTransferIpc(ctx)');
    // Путь на диске на планшете недоступен — значит, отправка идёт по id уже
    // залитого файла (тот же путь, что у бота обмена).
    expect(DESKTOP_SERVICE).toContain('filesMeta(db, apiBaseUrl, { fileId })');
  });
});
