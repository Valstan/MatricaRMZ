// Схлопывание повторных вызовов: первый проходит сразу, а всё, что попросили внутри
// окна, сливается в один отложенный вызов.
//
// Нужно там, где одно и то же событие приходит несколькими путями. Перечитать список
// двигателей после синхронизации просят и обработчик 'done' в App, и импульс живых
// данных — а каждый такой вызов это полный скан EAV примерно по 1600 двигателям плюс
// карта флагов инвентаря и история ремонтов. Два одинаковых скана подряд владелец
// чувствует как «интерфейс задумался».
//
// Часы и таймеры принимаются параметрами: иначе проверить модуль тестом можно только
// настоящим ожиданием в три секунды.

export type CoalesceOptions = {
  /** Окно схлопывания, мс. */
  windowMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
};

export type Coalesced<TReason> = {
  (reason: TReason): void;
  /** Снять отложенный вызов, если он назначен. */
  cancel(): void;
};

export function coalesceCalls<TReason>(
  run: (reason: TReason) => void,
  options: CoalesceOptions,
): Coalesced<TReason> {
  const windowMs = Math.max(0, options.windowMs);
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) as unknown as number);
  const clearTimer = options.clearTimer ?? ((id: number) => globalThis.clearTimeout(id));

  let lastRunAt: number | null = null;
  let timerId: number | null = null;
  let pendingReason: TReason | null = null;

  const fire = (reason: TReason) => {
    lastRunAt = now();
    run(reason);
  };

  const request = ((reason: TReason) => {
    // Отложенный вызов уже назначен — он и покроет этот запрос. Причину запоминаем
    // последнюю: в замерах важно, кто пришёл позже всех, а не кто начал очередь.
    if (timerId !== null) {
      pendingReason = reason;
      return;
    }
    const elapsed = lastRunAt === null ? Number.POSITIVE_INFINITY : now() - lastRunAt;
    if (elapsed >= windowMs) {
      fire(reason);
      return;
    }
    pendingReason = reason;
    timerId = setTimer(() => {
      timerId = null;
      const next = pendingReason as TReason;
      pendingReason = null;
      fire(next);
    }, windowMs - elapsed);
  }) as Coalesced<TReason>;

  request.cancel = () => {
    if (timerId !== null) clearTimer(timerId);
    timerId = null;
    pendingReason = null;
  };

  return request;
}
