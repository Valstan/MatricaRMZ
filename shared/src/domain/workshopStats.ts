/**
 * «Статистика цехов» (Phase 0). Агрегаты труда + прохождения двигателей по цехам
 * из нарядов (`operations.operation_type='work_order'`). Цех уже захвачен у источника
 * (наряд несёт `workshopId` + `engine_entity_id` + труд) — нового поля не нужно.
 * Маршрут двигателя = упорядоченная последовательность его нарядов по цехам (несколько
 * цехов за ремонт — ответ владельца). Считается на backend (PostgreSQL), клиент тянет по HTTP.
 */

export type WorkshopStatsRow = {
  workshopId: string;
  workshopName: string;
  /** Этапы = число нарядов цеха за период. */
  orders: number;
  /** Прохождение = число уникальных двигателей, прошедших через цех. */
  engines: number;
  /** Сумма начислено по нарядам цеха (труд), ₽. */
  laborRub: number;
  /** Уникальные участники бригад цеха за период. */
  crew: number;
};

export type WorkshopEngineRouteStep = {
  workshopId: string;
  workshopName: string;
  performedAt: number;
  workOrderNumber: number;
  amountRub: number;
};

/** Маршрут одного двигателя: его наряды по цехам, упорядоченные по времени. */
export type WorkshopEngineRoute = {
  engineId: string;
  engineName: string;
  steps: WorkshopEngineRouteStep[];
};

export type WorkshopStatsResult = {
  from: string;
  to: string;
  rows: WorkshopStatsRow[];
  /** Честная пометка охвата (#023): какие цеха попали в данные, сколько молчат. */
  coverageNote: string;
  /** Наполняется только при выбранном одном цехе: маршруты двигателей, прошедших через него. */
  selected?: {
    workshopId: string;
    routes: WorkshopEngineRoute[];
  };
};
