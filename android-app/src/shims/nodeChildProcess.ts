// Шим 'node:child_process' (android): дочерних процессов у планшета нет.
//
// Потребители в бандле: синхронизация часов службой времени Windows
// (`clockSkewService`) и локальный ИИ-агент (`localMiniMax/agentRunner`) —
// оба живут на машине оператора, на планшете им нечего запускать. Каналы,
// которые их зовут, мост перекрывает явным отказом с причиной (см.
// `core/tabletDomains.ts`).
export function execFile(..._args: unknown[]): never {
  throw new Error('на планшете нельзя запускать дочерние процессы');
}

export function exec(..._args: unknown[]): never {
  throw new Error('на планшете нельзя запускать дочерние процессы');
}

export function spawn(..._args: unknown[]): never {
  throw new Error('на планшете нельзя запускать дочерние процессы');
}

export default { execFile, exec, spawn };
