// Приветствие Диспетчера при включении программы: сообщаем свою версию, hostname и
// платформу, получаем план обновления и (в будущем) советы. Fire-and-forget: сбой
// сети не мешает запуску — обновления и так проверяются своим циклом updateService.
// Диспетчер — расширяемая точка координации экосистемы (см. backend routes/dispatcher.ts).

import { hostname } from 'node:os';

import { app } from 'electron';

export async function dispatcherCheckin(apiBaseUrl: string): Promise<void> {
  const base = String(apiBaseUrl ?? '').replace(/\/+$/, '');
  if (!base) return;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  try {
    await fetch(`${base}/dispatcher/checkin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: app.getVersion(), hostname: hostname(), platform: process.platform }),
      signal: controller.signal,
    });
  } catch {
    // молча: приветствие не критично для работы программы
  } finally {
    clearTimeout(t);
  }
}
