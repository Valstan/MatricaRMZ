import type { NextFunction, Request, Response } from 'express';
import { logError } from '../utils/logger.js';

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  // Express JSON parse errors come as SyntaxError with `status` 400 in many cases.
  const anyErr = err as any;
  const msg = anyErr?.message ? String(anyErr.message) : String(err);

  // Body parser invalid JSON
  if (anyErr instanceof SyntaxError && 'body' in (anyErr as any)) {
    return res.status(400).json({ ok: false, error: 'invalid json' });
  }

  logError('unhandled error', {
    method: req.method,
    url: req.originalUrl || req.url,
    message: msg,
  });
  return res.status(500).json({ ok: false, error: msg });
}


