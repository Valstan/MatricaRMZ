// Шим utils/logger.ts (android): файлового лога в WebView нет — пишем в
// console и кольцевой буфер (пригодится для отправки диагностики/лога с планшета).

const RING_LIMIT = 2000;
const ring: string[] = [];

export function appendMainLogLine(_app: unknown, message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  ring.push(line);
  if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
  // eslint-disable-next-line no-console
  console.log(line);
}

export function readRecentLogLines(): string[] {
  return [...ring];
}
