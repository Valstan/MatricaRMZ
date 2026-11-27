// Фоновая индексация дерева папки (промт КАРМАНА #180).
//
// Проверяем то, на чём держится «фоновое индексание не мешает оператору»:
//   • карта строится отдельным процессом и сохраняется — следующий поиск
//     читает её, а не обходит диск;
//   • прогресс индексации доходит до окна (оператор видит, что идёт);
//   • если индексация не уложилась в срок — в журнале появляется запись
//     «индексирование папки не завершилось», оператор видит предупреждение,
//     а процесс останавливается и больше не ест ресурсы.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileSearchFolderIndex, FileSearchFolderSource } from '@matricarmz/shared';

vi.mock('electron', () => ({ utilityProcess: { fork: vi.fn() } }));

import { FolderIndexService } from './folderIndexService.js';

type Posted = Record<string, unknown> & { type: string };

/** Фейк процесса индексации: канал как у настоящего `utilityProcess`. */
class FakeChild {
  readonly posted: Posted[] = [];
  readonly handlers = new Map<string, Array<(arg: unknown) => void>>();
  killed = false;

  on(event: string, handler: (arg: unknown) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  postMessage(message: Posted): void {
    this.posted.push(message);
  }

  kill(): void {
    this.killed = true;
    this.emit('exit', 0);
  }

  emit(event: string, arg: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(arg);
  }

  /** Ответ от процесса (родительская сторона канала). */
  fromWorker(message: Record<string, unknown>): void {
    this.emit('message', message);
  }
}

let dir = '';
let storage = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'matrica-folder-index-'));
  storage = mkdtempSync(join(tmpdir(), 'matrica-folder-index-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(storage, { recursive: true, force: true });
});

function source(): FileSearchFolderSource {
  return { id: 'fsf_test', path: dir, name: 'Фото', addedAt: Date.now() };
}

function makeService(child: FakeChild, overrides: { timeoutMs?: number } = {}) {
  const logs: string[] = [];
  const progress: unknown[] = [];
  const service = new FolderIndexService({
    storageDir: storage,
    log: (line) => logs.push(line),
    onProgress: (job) => progress.push(job),
    workerPath: '/app/dist/main/folderIndexWorker.js',
    fork: () => child as never,
    ...(overrides.timeoutMs != null ? { timeoutMs: overrides.timeoutMs } : {}),
  });
  return { service, logs, progress };
}

function indexOf(sourceId = 'fsf_test'): FileSearchFolderIndex {
  return {
    sourceId,
    rootPath: dir,
    builtAt: Date.now(),
    rootModifiedAt: null,
    folderCount: 2,
    fileCount: 3,
    entries: [],
    unreadable: [],
    notes: [],
  };
}

describe('фоновая индексация папки', () => {
  it('карта строится отдельным процессом и сохраняется на диск', async () => {
    const child = new FakeChild();
    const { service } = makeService(child);

    service.requestBuild(source());
    expect(child.posted).toHaveLength(1);
    expect(child.posted[0]?.type).toBe('index');

    const jobId = String(child.posted[0]?.jobId);
    child.fromWorker({ type: 'done', jobId, index: indexOf() });
    // Запись карты асинхронная — дожидаемся, пока файл появится.
    await vi.waitFor(() => {
      expect(existsSync(join(storage, 'fsf_test.json'))).toBe(true);
    });

    const loaded = await service.load(source());
    expect(loaded?.sourceId).toBe('fsf_test');
    expect(loaded?.fileCount).toBe(3);
  });

  it('прогресс индексации доходит до окна: видно, что идёт и сколько просмотрено', () => {
    const child = new FakeChild();
    const { service, progress } = makeService(child);

    service.requestBuild(source());
    const jobId = String(child.posted[0]?.jobId);
    child.fromWorker({ type: 'progress', jobId, folders: 12, files: 340, current: 'Э06АТ0889' });

    const last = progress[progress.length - 1] as { state: string; folders: number; files: number; current: string };
    expect(last.state).toBe('running');
    expect(last.folders).toBe(12);
    expect(last.files).toBe(340);
    expect(last.current).toBe('Э06АТ0889');
  });

  it('сторож: индексация не завершилась — запись в журнале, предупреждение, процесс остановлен', async () => {
    const child = new FakeChild();
    const { service, logs, progress } = makeService(child, { timeoutMs: 40 });

    service.requestBuild(source());
    await vi.waitFor(() => {
      expect(logs.some((line) => line.includes('индексирование папки не завершилось'))).toBe(true);
    });

    // Процесс остановлен и больше не ест ресурсы.
    expect(child.killed).toBe(true);

    // Оператор видит предупреждение, а не молчание.
    const last = progress[progress.length - 1] as { state: string; message: string | null };
    expect(last.state).toBe('timeout');
    expect(last.message).toContain('Индексирование папки не завершилось');
  });

  it('ошибка процесса — честное состояние и запись в журнал', async () => {
    const child = new FakeChild();
    const { service, logs, progress } = makeService(child);

    service.requestBuild(source());
    const jobId = String(child.posted[0]?.jobId);
    child.fromWorker({ type: 'failed', jobId, error: 'Папка недоступна' });

    const last = progress[progress.length - 1] as { state: string; message: string | null };
    expect(last.state).toBe('error');
    expect(last.message).toContain('Папка недоступна');
    expect(logs.join(' ')).toContain('не удалась');
  });

  it('повторный запрос той же папки не плодит второе задание', () => {
    const child = new FakeChild();
    const { service } = makeService(child);

    service.requestBuild(source());
    service.requestBuild(source());
    expect(child.posted).toHaveLength(1);
  });

  it('карты нет — поиск получает null и просит построить её', async () => {
    const child = new FakeChild();
    const { service } = makeService(child);

    expect(await service.load(source())).toBeNull();
  });
});
