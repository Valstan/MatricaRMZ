import { useState } from 'react';

import { FileRenameUploadDialog } from '../components/FileRenameUploadDialog.js';
import { sanitizeFileNameStem, splitNameAndExt } from '../utils/fileUploadRename.js';

export type UploadProgressState = {
  active: boolean;
  percent: number;
  label: string;
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

  async function runUploads<T>(
    tasks: UploadTask[],
    uploadOne: (task: UploadTask) => Promise<{ ok: true; value: T } | { ok: false; error: string }>,
    opts?: { continueOnError?: boolean },
  ): Promise<{ successes: Array<{ task: UploadTask; value: T }>; failures: UploadFailure[] }> {
    const continueOnError = opts?.continueOnError === true;
    const successes: Array<{ task: UploadTask; value: T }> = [];
    const failures: UploadFailure[] = [];
    const total = tasks.length || 1;

    for (let i = 0; i < tasks.length; i += 1) {
      const task = tasks[i];
      if (!task) continue;
      const startPercent = Math.round((i / total) * 100);
      const endPercent = Math.round(((i + 1) / total) * 100);
      let animatedPercent = startPercent;

      setProgress({ active: true, percent: startPercent, label: `Загрузка файла: ${task.fileName}` });
      const timer = window.setInterval(() => {
        animatedPercent = Math.min(endPercent - 8, animatedPercent + 2);
        setProgress((prev) => (prev.active ? { ...prev, percent: Math.max(prev.percent, animatedPercent) } : prev));
      }, 120);

      const result = await uploadOne(task);
      window.clearInterval(timer);

      if (result.ok) {
        successes.push({ task, value: result.value });
        setProgress({ active: true, percent: endPercent, label: `Загружено: ${task.fileName}` });
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
  };
}

