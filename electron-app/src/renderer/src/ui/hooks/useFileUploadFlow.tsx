import { useEffect, useState } from 'react';

import { fileTransferPercent, isFileTransferActive } from '@matricarmz/shared';

import { FileRenameUploadDialog } from '../components/FileRenameUploadDialog.js';
import { sanitizeFileNameStem, splitNameAndExt } from '../utils/fileUploadRename.js';
import { useFileTransfers } from './useFileTransfers.js';

export type UploadProgressState = {
  active: boolean;
  percent: number;
  label: string;
  /** Процент неизвестен (транспорт не считает байты) — полоса неопределённая, а не «0%». */
  indeterminate?: boolean;
};

export type UploadTask = {
  path: string;
  fileName: string;
};

type UploadFailure = {
  task: UploadTask;
  error: string;
};

export function useFileUploadFlow() {
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState<UploadProgressState>({ active: false, percent: 0, label: '' });
  const [renameModal, setRenameModal] = useState<{
    stem: string;
    extWithDot: string;
    warning: string;
    resolve: (fileName: string | null) => void;
  } | null>(null);
  // Живой прогресс загрузки: main присылает состояние передачи по её идентификатору.
  const { byId } = useFileTransfers();
  const [activeTransferId, setActiveTransferId] = useState<string | null>(null);

  useEffect(() => {
    if (!activeTransferId) return;
    const live = byId(activeTransferId);
    if (!live) return;
    const pct = fileTransferPercent(live);
    setProgress((prev) => {
      const percent = pct ?? 0;
      const indeterminate = pct == null;
      // Тот же объект — React прекращает перерисовку: эффект вызывается на каждом
      // рендере, и без этой проверки получился бы бесконечный цикл.
      if (prev.percent === percent && prev.indeterminate === indeterminate) return prev;
      return { ...prev, percent, indeterminate };
    });
  }, [activeTransferId, byId]);

  function setStatusWithTimeout(message: string, timeoutMs = 1400) {
    setStatus(message);
    if (timeoutMs > 0) {
      window.setTimeout(() => setStatus(''), timeoutMs);
    }
  }

  async function promptFileName(path: string): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
      const original = String(path || '').replaceAll('\\', '/').split('/').pop() || 'file';
      const { stem, extWithDot } = splitNameAndExt(original);
      setRenameModal({ stem, extWithDot, warning: '', resolve });
    });
  }

  async function buildTasks(paths: string[]): Promise<UploadTask[] | null> {
    const unique = Array.from(new Set(paths.map((p) => String(p || '').trim()).filter(Boolean)));
    const uploads: UploadTask[] = [];
    for (const p of unique) {
      const fileName = await promptFileName(p);
      if (!fileName) return null;
      uploads.push({ path: p, fileName });
    }
    return uploads;
  }

  /**
   * Загрузка файлов по очереди — с НАСТОЯЩИМ прогрессом.
   *
   * Раньше процент был выдуман таймером («+2% каждые 120 мс»): оператор видел полосу,
   * которая ползёт сама, и не мог отличить её от реальной передачи. Теперь прогресс
   * приходит из main по идентификатору передачи (`transferId`), а тот, кто не умеет
   * считать байты, показывает неопределённую полосу вместо правдоподобных нулей.
   */
  async function runUploads<T>(
    tasks: UploadTask[],
    uploadOne: (task: UploadTask, transferId: string) => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
    opts?: { continueOnError?: boolean },
  ): Promise<{ successes: Array<{ task: UploadTask; value: T }>; failures: UploadFailure[] }> {
    const continueOnError = opts?.continueOnError === true;
    const successes: Array<{ task: UploadTask; value: T }> = [];
    const failures: UploadFailure[] = [];

    for (const task of tasks) {
      const transferId = crypto.randomUUID();
      setActiveTransferId(transferId);
      setProgress({ active: true, percent: 0, label: `Загрузка файла: ${task.fileName}`, indeterminate: true });

      const result = await uploadOne(task, transferId);
      setActiveTransferId(null);

      if (result.ok) {
        successes.push({ task, value: result.value });
        setProgress({ active: true, percent: 100, label: `Загружено: ${task.fileName}`, indeterminate: false });
        continue;
      }

      failures.push({ task, error: result.error });
      if (!continueOnError) break;
    }

    setProgress({ active: false, percent: 0, label: '' });
    return { successes, failures };
  }

  const renameDialog = (
    <FileRenameUploadDialog
      open={!!renameModal}
      stem={renameModal?.stem ?? ''}
      extWithDot={renameModal?.extWithDot ?? ''}
      warning={renameModal?.warning ?? ''}
      onStemChange={(value) => {
        const sanitized = sanitizeFileNameStem(value);
        setRenameModal((prev) =>
          prev
            ? {
                ...prev,
                stem: sanitized.value,
                warning: sanitized.forbiddenChar ? `Символ "${sanitized.forbiddenChar}" запрещен в именах файлов.` : '',
              }
            : prev,
        );
      }}
      onSubmit={() => {
        if (!renameModal) return;
        const nextStem = renameModal.stem.trim();
        if (!nextStem) {
          setRenameModal((prev) => (prev ? { ...prev, warning: 'Имя файла не может быть пустым.' } : prev));
          return;
        }
        renameModal.resolve(`${nextStem}${renameModal.extWithDot}`);
        setRenameModal(null);
      }}
      onCancel={() => {
        if (!renameModal) return;
        renameModal.resolve(null);
        setRenameModal(null);
      }}
    />
  );

  return {
    status,
    setStatus,
    setStatusWithTimeout,
    progress,
    setProgress,
    buildTasks,
    runUploads,
    renameDialog,
    /** Жив ли ещё аппарат загрузки (для стража: прогресс не должен быть выдуманным). */
    isTransferActive: (id: string | null) => {
      const live = id ? byId(id) : null;
      return live ? isFileTransferActive(live) : false;
    },
  };
}
