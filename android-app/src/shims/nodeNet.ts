// Шим 'node:net' (android): TCP-сокетов у планшета нет.
//
// Потребитель в бандле — локальный ИИ-агент (`localMiniMax/dbBridge`): он
// поднимает на машине оператора мост к локальной БД. На планшете локального
// агента нет, и мост не нужен: ответ считает сервер.
export function createServer(..._args: unknown[]): never {
  throw new Error('на планшете нельзя поднимать TCP-сервер');
}

export function connect(..._args: unknown[]): never {
  throw new Error('на планшете нельзя открывать TCP-соединение');
}

export default { createServer, connect };
