// Реестр передач файлов: main → renderer.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Передача идёт в main (там сеть и диск), а оператор смотрит
// в renderer. Без общего канала renderer узнаёт о прогрессе только после того, как
// операция закончилась, — то есть ровно тогда, когда прогресс уже не нужен.
//
// ПРАВИЛО: событие уходит в ОКНА (как `sync:progress`), а не в ответ на IPC-вызов:
// вызов `files:upload`/`chat:sendFile` висит до конца, и его результат приходит
// слишком поздно для полосы. Идентификатор передачи задаёт инициатор (renderer), чтобы
// он знал, к какой своей операции относится событие (например, полоса у файла в чате).
//
// ОКОНЧАТЕЛЬНОСТЬ. Завершённые передачи ненадолго остаются в реестре: UI показывает
// «Готово»/«Ошибка» и прячет полосу через несколько секунд. Самая свежая ошибка в
// реестре нужна окну, которое открылось ПОСЛЕ обрыва (иначе оператор не увидит, что
// файл не отправился).

import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

import type { FileTransferDirection, FileTransferPhase, FileTransferProgress } from '@matricarmz/shared';

/** Сколько живёт завершённая передача в реестре (мс). */
const FINISHED_TTL_MS = 10_000;

const transfers = new Map<string, FileTransferProgress>();

function broadcast(state: FileTransferProgress): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('files:progress', state);
    }
  } catch {
    // окно могло закрыться — прогресс оператору уже не нужен
  }
}

function pruneFinished(now: number): void {
  for (const [id, t] of transfers) {
    if (t.phase === 'done' || t.phase === 'error') {
      if (now - t.updatedAt > FINISHED_TTL_MS) transfers.delete(id);
    }
  }
}

/** Начать передачу. Идентификатор можно задать инициатором (renderer). */
export function beginFileTransfer(init: {
  id?: string | undefined;
  direction: FileTransferDirection;
  fileName: string;
  label: string;
  bytesTotal?: number | null | undefined;
}): FileTransferProgress {
  const now = Date.now();
  const state: FileTransferProgress = {
    id: String(init.id ?? '').trim() || randomUUID(),
    direction: init.direction,
    phase: 'preparing',
    fileName: String(init.fileName ?? '').trim() || 'файл',
    label: String(init.label ?? '').trim() || (init.direction === 'upload' ? 'Отправка файла' : 'Скачивание файла'),
    bytesTotal: Number.isFinite(Number(init.bytesTotal)) ? Number(init.bytesTotal) : null,
    bytesDone: 0,
    error: null,
    startedAt: now,
    updatedAt: now,
  };
  pruneFinished(now);
  transfers.set(state.id, state);
  broadcast(state);
  return state;
}

/** Обновить ход передачи (байты/фаза). */
export function updateFileTransfer(
  id: string,
  patch: { bytesDone?: number; bytesTotal?: number | null; phase?: FileTransferPhase },
): FileTransferProgress | null {
  const current = transfers.get(String(id ?? ''));
  if (!current) return null;
  const next: FileTransferProgress = {
    ...current,
    bytesDone: patch.bytesDone != null ? Math.max(0, Math.floor(Number(patch.bytesDone))) : current.bytesDone,
    bytesTotal: patch.bytesTotal !== undefined ? patch.bytesTotal : current.bytesTotal,
    phase: patch.phase ?? current.phase,
    updatedAt: Date.now(),
  };
  transfers.set(next.id, next);
  broadcast(next);
  return next;
}

/** Завершить передачу (успех или ошибка). */
export function endFileTransfer(id: string, result: { ok: boolean; error?: string | null }): FileTransferProgress | null {
  const current = transfers.get(String(id ?? ''));
  if (!current) return null;
  const next: FileTransferProgress = {
    ...current,
    phase: result.ok ? 'done' : 'error',
    error: result.ok ? null : String(result.error ?? 'неизвестная ошибка'),
    updatedAt: Date.now(),
  };
  if (result.ok) next.bytesDone = next.bytesTotal ?? next.bytesDone;
  transfers.set(next.id, next);
  broadcast(next);
  return next;
}

/** Текущее состояние передач (для окна, открывшегося посреди операции). */
export function listFileTransfers(): FileTransferProgress[] {
  pruneFinished(Date.now());
  return [...transfers.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Обернуть операцию в передачу: прогресс, финал, ошибка — в одном месте.
 * Возвращает результат операции как есть.
 */
export async function withFileTransfer<T>(
  init: { id?: string; direction: FileTransferDirection; fileName: string; label: string; bytesTotal?: number | null },
  run: (transferId: string) => Promise<T>,
): Promise<T> {
  const state = beginFileTransfer(init);
  try {
    const result = await run(state.id);
    endFileTransfer(state.id, { ok: true });
    return result;
  } catch (e) {
    endFileTransfer(state.id, { ok: false, error: String(e) });
    throw e;
  }
}
