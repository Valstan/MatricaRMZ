import { useEffect, useRef } from 'react';

// «Положить на Верстак» — общий вызов из любого места программы.
//
// Почему шина, а не проп: состоянием Верстака владеет оболочка (`App.tsx`), а
// действие живёт на странице «Поиск по файлам» (`FileSearchPage.tsx`), и между ними
// несколько слоёв вёрстки. Проп пришлось бы протаскивать через все — и забыть в
// одном, и «Положить на верстак» снова ничего бы не сделало.
//
// Тот же приём, что у корзины Верстака (`DesktopTrashBus.ts`): запрос помнит и
// «ждущий» — если Верстак сейчас не смонтирован, запрос не теряется.
//
// Файлы сюда приходят УЖЕ загруженными на сервер: ярлык Верстака ссылается на
// серверный файл, у локального снимка с диска оператора серверного id нет.

export type DesktopFileToPut = {
  /** id файла на сервере. */
  id: string;
  /** Имя файла — подпись плитки. */
  name: string;
  mime?: string | null;
};

let pending: DesktopFileToPut[] | null = null;
const listeners = new Set<(files: DesktopFileToPut[]) => void>();

function emit(): void {
  for (const listener of listeners) {
    if (pending) listener(pending);
  }
}

/** Положить файлы на Верстак (из любого места программы). */
export function requestDesktopPutFiles(files: DesktopFileToPut[]): void {
  if (!Array.isArray(files) || files.length === 0) return;
  pending = files;
  emit();
}

/** Забрать запрос «положить на Верстак» (одноразово). */
export function takeDesktopPutFilesRequest(): DesktopFileToPut[] | null {
  if (!pending) return null;
  const files = pending;
  pending = null;
  return files;
}

/**
 * Подписка оболочки на запрос «положить на Верстак».
 *
 * Колбэк хранится в ref, чтобы подписка не пересоздавалась на каждом рендере.
 */
export function useDesktopPutFilesRequest(onPut: (files: DesktopFileToPut[]) => void): void {
  const ref = useRef(onPut);
  useEffect(() => {
    ref.current = onPut;
  }, [onPut]);

  useEffect(() => {
    const listener = () => {
      const files = takeDesktopPutFilesRequest();
      if (files) ref.current(files);
    };
    listeners.add(listener);
    // Оболочка только что смонтировалась, а запрос уже был — отдать его, не потерять.
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
}
