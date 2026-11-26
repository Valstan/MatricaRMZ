import type { SaveRepairStageResult } from '@matricarmz/shared';

import type { ScrapStageBlockInfo } from '../components/ScrapStageBlockDialog.js';

/**
 * ОКНО ГЕЙТА УТИЛЯ — общий доступ для всех экранов, которые заводят этап (промт КАРМАНА #170).
 *
 * Блокировка стоит в воронке записи этапа (main), а окно — здесь: экранов много (карточка,
 * список двигателей, производственная программа, массовое добавление), а правило одно.
 * Модуль держит ОДНО окно на приложение: кто открыл — тот и отвечает за повтор записи.
 */

type Listener = (info: ScrapStageBlockInfo | null) => void;

let currentInfo: ScrapStageBlockInfo | null = null;
let onResolved: ((info: ScrapStageBlockInfo, warning?: string) => void) | null = null;
const listeners = new Set<Listener>();

/** Подписка окна (хост в `App.tsx`). */
export function subscribeScrapStageBlock(listener: Listener): () => void {
  listeners.add(listener);
  listener(currentInfo);
  return () => {
    listeners.delete(listener);
  };
}

/** Открыть окно: «деталь отремонтирована» → `resolve` (повтор записи этапа). */
export function openScrapStageBlock(
  info: ScrapStageBlockInfo,
  resolve: (info: ScrapStageBlockInfo, warning?: string) => void,
): void {
  currentInfo = info;
  onResolved = resolve;
  for (const listener of listeners) listener(currentInfo);
}

/** Закрыть окно без действий (кнопка «Отмена»): этап не создан, следов записи нет. */
export function closeScrapStageBlock(): void {
  currentInfo = null;
  onResolved = null;
  for (const listener of listeners) listener(null);
}

/**
 * Деталь отремонтирована: утиль снята, повторяем запись этапа.
 *
 * `warning` — предупреждение снятия (например, деталь не вернулась в ремонтный фонд):
 * окно закрывается, а предупреждение уходит вызывающему — иначе оно пропало бы вместе
 * с окном.
 */
export function resolveScrapStageBlock(warning?: string): void {
  const info = currentInfo;
  const callback = onResolved;
  closeScrapStageBlock();
  if (info && callback) callback(info, warning);
}

/**
 * Разбор результата записи этапа.
 *
 * `true` — окно открыто, вызывающий прекращает обработку (этап не заведён, повтор будет
 * после снятия утиля). `false` — гейта не было, результат обычный.
 */
export function handleScrapStageResult(args: {
  result: SaveRepairStageResult;
  engineId: string;
  retry: (warning?: string) => void | Promise<void>;
}): boolean {
  const gate = args.result.ok ? undefined : args.result.scrapGate;
  if (!gate) return false;
  openScrapStageBlock({ ...gate, engineId: args.engineId }, (_info, warning) => {
    void args.retry(warning);
  });
  return true;
}
