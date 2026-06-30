// «Активное» время за работой (input-based). Лёгкий: пассивные слушатели обновляют lastInputAt,
// один 30-сек таймер начисляет тик в кумулятив за локальный день, если был ввод за последние
// IDLE_MS и вкладка видима. Дельта уходит в main по IPC и едет на существующем 60-сек heartbeat'е —
// без отдельных сетевых запросов.

export type ActiveState = { activeDate: string; activeMs: number };

// Pure: начислить один тик. Сбрасывает накопитель при смене локального дня (полночь).
export function accrueActive(
  state: ActiveState,
  opts: { now: number; lastInputAt: number; visible: boolean; tickMs: number; idleMs: number; today: string },
): ActiveState {
  const base = opts.today !== state.activeDate ? { activeDate: opts.today, activeMs: 0 } : state;
  const idle = opts.now - opts.lastInputAt >= opts.idleMs;
  if (idle || !opts.visible) return base;
  return { activeDate: base.activeDate, activeMs: base.activeMs + opts.tickMs };
}

export function localDateString(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const TICK_MS = 30_000;
const IDLE_MS = 5 * 60_000;

let started = false;

export function startActivityTracker(): () => void {
  if (started) return () => {};
  started = true;
  let lastInputAt = Date.now();
  let state: ActiveState = { activeDate: localDateString(Date.now()), activeMs: 0 };

  const onInput = () => {
    lastInputAt = Date.now();
  };
  const inputEvents = ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const;
  for (const ev of inputEvents) window.addEventListener(ev, onInput, { passive: true });
  const onVis = () => {
    if (document.visibilityState === 'visible') lastInputAt = Date.now();
  };
  document.addEventListener('visibilitychange', onVis);

  const timer = window.setInterval(() => {
    const now = Date.now();
    state = accrueActive(state, {
      now,
      lastInputAt,
      visible: document.visibilityState === 'visible',
      tickMs: TICK_MS,
      idleMs: IDLE_MS,
      today: localDateString(now),
    });
    try {
      window.matrica?.activity?.report({ activeDate: state.activeDate, activeMs: state.activeMs });
    } catch {
      // ignore — best-effort presence reporting
    }
  }, TICK_MS);

  return () => {
    started = false;
    window.clearInterval(timer);
    for (const ev of inputEvents) window.removeEventListener(ev, onInput);
    document.removeEventListener('visibilitychange', onVis);
  };
}
