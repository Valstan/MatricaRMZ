/**
 * aiChatRoutineIO — CLI-обёртка операций облачной AI-рутины (SSH-путь).
 * Логика — в services/ai/aiChatRoutineService.ts (общая с REST /ai-chat/routine,
 * которым пользуется облачный контейнер claude.ai без SSH).
 *
 * Команды (вывод — одна JSON-строка в stdout):
 *   list-pending
 *   post-answer --id <uuid> --answer-file <path.md> [--attach <path>]... [--expect-updated-at <ms>] [--reject]
 *   escalate --id <uuid> --reason-file <path>
 *   get-rules / set-rules --file <path> [--changed-by <who>]
 *   post-digest --file <path.md> [--title <text>] [--attach <path>]...
 *   mark-run
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { pool } from '../database/db.js';
import {
  routineEscalate,
  routineGetRules,
  routineListPending,
  routineMarkRun,
  routinePostAnswer,
  routinePostDigest,
  routineSetRules,
  type RoutineAttachment,
} from '../services/ai/aiChatRoutineService.js';
import { backendVersion as appVersion } from '../version.js';

function argValue(name: string): string | null {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx < 0) return null;
  const v = process.argv[idx + 1];
  return v && !v.startsWith('--') ? v : null;
}

function argValues(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}`) {
      const v = process.argv[i + 1];
      if (v && !v.startsWith('--')) out.push(v);
    }
  }
  return out;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function out(obj: Record<string, unknown>) {
  console.log(JSON.stringify({ version: appVersion, ...obj }));
}

function readAttachments(): RoutineAttachment[] {
  return argValues('attach').map((p) => ({
    name: basename(p),
    contentBase64: readFileSync(p).toString('base64'),
  }));
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'list-pending':
      return out(await routineListPending());
    case 'post-answer': {
      const id = argValue('id');
      const answerFile = argValue('answer-file');
      if (!id || !answerFile)
        throw new Error('usage: post-answer --id <uuid> --answer-file <path> [--attach <path>]... [--expect-updated-at <ms>] [--reject]');
      const expect = argValue('expect-updated-at');
      return out(
        await routinePostAnswer({
          id,
          answerText: readFileSync(answerFile, 'utf8'),
          reject: hasFlag('reject'),
          expectUpdatedAt: expect == null ? null : Number(expect),
          attachments: readAttachments(),
        }),
      );
    }
    case 'escalate': {
      const id = argValue('id');
      const reasonFile = argValue('reason-file');
      if (!id || !reasonFile) throw new Error('usage: escalate --id <uuid> --reason-file <path>');
      return out(await routineEscalate({ id, reason: readFileSync(reasonFile, 'utf8').trim() }));
    }
    case 'get-rules':
      return out(await routineGetRules());
    case 'set-rules': {
      const file = argValue('file');
      if (!file) throw new Error('usage: set-rules --file <path> [--changed-by <who>]');
      return out(await routineSetRules({ rulesMd: readFileSync(file, 'utf8'), changedBy: argValue('changed-by') }));
    }
    case 'post-digest': {
      const file = argValue('file');
      if (!file) throw new Error('usage: post-digest --file <path.md> [--title <text>] [--attach <path>]...');
      return out(
        await routinePostDigest({ digestMd: readFileSync(file, 'utf8'), title: argValue('title'), attachments: readAttachments() }),
      );
    }
    case 'mark-run':
      return out(await routineMarkRun());
    default:
      throw new Error(
        `unknown command: ${cmd ?? '(none)'}; commands: list-pending | post-answer | escalate | get-rules | set-rules | post-digest | mark-run`,
      );
  }
}

void main()
  .catch((e) => {
    out({ ok: false, error: String(e?.message ?? e) });
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end().catch(() => {});
  });
