export const IVANYCH_FIRST_ANSWER_POLL_DELAY_MS = 15_000;
export const IVANYCH_NEXT_ANSWER_POLL_DELAY_MS = 5_000;

export function startIvanychAnswerPolling(poll: () => Promise<void>, onCompleted: () => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pollAndScheduleNext = async () => {
    await poll();
    if (stopped) return;
    onCompleted();
    timer = setTimeout(() => void pollAndScheduleNext(), IVANYCH_NEXT_ANSWER_POLL_DELAY_MS);
  };
  timer = setTimeout(() => void pollAndScheduleNext(), IVANYCH_FIRST_ANSWER_POLL_DELAY_MS);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

const WAITING_STAGES = [
  'ИИваныч работает — проверяю, появился ли ответ',
  'ИИваныч собирает данные и готовит ответ',
  'ИИваныч обрабатывает найденное',
  'ИИваныч структурирует результат',
  'ИИваныч проводит последние проверки',
  'Осталось немного — жду готовый ответ',
] as const;

/**
 * Локальная индикация ожидания. Это не телеметрия этапов модели: строки меняются
 * только после проверки реплики и не создают дополнительных запросов к ИИ.
 */
export function ivanychWaitingText(status: 'pending' | 'processing', completedPolls: number): string {
  if (completedPolls <= 0) {
    return status === 'processing'
      ? 'ИИваныч начал работу — первый ответ проверим через 15 секунд'
      : 'ИИваныч принял вопрос — первая проверка через 15 секунд';
  }
  return WAITING_STAGES[(completedPolls - 1) % WAITING_STAGES.length] ?? WAITING_STAGES[0];
}
