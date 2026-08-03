// Шим services/watchdogHandshakeService.ts (android): внешнего watchdog-процесса
// на планшете нет, handshake-файл писать некуда и незачем. No-op.
export async function writeWatchdogHandshake(_args: {
  clientId: string;
  apiBaseUrl: string;
  version: string;
}): Promise<void> {
  // намеренно пусто
}
