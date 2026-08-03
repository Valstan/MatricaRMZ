// Шим 'node:fs/promises' (android): файловой системы у портированных сервисов
// нет. Единственный потребитель в бандле — десктопная ветка resetLocalDatabase,
// которая на android перекрыта setResetLocalDatabaseImpl и не исполняется.

export async function rm(_path: string, _opts?: unknown): Promise<never> {
  throw new Error("node:fs/promises shim: rm недоступен в android-клиенте");
}

export async function stat(_path: string): Promise<never> {
  throw new Error("node:fs/promises shim: stat недоступен в android-клиенте");
}

export default { rm, stat };
