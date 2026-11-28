// Подготовленный список номеров — на стороне окна.
//
// Действие агента живёт в main, окно «Добавить двигатели списком» — здесь. Пачка
// лежит в main, и окно забирает её при открытии (`take`), чтобы список не всплыл
// дважды.
//
// СОБЫТИЕ. Main сообщает окну, что пачка готова. Оно нужно для кнопки нейросети
// (открыть окно с готовым списком) — но само по себе ничего не подставляет: подстановка
// происходит в момент открытия окна.

import type { AgentPreparedAddBatch } from '@matricarmz/shared';

let pending: AgentPreparedAddBatch | null = null;
let watching = false;

/** Подписаться на «пачка готова». Подписка одна на всю программу. */
export function watchPreparedAdd(): void {
  if (watching) return;
  watching = true;
  window.matrica.agentActions.onPreparedAdd((batch) => {
    pending = batch ?? null;
  });
}

/** Посмотреть готовую пачку, не забирая её. */
export function peekPreparedAdd(): AgentPreparedAddBatch | null {
  return pending;
}
/**
 * Забрать готовую пачку для программы.
 *
 * `take` в main: пачка уходит из склада, и второй раз в то же окно она не подставится.
 */
export async function takePreparedAdd(programId: string | null): Promise<AgentPreparedAddBatch | null> {
  try {
    const res = await window.matrica.agentActions.preparedAdd({ programId, take: true });
    const batch = res?.ok ? res.batch : null;
    if (batch) pending = null;
    return batch ?? null;
  } catch {
    return null;
  }
}
