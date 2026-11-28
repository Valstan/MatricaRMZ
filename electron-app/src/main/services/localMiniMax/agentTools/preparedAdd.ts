// Подготовленный список двигателей — склад между действием агента и окном
// «Добавить двигатели списком».
//
// ЗАЧЕМ СКЛАД. Действие агента живёт в main, а окно — в renderer. Прокидывать
// список через IPC-вызов «сверху вниз» нельзя: действие приходит СНИЗУ (от агента по
// именованному каналу), и ответа сверху ждать не у кого. Значит, main кладёт пачку в
// склад и говорит окну «пачка готова», а окно забирает её, когда открывается.
//
// СРОК ЖИЗНИ. Пачка живёт, пока её не забрали (окно открылось) или пока не протухла
// (оператор передумал / открыл другое окно). Протухшая пачка не должна всплыть
// завтра в чужом окне — поэтому у неё есть срок.

import type { AgentPreparedAddBatch } from '@matricarmz/shared';

/** Сколько пачка ждёт окна. */
const BATCH_TTL_MS = 10 * 60 * 1000;

/** Сколько пачек держим: больше одной не нужно — оператор работает с одним списком. */
const MAX_BATCHES = 5;

const batches = new Map<string, AgentPreparedAddBatch>();

function prune(now: number): void {
  for (const [id, batch] of batches) {
    if (now - batch.createdAt > BATCH_TTL_MS) batches.delete(id);
  }
  while (batches.size > MAX_BATCHES) {
    const oldest = [...batches.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!oldest) break;
    batches.delete(oldest.id);
  }
}

/** Положить пачку на склад. */
export function rememberPreparedAdd(batch: AgentPreparedAddBatch): void {
  const now = Date.now();
  prune(now);
  batches.set(batch.id, batch);
}

/**
 * Забрать пачку для программы.
 *
 * ProgramId пустой — значит «текущая открытая»: берём пачку без привязки к программе.
 * Пачка для конкретной программы подходит и ей, и «текущей открытой».
 */
export function takePreparedAdd(programId: string | null): AgentPreparedAddBatch | null {
  const now = Date.now();
  prune(now);
  const wanted = String(programId ?? '').trim();
  const all = [...batches.values()].sort((a, b) => b.createdAt - a.createdAt);
  const match =
    all.find((batch) => wanted && batch.programId === wanted) ??
    all.find((batch) => !batch.programId) ??
    null;
  if (!match) return null;
  batches.delete(match.id);
  return match;
}

/** Посмотреть пачку, не забирая её (окно ещё не открылось). */
export function peekPreparedAdd(programId: string | null): AgentPreparedAddBatch | null {
  const now = Date.now();
  prune(now);
  const wanted = String(programId ?? '').trim();
  const all = [...batches.values()].sort((a, b) => b.createdAt - a.createdAt);
  return (
    all.find((batch) => wanted && batch.programId === wanted) ??
    all.find((batch) => !batch.programId) ??
    null
  );
}

/** Забыть пачки (например, оператор закрыл окно, не добавив ничего). */
export function clearPreparedAdds(): void {
  batches.clear();
}
