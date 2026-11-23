import { useCallback, useEffect, useRef, useState } from 'react';

import {
  RAIL_AUTO_HIDE_IDLE_MS,
  railAutoHideDecision,
} from '../utils/railAutoHide.js';

/**
 * Левое меню планшета: уезжает за край после паузы (владелец 23.11.2026).
 *
 * Правило: полоса разделов на маленьком экране отнимает место у списка, поэтому
 * на планшетном режиме она сама убирается, когда оператор перестал трогать
 * экран, и возвращается по явному жесту (тап по ручке у левого края или свайп
 * от него же).
 *
 * Почему «любая активность перезапускает паузу», а не «активность возвращает
 * меню»: возврат по любому касанию означал бы, что полоса выскакивает при каждом
 * тапе по строке и снова уезжает — мигание. Здесь активность только откладывает
 * уход, а вернуть полосу можно осознанно (ручка/свайп) или кнопкой.
 *
 * На десктопе хук выключен (`enabled: false`): там полоса постоянна, и уезжать
 * ей незачем. Правило одно на программу, разница — в режиме, а не в коде.
 */
export function useAutoHideRail(opts: { enabled: boolean; idleMs?: number }) {
  const enabled = opts.enabled;
  const idleMs = opts.idleMs ?? RAIL_AUTO_HIDE_IDLE_MS;
  /** Меню уехало за край. */
  const [hidden, setHidden] = useState(false);
  /** Оператор держит полосу рукой — в этот момент авто-уезда нет. */
  const holdOpenRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  /** Последний перезапуск паузы — чтобы не переставлять таймер на каждом движении мыши. */
  const lastArmRef = useRef(0);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const arm = useCallback(
    (force = false) => {
      if (!enabled) return;
      const now = Date.now();
      // Троттлинг: палец/мышь шлёт события десятками в секунду, а таймер каждый раз
      // переставлять — лишняя работа на слабой машине. Полсекунды погрешности
      // для «после паузы» несущественны.
      if (!force && now - lastArmRef.current < 500) return;
      lastArmRef.current = now;
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!railAutoHideDecision({ enabled, holdOpen: holdOpenRef.current })) return;
        setHidden(true);
      }, idleMs);
    },
    [clearTimer, enabled, idleMs],
  );

  // Активность оператора откладывает уход. Слушаем документ: полоса — не единственное
  // место, где жмут, и «пауза» — это про весь экран.
  useEffect(() => {
    if (!enabled) return;
    const onActivity = () => arm();
    const passive: AddEventListenerOptions = { passive: true };
    document.addEventListener('pointerdown', onActivity, passive);
    document.addEventListener('pointermove', onActivity, passive);
    document.addEventListener('keydown', onActivity);
    document.addEventListener('wheel', onActivity, passive);
    arm(true);
    return () => {
      document.removeEventListener('pointerdown', onActivity, passive);
      document.removeEventListener('pointermove', onActivity, passive);
      document.removeEventListener('keydown', onActivity);
      document.removeEventListener('wheel', onActivity, passive);
      clearTimer();
    };
  }, [arm, clearTimer, enabled]);

  /** Вернуть полосу (осознанный жест оператора). */
  const reveal = useCallback(() => {
    setHidden(false);
    arm(true);
  }, [arm]);

  /** Убрать полосу руками, не дожидаясь паузы. */
  const hide = useCallback(() => setHidden(true), []);

  /** Оператор держит полосу (палец/мышь на ней) — авто-уезда в этот момент нет. */
  const setHoldOpen = useCallback(
    (value: boolean) => {
      holdOpenRef.current = value;
      if (value) arm(true);
    },
    [arm],
  );

  return { hidden, reveal, hide, setHoldOpen };
}
