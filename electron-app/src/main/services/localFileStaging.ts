import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { rememberIssuedPath } from '../ipc/pathOriginRegistry.js';

// Временные копии файлов оператора (промт КАРМАНА #158).
//
// Зачем: системный мастер печати фотографий и почтовый клиент работают с ПАПКОЙ на
// диске. Файлы из «Поиска по файлам» лежат в папках оператора (часто в сетевой), и
// «отдать их в мастер» прямо оттуда нельзя — мастеру нужна своя папка с копиями.
//
// Правила (из промта):
//  * копирует главный процесс — renderer на диск не ходит;
//  * папка называется ПОНЯТНО («Фото для печати 26.11.2026 15-04-05»), иначе оператор
//    её не найдёт и не удалит;
//  * копии никуда не уходят по сети — они на диске оператора;
//  * путь копии «выдан» главным процессом (`rememberIssuedPath`) — renderer не может
//    подсунуть произвольный путь (тот же класс защиты, что у загрузки файлов).

/** Корень наших временных папок. Внутри `%TEMP%` — чистить безопасно. */
export const STAGING_ROOT_NAME = 'Матрица РМЗ';

export function stagingRoot(): string {
  return join(tmpdir(), STAGING_ROOT_NAME);
}

/** Имя папки с копиями: понятно оператору и не ломает путь Windows. */
export function stagingFolderName(label: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${p(now.getDate())}.${p(now.getMonth() + 1)}.${now.getFullYear()} ` +
    `${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
  const clean = String(label || 'Файлы').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return `${clean} ${stamp}`.slice(0, 120);
}

export type StagedFile = {
  /** Путь копии на диске оператора. */
  path: string;
  /** Имя файла (может отличаться от исходного — при совпадении имён добавляем номер). */
  name: string;
};

/** Не дать двум файлам с одинаковым именем переписать друг друга. */
async function freeName(folder: string, name: string): Promise<string> {
  const taken = new Set(await readdir(folder));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 500; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Скопировать отмеченные файлы во временную папку оператора.
 *
 * Копии нужны для системных окон (мастер печати, почтовый клиент). Каждый путь
 * копии помечается как «выданный» — renderer сможет отдать его обратно главному
 * процессу (загрузка на сервер, отправка в чат), но не сможет подсунуть свой.
 */
export async function stageLocalFiles(
  paths: string[],
  label: string,
): Promise<{ ok: true; folder: string; files: StagedFile[] } | { ok: false; error: string }> {
  const list = paths.map((p) => String(p ?? '').trim()).filter(Boolean);
  if (list.length === 0) return { ok: false, error: 'Не выбрано ни одной картинки' };
  const folder = join(stagingRoot(), stagingFolderName(label));
  try {
    await mkdir(folder, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Не удалось создать временную папку: ${String(e)}` };
  }
  const files: StagedFile[] = [];
  for (const src of list) {
    try {
      const st = await stat(src);
      if (!st.isFile()) {
        return { ok: false, error: `«${basename(src)}» — это не файл` };
      }
      const name = await freeName(folder, basename(src));
      const dest = join(folder, name);
      await copyFile(src, dest);
      rememberIssuedPath(dest);
      files.push({ path: dest, name });
    } catch (e) {
      return { ok: false, error: `Не удалось скопировать «${basename(src)}»: ${String(e)}` };
    }
  }
  return { ok: true, folder, files };
}

/**
 * Убрать временную папку с копиями.
 *
 * Убираем ТОЛЬКО свою папку (внутри `%TEMP%\Матрица РМЗ`) — иначе вызов с
 * чужой строкой снёс бы у оператора что-то не то.
 */
export async function removeStagedFolder(folder: string): Promise<boolean> {
  const raw = String(folder ?? '').trim();
  if (!raw) return false;
  const target = resolve(raw);
  const root = resolve(stagingRoot());
  const inside = target === root || target.startsWith(root + '\\') || target.startsWith(root + '/');
  if (!inside) return false;
  try {
    await rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Убрать всё, что осталось от прошлых запусков.
 *
 * Вызывается при старте программы: копии не должны копиться. Папки прошлой смены
 * оператор уже не использует — а если нужен файл, оригинал лежит в своей папке.
 */
export async function cleanupStaleStagingFolders(): Promise<number> {
  const root = stagingRoot();
  let removed = 0;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await rm(join(root, entry.name), { recursive: true, force: true });
        removed += 1;
      } catch {
        // Не смогли — не мешает остальным: программа работает дальше.
      }
    }
  } catch {
    // Корня нет — чистить нечего.
  }
  return removed;
}
