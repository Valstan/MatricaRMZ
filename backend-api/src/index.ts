import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { healthRouter } from './routes/health.js';
import { syncRouter } from './routes/sync.js';

const app = express();
// За reverse-proxy (nginx / панель провайдера) важно корректно понимать X-Forwarded-* заголовки.
app.set('trust proxy', true);
app.use(cors());
// Согласовано с nginx client_max_body_size (см. /etc/nginx/conf.d/matricarmz-backend.conf).
app.use(express.json({ limit: '20mb' }));

app.use('/health', healthRouter);
app.use('/sync', syncRouter);

const port = Number(process.env.PORT ?? 3001);
// По умолчанию слушаем только localhost и открываем наружу через nginx.
// Для отладки можно выставить HOST=0.0.0.0 (но лучше не делать в проде).
const host = process.env.HOST ?? '127.0.0.1';

app.listen(port, host, () => {
  console.log(`[backend-api] listening on ${host}:${port}`);
});


