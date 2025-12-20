import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import { healthRouter } from './routes/health.js';
import { syncRouter } from './routes/sync.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/health', healthRouter);
app.use('/sync', syncRouter);

const port = Number(process.env.PORT ?? 3001);

app.listen(port, () => {
  console.log(`[backend-api] listening on :${port}`);
});


