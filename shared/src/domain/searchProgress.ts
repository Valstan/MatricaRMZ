// Общий прогресс поиска (промт КАРМАНА #166).
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ДОМЕН. Везде, где программа ищет по диску или по базе (папки,
// файлы-источники, содержимое карточек, серверный глобальный поиск), оператор
// должен видеть, ЧТО именно перебирается, и уметь отменить поиск. Раньше у
// каждого поиска было своё поведение: по папкам — просто «занято», по карточкам —
// тишина, глобальный поиск — «сервер…».
//
// Здесь — только общая ФОРМА события и правила подписей. Канал (main → окно) и
// отмена живут в главном процессе (`electron-app/src/main/services/searchProgress.ts`),
// полоса — в renderer (`ui/components/SearchProgressBar.tsx`).
//
// ОДИН КАНАЛ НА ВСЮ ПРОГРАММУ. Прогресс рисуется одним и тем же компонентом в
// любом месте; список поисков в подписке не размножается по страницам —
// подписка одна (см. `ui/services/searchProgressService.ts`).

/** Что именно ищем — по этому различаются подписи и счётчики. */
export type SearchProgressKind =
  /** Обход папок на диске (модуль «Поиск по файлам»). */
  | 'folders'
  /** Чтение выбранных файлов-источников. */
  | 'files'
  /** Поиск по содержимому карточек (второй уровень списка). */
  | 'cards'
  /** Глобальный поиск (Ctrl+K), в т.ч. серверный уровень. */
  | 'global';

/**
 * Состояние поиска.
 *
 * `start` — поиск начался; `progress` — идёт; `done` — закончился;
 * `cancelled` — оператор отменил (работа реально прекращена, отдан частичный
 * результат); `error` — упал с ошибкой.
 */
export type SearchProgressState = 'start' | 'progress' | 'done' | 'cancelled' | 'error';

/**
 * Событие прогресса поиска: из главного процесса в окно.
 *
 * Форма — по образцу прогресса синхронизации (`SyncProgressEvent`): состояние,
 * этап/подпись, процент, прошедшее время. Добавлено то, чего нужно именно
 * поиску: имя перебираемого объекта и счётчики «просмотрено / найдено».
 */
export type SearchProgressEvent = {
  /** Идентификатор поиска — по нему оператор отменяет именно этот поиск. */
  searchId: string;
  kind: SearchProgressKind;
  state: SearchProgressState;
  /** Заголовок операции: «Поиск по папкам». */
  title: string;
  /** Что читается прямо сейчас: имя папки или файла. */
  current: string | null;
  /** Дополнительная счётная строка — например «В дереве папок: 412». */
  detail: string | null;
  /** Просмотрено: N. */
  scanned: number | null;
  /** Всего: M (null — неизвестно на этот момент). */
  total: number | null;
  /** Найдено: K. */
  found: number | null;
  /** Доля выполнения 0..1 (null — неизвестно). */
  progress: number | null;
  startedAt: number;
  elapsedMs: number;
  updatedAt: number;
  /** Текст ошибки (только при `state === 'error'`). */
  error: string | null;
};

/** Заголовок поиска по виду — одинаково рисуется в любом месте программы. */
export const SEARCH_PROGRESS_KIND_TITLE: Record<SearchProgressKind, string> = {
  folders: 'Поиск по папкам',
  files: 'Поиск по файлам',
  cards: 'Поиск по карточкам',
  global: 'Глобальный поиск',
};

/**
 * Существительное для счётчика — по виду поиска.
 *
 * «Просмотрено папок: 12 из 40», «Просмотрено файлов: 3 из 8»,
 * «Просмотрено карточек: 120 из 900».
 */
const COUNTER_NOUN: Record<SearchProgressKind, string> = {
  folders: 'папок',
  files: 'файлов',
  cards: 'карточек',
  global: 'источников',
};

/** Существительное счётчика для вида поиска. */
export function searchProgressCounterNoun(kind: SearchProgressKind): string {
  return COUNTER_NOUN[kind] ?? 'объектов';
}

/** Идёт ли поиск прямо сейчас (полоса должна быть видна). */
export function isSearchProgressActive(state: SearchProgressState): boolean {
  return state === 'start' || state === 'progress';
}

/**
 * Строка счётчиков: «Просмотрено папок: 12 из 40 · Найдено: 3».
 *
 * Пустая строка, если считать нечего: полоса не должна показывать «Просмотрено
 * папок: null».
 */
export function formatSearchProgressCounters(evt: SearchProgressEvent): string {
  const parts: string[] = [];
  const noun = searchProgressCounterNoun(evt.kind);
  if (evt.scanned != null) {
    parts.push(
      evt.total != null
        ? `Просмотрено ${noun}: ${evt.scanned} из ${evt.total}`
        : `Просмотрено ${noun}: ${evt.scanned}`,
    );
  }
  if (evt.found != null) parts.push(`Найдено: ${evt.found}`);
  return parts.join(' · ');
}

/** Строка текущего объекта: «Сейчас смотрим: Э06АТ0889». */
export function formatSearchProgressCurrent(evt: SearchProgressEvent): string {
  const current = String(evt.current ?? '').trim();
  if (!current) return '';
  return `Сейчас смотрим: ${current}`;
}

/** Прошедшее время: «прошло 12 с», «прошло 1 мин 05 с». */
export function formatSearchProgressElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  if (total < 60) return `прошло ${total} с`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `прошло ${minutes} мин ${String(seconds).padStart(2, '0')} с`;
}

/** Процент выполнения 0..100 (null — неизвестно). */
export function searchProgressPercent(evt: SearchProgressEvent): number | null {
  if (evt.progress != null && Number.isFinite(evt.progress)) {
    return Math.max(0, Math.min(100, Math.round(evt.progress * 100)));
  }
  if (evt.scanned != null && evt.total != null && evt.total > 0) {
    return Math.max(0, Math.min(100, Math.round((evt.scanned / evt.total) * 100)));
  }
  return null;
}

/** Человеческая подпись состояния — для финальной строки полосы. */
export function searchProgressStateLabel(evt: SearchProgressEvent): string {
  if (evt.state === 'cancelled') return 'Поиск отменён';
  if (evt.state === 'error') return `Ошибка поиска: ${evt.error ?? 'неизвестная ошибка'}`;
  if (evt.state === 'done') return 'Поиск закончен';
  return '';
}
