import { Router } from 'express';

import { backendVersion } from '../version.js';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.json({
    ok: true,
    version: backendVersion,
    buildDate: process.env.BUILD_DATE ?? null,
  });
});


