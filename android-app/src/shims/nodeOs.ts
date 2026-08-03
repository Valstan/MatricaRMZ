// Шим 'node:os' (android). hostname участвует в clientId и heartbeat —
// отдаём стабильное имя устройства из platform-хуков (модель планшета),
// с дефолтом 'android'.
import { getAndroidPlatformHooks } from './platform.js';

export function hostname(): string {
  const hooks = getAndroidPlatformHooks() as { deviceName?: () => string };
  const name = hooks.deviceName?.() ?? '';
  return (name || 'android').replace(/[^\w.-]+/g, '-').slice(0, 64);
}

export function tmpdir(): string {
  return '/tmp';
}

export default { hostname, tmpdir };
