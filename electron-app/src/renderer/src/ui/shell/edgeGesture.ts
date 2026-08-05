// Жест «провести пальцем от края к центру» для выдвижного хрома планшета.
// Чистый автомат: на вход точки {x, y, t}, на выход прогресс 0..1 и решение «открыть».
// DOM он не знает специально — так его покрывает vitest в окружении 'node', а провайдер
// остаётся тонким (pointerdown/move/up → эти три метода).

export type GesturePoint = { x: number; y: number; t: number };
export type GestureAxis = 'x' | 'y';
export type GesturePhase = 'idle' | 'pending' | 'captured' | 'cancelled' | 'done';

/** Тап от драга: пока палец не ушёл на 8px, жест не начат (иначе тап по хэндлу дёргает панель). */
export const GESTURE_DEAD_ZONE_PX = 8;
/** Ось определяется с запасом: косой свайп не должен воровать вертикальную прокрутку. */
export const GESTURE_AXIS_RATIO = 1.5;
/** Доводка: за этой долей хода панель открывается, до неё — откатывается. */
export const GESTURE_COMMIT_PROGRESS = 0.45;
/** Быстрый флик открывает/закрывает и на коротком ходе, px/мс. */
export const GESTURE_FLICK_VELOCITY = 0.6;

export type EdgeGestureConfig = {
  axis: GestureAxis;
  /** Полный ход панели в px (её ширина/высота). */
  size: number;
  /** Знак движения «в сторону открытия»: +1 — вправо/вниз, -1 — влево/вверх. */
  direction: 1 | -1;
  /** Панель уже открыта на момент старта — тогда тот же жест её закрывает. */
  open: boolean;
};

export type EdgeGestureSample = {
  phase: GesturePhase;
  /** 0 — панель за краем, 1 — панель полностью на экране. */
  progress: number;
};

export type EdgeGestureResult = EdgeGestureSample & { open: boolean };

export type EdgeGesture = {
  start(point: GesturePoint): EdgeGestureSample;
  move(point: GesturePoint): EdgeGestureSample;
  end(point?: GesturePoint): EdgeGestureResult;
  /** Система забрала жест (свайп «назад» Android) — панель закрывается, полусостояний нет. */
  cancel(): EdgeGestureResult;
  readonly phase: GesturePhase;
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function createEdgeGesture(config: EdgeGestureConfig): EdgeGesture {
  const size = Math.max(1, config.size);
  const base = config.open ? 1 : 0;
  let phase: GesturePhase = 'idle';
  let origin: GesturePoint | null = null;
  // Хвост траектории: скорость флика считается по двум последним РАЗЛИЧНЫМ отсчётам —
  // pointerup обычно повторяет координаты последнего pointermove, и «сдвиг на месте»
  // обнулил бы скорость ровно на самом быстром жесте.
  const history: GesturePoint[] = [];
  let progress = base;

  /** Смещение вдоль оси в сторону открытия (px). */
  function mainDelta(point: GesturePoint): number {
    if (!origin) return 0;
    const raw = config.axis === 'x' ? point.x - origin.x : point.y - origin.y;
    return raw * config.direction;
  }

  function crossDelta(point: GesturePoint): number {
    if (!origin) return 0;
    return Math.abs(config.axis === 'x' ? point.y - origin.y : point.x - origin.x);
  }

  function sample(): EdgeGestureSample {
    return { phase, progress };
  }

  function track(point: GesturePoint): void {
    const tail = history[history.length - 1];
    // Отсекаем отсчёты БЕЗ движения (pointerup обычно повторяет координаты последнего
    // pointermove, только позже по времени): иначе последняя пара даёт нулевое
    // перемещение за ненулевое время, и скорость флика всегда выходит нулевой —
    // быстрый короткий свайп молча откатывался бы.
    if (tail && tail.x === point.x && tail.y === point.y) return;
    history.push(point);
    if (history.length > 4) history.shift();
  }

  /** px/мс вдоль оси открытия по двум последним отсчётам с различным временем. */
  function velocity(): number {
    for (let i = history.length - 1; i > 0; i -= 1) {
      const a = history[i - 1];
      const b = history[i];
      if (!a || !b || b.t <= a.t) continue;
      return (mainDelta(b) - mainDelta(a)) / (b.t - a.t);
    }
    return 0;
  }

  return {
    get phase() {
      return phase;
    },
    start(point) {
      phase = 'pending';
      origin = point;
      history.length = 0;
      history.push(point);
      progress = base;
      return sample();
    },
    move(point) {
      if (phase !== 'pending' && phase !== 'captured') return sample();
      const main = mainDelta(point);
      const cross = crossDelta(point);
      if (phase === 'pending') {
        if (Math.max(Math.abs(main), cross) < GESTURE_DEAD_ZONE_PX) {
          track(point);
          return sample();
        }
        // Ось решается один раз: не та ось — жест отменён, палец продолжает работать штатно.
        phase = Math.abs(main) > cross * GESTURE_AXIS_RATIO ? 'captured' : 'cancelled';
        if (phase === 'cancelled') return sample();
      }
      const effective = main - Math.sign(main) * GESTURE_DEAD_ZONE_PX;
      progress = clamp01(base + effective / size);
      track(point);
      return sample();
    },
    end(point) {
      if (phase !== 'captured') {
        phase = phase === 'pending' ? 'cancelled' : phase;
        return { phase, progress: base, open: config.open };
      }
      if (point) {
        track(point);
        const main = mainDelta(point);
        const effective = main - Math.sign(main) * GESTURE_DEAD_ZONE_PX;
        progress = clamp01(base + effective / size);
      }
      const v = velocity();
      phase = 'done';
      if (v >= GESTURE_FLICK_VELOCITY) return { phase, progress: 1, open: true };
      if (v <= -GESTURE_FLICK_VELOCITY) return { phase, progress: 0, open: false };
      // Порог симметричен: закрыть открытую панель тоже надо «заметным» ходом.
      const threshold = config.open ? 1 - GESTURE_COMMIT_PROGRESS : GESTURE_COMMIT_PROGRESS;
      const open = progress >= threshold;
      return { phase, progress: open ? 1 : 0, open };
    },
    cancel() {
      phase = 'cancelled';
      progress = 0;
      return { phase, progress: 0, open: false };
    },
  };
}
