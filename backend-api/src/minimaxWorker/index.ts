// Вход воркера MiniMax (промт КАРМАНА #56, план #57).
//
// Отдельный сервис: свой systemd-юнит, свой порт, своя роль инстанса
// (`MATRICA_INSTANCE_ROLE=worker`). Фоновые джобы бэкенда он не поднимает —
// очередь ИИваныча разбирает primary, второй разбор тот же вопрос означал бы
// двойной ответ.

import { loadConfig } from './config.js';
import { createWorkerApp } from './server.js';
import { logError, logInfo } from '../utils/logger.js';

if (!process.env.TZ) {
  process.env.TZ = 'Europe/Moscow';
}

const config = loadConfig();
const { app } = createWorkerApp(config);

const server = app.listen(config.port, config.host, () => {
  logInfo(
    'minimax worker: слушаю',
    {
      host: config.host,
      port: config.port,
      cli: config.cli,
      model: config.model,
      pool: config.karmanApiBase ? 'configured' : 'not_configured',
      token: config.karmanToken ? 'env' : 'vault',
    },
    { critical: true },
  );
});

server.on('error', (error: NodeJS.ErrnoException) => {
  logError('minimax worker: порт недоступен', { error: String(error), port: config.port });
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logInfo('minimax worker: останавливаюсь', { signal });
    server.close(() => process.exit(0));
  });
}
