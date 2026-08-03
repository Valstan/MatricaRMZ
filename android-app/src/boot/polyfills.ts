// Полифиллы WebView, обязаны исполниться ДО портированных сервисов.
// Buffer нужен authService'у (Buffer.from(hex,'hex') при чтении сессии);
// в vitest на Node он нативный, полифилл срабатывает только в браузере.
import { Buffer } from 'buffer';

const g = globalThis as { Buffer?: typeof Buffer; process?: unknown };
if (!g.Buffer) g.Buffer = Buffer;

// Портированные сервисы читают process.platform/arch/env (heartbeat, env-флаги).
if (!g.process) {
  g.process = { platform: 'android', arch: 'arm64', env: {} };
}
