// Прогресс передачи файлов — общее правило для клиента.
//
// ЗАЧЕМ. Оператор не отличает «файл отправляется» от «всё зависло» от «оператор не
// дотащил файл до окна»: в чате отправка молчит, а скачивание выглядит как «щечкнул и
// ничего не происходит» (на самом деле файл качается). Одно и то же правило считается
// в main (где идёт передача) и в renderer (где рисуется полоса) — иначе половины разойдутся.
//
// ЧТО НЕ ТАК. Число байт знает только транспорт: у `fetch` прогресса загрузки нет
// вовсе, а скачивание отдаётся потоком (значит, процент честный). Поэтому у передачи
// есть ДВА состояния: определённое (bytesDone/bytesTotal известны) и неопределённое
// (объём неизвестен или счётчик недоступен) — второе показывается «крутилкой», а не
// выдуманными процентами. Имитация прогресса (таймер «+2%») вводит в заблуждение
// сильнее, чем честная неопределённость.

export type FileTransferDirection = 'upload' | 'download';

/**
 * Фаза передачи:
 * - `preparing` — читаем файл/считаем хэш, сети ещё нет;
 * - `transferring` — идёт передача байтов;
 * - `finalizing` — байты переданы, пишем файл на диск / досылаем сообщение;
 * - `done` — готово;
 * - `error` — оборвалось.
 */
export type FileTransferPhase = 'preparing' | 'transferring' | 'finalizing' | 'done' | 'error';

export type FileTransferProgress = {
  /** Идентификатор передачи. Кто инициировал (renderer) — тот и знает, к какой операции она относится. */
  id: string;
  direction: FileTransferDirection;
  phase: FileTransferPhase;
  /** Имя файла — оператор видит, ЧТО именно висит. */
  fileName: string;
  /** Человеческая подпись операции: «Отправка файла», «Скачивание файла». */
  label: string;
  /** Сколько байт всего (null — неизвестно). */
  bytesTotal: number | null;
  /** Сколько байт передано. */
  bytesDone: number;
  error: string | null;
  startedAt: number;
  updatedAt: number;
};

/** Процент передачи: null — процент неизвестен (показывать «крутилку», не выдумывать). */
export function fileTransferPercent(t: Pick<FileTransferProgress, 'bytesDone' | 'bytesTotal'>): number | null {
  const total = Number(t.bytesTotal ?? 0);
  const done = Number(t.bytesDone ?? 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  const pct = Math.floor((done / total) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Передача ещё идёт (полосу показываем, а не «готово»). */
export function isFileTransferActive(t: Pick<FileTransferProgress, 'phase'>): boolean {
  return t.phase === 'preparing' || t.phase === 'transferring' || t.phase === 'finalizing';
}

/** «12,4 МБ» — размер для оператора. */
export function formatFileSize(bytes: number | null | undefined): string {
  const n = Number(bytes ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1).replace('.', ',')} КБ`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} ГБ`;
}

/** Подпись фазы для оператора. */
export function fileTransferPhaseLabel(t: Pick<FileTransferProgress, 'phase' | 'direction'>): string {
  switch (t.phase) {
    case 'preparing':
      return t.direction === 'upload' ? 'Готовим файл…' : 'Готовим загрузку…';
    case 'transferring':
      return t.direction === 'upload' ? 'Отправляем…' : 'Скачиваем…';
    case 'finalizing':
      return t.direction === 'upload' ? 'Дописываем файл…' : 'Сохраняем на диск…';
    case 'done':
      return 'Готово';
    case 'error':
      return 'Ошибка';
    default:
      return '';
  }
}
