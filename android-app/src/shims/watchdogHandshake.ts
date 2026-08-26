// Шим services/watchdogHandshakeService.ts (android): внешнего watchdog-процесса
// на планшете нет, handshake-файл писать некуда и незачем. No-op.
export async function writeWatchdogHandshake(_args: {
  clientId: string;
  apiBaseUrl: string;
  version: string;
}): Promise<void> {
  // намеренно пусто
}

// Сторожа нет — значит нет и его автозапуска, о неудаче которого можно доложить.
// Экспорт существует только потому, что его импортирует общий clientAdminService:
// без него сборка планшета падает на резолве импорта (поймано в CI 2026-08-26).
export async function reportWatchdogAutostartIfBroken(_args: {
  clientId: string;
  apiBaseUrl: string;
  version: string;
}): Promise<void> {
  // намеренно пусто
}
