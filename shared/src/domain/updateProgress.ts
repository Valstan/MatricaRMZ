/**
 * Прогресс обновления программы: одна полоса, один процент, честные секунды.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ДОМЕН. Обновление смотрели в трёх местах (окно апдейтера, заливка под
 * вкладками, модалка «сейчас или позже»), и в каждом процент считался по-своему: скачивание
 * доходило до 100%, установка начиналась с 80% — полоса прыгала назад, и оператор не понимал,
 * то ли это откат, то ли зависло (владелец 08.11.2026: «Сейчас скачивание доходит до 100% и
 * всё сбрасывается — непонятно, то ли откат, то ли что»).
 *
 * ЗДЕСЬ ОДНО ПРАВИЛО: полоса одна, у каждого этапа своя часть, процент только вперёд.
 *   скачивание 0–60 · проверка 60–70 · установка 70–95 · перезапуск 95–100
 *
 * Секунды честные: если оценить нечем — пишем «оценка недоступна», а не 0 (враньё хуже
 * честного «не знаю» — тот же принцип, что в полосе передачи файлов).
 */

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'downloaded'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'uptodate'
  | 'error';

export type UpdateStageRange = { from: number; to: number };

/**
 * Часть полосы, отведённая этапу. Этапы идут по порядку и не пересекаются: конец одного —
 * начало следующего, поэтому общий процент не прыгает.
 *
 * `downloaded` — отдельная ступень: файл скачан, но оператор ещё не нажал «Перезапуск».
 * Полоса стоит на 60% и ждёт; сбрасывать её в ноль нельзя.
 */
export const UPDATE_STAGE_RANGES: Record<UpdateStage, UpdateStageRange> = {
  idle: { from: 0, to: 0 },
  checking: { from: 0, to: 0 },
  downloading: { from: 0, to: 60 },
  downloaded: { from: 60, to: 60 },
  verifying: { from: 60, to: 70 },
  installing: { from: 70, to: 95 },
  restarting: { from: 95, to: 100 },
  uptodate: { from: 100, to: 100 },
  error: { from: 0, to: 0 },
};

function clampPct(value: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.floor(n)));
}

/**
 * Общий процент по этапу и проценту ВНУТРИ этапа.
 * `stageOverallPct('downloading', 50)` — половина скачивания → 30% общей полосы.
 */
export function stageOverallPct(stage: UpdateStage, stagePct: number): number {
  const range = UPDATE_STAGE_RANGES[stage] ?? UPDATE_STAGE_RANGES.idle;
  const inner = clampPct(stagePct);
  if (range.to === range.from) return clampPct(range.from);
  return clampPct(range.from + ((range.to - range.from) * inner) / 100);
}

/**
 * Процент не убывает: полоса не прыгает назад. `previous` — процент, который уже показан.
 * Новая попытка обновления сбрасывает его отдельно (см. `resetOverallPct`).
 */
export function monotonicOverallPct(previous: number | null | undefined, next: number): number {
  const prev = clampPct(previous ?? 0);
  const value = clampPct(next);
  return value < prev ? prev : value;
}

/**
 * Секунды до конца — словами для человека. Нет данных — «оценка недоступна», не «0 с».
 */
export function formatEtaSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(Number(seconds))) return 'оценка недоступна';
  const total = Math.max(0, Math.round(Number(seconds)));
  if (total < 60) return `осталось ${total} с`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `осталось ${min} мин ${sec} с`;
}

/**
 * Подпись полосы: «Матрица3-РМЗ (135) → Матрица3-РМЗ (136) · 42% · осталось 18 с».
 * Подписи версий приходят готовыми (см. `formatAppVersionLabel`) — домен не знает нумерации.
 */
export function formatUpdateProgressLabel(args: {
  fromLabel?: string | null;
  toLabel?: string | null;
  pct: number;
  etaSeconds?: number | null;
}): string {
  const pct = clampPct(args.pct);
  const from = String(args.fromLabel ?? '').trim();
  const to = String(args.toLabel ?? '').trim();
  // Подписи версий приходят уже готовыми («Матрица3-РМЗ (135)») — лишнее «Матрица» перед
  // ними выглядело бы как «Матрица Матрица3-РМЗ».
  const versions = from && to ? `${from} → ${to}` : to || from || 'Матрица';
  return `${versions} · ${pct}% · ${formatEtaSeconds(args.etaSeconds)}`;
}

/**
 * Скорость и ETA по окну сэмплов: средняя за окно + EMA-сглаживание, чтобы цифры не
 * «мельтешали» на мгновенной дельте между чанками. Без данных о байтах — ничего не выдумываем.
 *
 * `transferredBytes` — НАКОПЛЕННЫЕ байты, `previousBytes` — сколько их было в начале окна:
 * скорость считается по ДЕЛЬТЕ за окно (накопленные байты делить на время окна нельзя —
 * получилась бы скорость с самого начала, а не текущая).
 */
export function estimateDownloadRate(args: {
  transferredBytes: number | null | undefined;
  previousBytes?: number | null;
  totalBytes: number | null | undefined;
  windowSeconds: number;
  previousBytesPerSecond?: number | null;
}): { bytesPerSecond: number | null; etaSeconds: number | null } {
  const transferred = Number(args.transferredBytes);
  const total = Number(args.totalBytes);
  if (!Number.isFinite(transferred) || transferred < 0) return { bytesPerSecond: null, etaSeconds: null };
  if (!Number.isFinite(total) || total <= 0) return { bytesPerSecond: null, etaSeconds: null };
  const windowSeconds = Math.max(0.001, Number(args.windowSeconds) || 0);
  const previousBytes = Number(args.previousBytes);
  const deltaBytes = Number.isFinite(previousBytes) ? Math.max(0, transferred - previousBytes) : transferred;
  const rate = deltaBytes / windowSeconds;
  if (!Number.isFinite(rate) || rate <= 0) return { bytesPerSecond: null, etaSeconds: null };
  const previous = Number(args.previousBytesPerSecond);
  const smoothed =
    Number.isFinite(previous) && previous > 0 ? previous * 0.6 + rate * 0.4 : rate;
  const etaSeconds = Math.max(0, (total - transferred) / smoothed);
  return { bytesPerSecond: smoothed, etaSeconds: Number.isFinite(etaSeconds) ? etaSeconds : null };
}
