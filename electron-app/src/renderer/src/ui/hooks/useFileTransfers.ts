import { useEffect, useState } from 'react';

import type { FileTransferProgress } from '@matricarmz/shared';

/**
 * Живой список передач файлов (загрузка/скачивание).
 *
 * Один источник на всё приложение: и общая полоса в углу, и подпись под файлом в чате
 * читают отсюда. Передача приходит СОБЫТИЕМ из main, а не ответом на IPC-вызов:
 * вызов `files:upload`/`chat:sendFile` висит до конца операции, и его результат для
 * полосы приходит слишком поздно.
 */
export function useFileTransfers(): {
  transfers: FileTransferProgress[];
  byId: (id: string | null | undefined) => FileTransferProgress | null;
} {
  const [transfers, setTransfers] = useState<FileTransferProgress[]>([]);

  useEffect(() => {
    let alive = true;
    // Окно могло открыться посреди операции — добираем текущее состояние списком.
    void window.matrica.files
      .progressList()
      .then((list) => {
        if (alive && Array.isArray(list)) setTransfers(list);
      })
      .catch(() => {});
    const off = window.matrica.files.onProgress((state: FileTransferProgress | null) => {
      if (!alive || !state?.id) return;
      setTransfers((prev) => {
        const idx = prev.findIndex((t) => t.id === state.id);
        if (idx === -1) return [...prev, state];
        const next = prev.slice();
        next[idx] = state;
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const byId = (id: string | null | undefined) => {
    if (!id) return null;
    return transfers.find((t) => t.id === id) ?? null;
  };

  return { transfers, byId };
}
