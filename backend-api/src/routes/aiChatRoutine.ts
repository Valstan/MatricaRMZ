// REST-канал облачной AI-рутины: контейнер claude.ai не имеет SSH к проду,
// поэтому runner-операции доступны по HTTPS с bearer-токеном AI_ROUTINE_TOKEN
// (env прода; при отсутствии — весь роутер отвечает 503). Логика — в
// services/ai/aiChatRoutineService.ts (общая с CLI-скриптом aiChatRoutineIO).
import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import {
  routineEscalate,
  routineGetRules,
  routineListPending,
  routineMarkRun,
  routinePostAnswer,
  routinePostDigest,
  routineRunSelect,
  routineSetRules,
} from '../services/ai/aiChatRoutineService.js';

export const aiChatRoutineRouter = Router();

function tokenOk(header: string | undefined): boolean {
  const expected = (process.env.AI_ROUTINE_TOKEN ?? '').trim();
  if (!expected) return false;
  const got = String(header ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

aiChatRoutineRouter.use((req, res, next) => {
  if (!(process.env.AI_ROUTINE_TOKEN ?? '').trim()) {
    return res.status(503).json({ ok: false, error: 'AI_ROUTINE_TOKEN not configured' });
  }
  if (!tokenOk(req.headers.authorization)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return next();
});

function handle(fn: (body: any) => Promise<unknown>) {
  return async (req: any, res: any) => {
    try {
      return res.json(await fn(req.body ?? {}));
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: String(e?.message ?? e) });
    }
  };
}

aiChatRoutineRouter.get('/list-pending', handle(() => routineListPending()));
aiChatRoutineRouter.get('/get-rules', handle(() => routineGetRules()));
aiChatRoutineRouter.post('/post-answer', handle((b) => routinePostAnswer(b)));
aiChatRoutineRouter.post('/escalate', handle((b) => routineEscalate(b)));
aiChatRoutineRouter.post('/set-rules', handle((b) => routineSetRules(b)));
aiChatRoutineRouter.post('/post-digest', handle((b) => routinePostDigest(b)));
aiChatRoutineRouter.post('/mark-run', handle(() => routineMarkRun()));
aiChatRoutineRouter.post('/run-select', handle((b) => routineRunSelect(b)));
