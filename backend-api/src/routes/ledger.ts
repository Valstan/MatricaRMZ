import { Router } from 'express';
import { z } from 'zod';
import { LedgerTableName, type LedgerTxType } from '@matricarmz/ledger';
import { syncRowSchemaByTable } from '@matricarmz/shared';
import { randomUUID } from 'node:crypto';
import { ensureLedgerBootstrap, listBlocksSince, queryState, signAndAppend } from '../ledger/ledgerService.js';
import { applyLedgerTxs } from '../services/sync/ledgerTxService.js';
import { pullChangesSince } from '../services/sync/pullChangesSince.js';
import type { AuthenticatedRequest } from '../auth/middleware.js';
import { db } from '../database/db.js';
import { syncState } from '../database/schema.js';

export const ledgerRouter = Router();

const syncRowSchemas: Record<string, (payload: unknown) => boolean> = Object.fromEntries(
  Object.entries(syncRowSchemaByTable).map(([table, schema]) => [table, (payload: unknown) => schema.safeParse(payload).success]),
);

const txSchema = z.object({
  type: z.enum(['upsert', 'delete', 'grant', 'revoke', 'presence', 'chat'] satisfies LedgerTxType[] as any),
  table: z.nativeEnum(LedgerTableName),
  row: z.record(z.unknown()).optional(),
  row_id: z.string().uuid().optional(),
});

ledgerRouter.post('/tx/submit', async (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  if (!user) return res.status(401).json({ ok: false, error: 'auth required' });
  const parsed = z
    .object({
      txs: z.array(txSchema).min(1).max(5000),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  try {
    const txs = parsed.data.txs.map((tx) => ({
      type: tx.type,
      table: tx.table,
      ...(tx.row != null ? { row: tx.row } : {}),
      ...(tx.row_id != null ? { row_id: tx.row_id } : {}),
    }));
    const result = await applyLedgerTxs(txs, { id: user.id, username: user.username, role: user.role });
    return res.json({
      ok: true,
      applied: result.ledgerApplied,
      db_applied: result.dbApplied,
      last_seq: result.lastSeq,
      block_height: result.blockHeight,
      applied_rows: result.appliedRows ?? [],
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e) });
  }
});

ledgerRouter.get('/state/query', (req, res) => {
  const parsed = z
    .object({
      table: z.nativeEnum(LedgerTableName),
      id: z.string().uuid().optional(),
      filter: z.string().optional(),
      sort_by: z.string().optional(),
      sort_dir: z.enum(['asc', 'desc']).optional(),
      include_deleted: z.coerce.boolean().optional(),
      date_field: z.string().optional(),
      date_from: z.coerce.number().int().optional(),
      date_to: z.coerce.number().int().optional(),
      like_field: z.string().optional(),
      like: z.string().optional(),
      regex_field: z.string().optional(),
      regex: z.string().optional(),
      regex_flags: z.string().optional(),
      or_filter: z.string().optional(),
      cursor_value: z.union([z.string(), z.number()]).optional(),
      cursor_id: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(20000).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    })
    .superRefine((data, ctx) => {
      if ((data.like && !data.like_field) || (!data.like && data.like_field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'like and like_field must be provided together' });
      }
      if ((data.regex && !data.regex_field) || (!data.regex && data.regex_field)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'regex and regex_field must be provided together' });
      }
      if (data.regex_flags && !/^[gimsuy]*$/.test(data.regex_flags)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'regex_flags must match /^[gimsuy]*$/' });
      }
      if ((data.cursor_value != null || data.cursor_id) && !data.sort_by) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'cursor pagination requires sort_by' });
      }
      if (data.date_from != null && data.date_to != null && data.date_from > data.date_to) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'date_from must be <= date_to' });
      }
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  let filter: Record<string, string> | undefined;
  if (parsed.data.filter) {
    try {
      filter = JSON.parse(parsed.data.filter) as Record<string, string>;
      const entries = Object.entries(filter);
      if (entries.length === 0) {
        return res.status(400).json({ ok: false, error: 'filter must not be empty' });
      }
      for (const [k, v] of entries) {
        if (!k || typeof v !== 'string' || !v.trim()) {
          return res.status(400).json({ ok: false, error: 'filter values must be non-empty strings' });
        }
      }
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid filter json' });
    }
  }
  let orFilter: Array<Record<string, string>> | undefined;
  if (parsed.data.or_filter) {
    try {
      orFilter = JSON.parse(parsed.data.or_filter) as Array<Record<string, string>>;
      if (!Array.isArray(orFilter) || orFilter.length === 0) {
        return res.status(400).json({ ok: false, error: 'or_filter must be a non-empty array' });
      }
      if (orFilter.length > 50) {
        return res.status(400).json({ ok: false, error: 'or_filter too large' });
      }
      for (const clause of orFilter) {
        if (!clause || typeof clause !== 'object') {
          return res.status(400).json({ ok: false, error: 'or_filter must contain objects' });
        }
        const entries = Object.entries(clause);
        if (entries.length === 0) {
          return res.status(400).json({ ok: false, error: 'or_filter clauses must not be empty' });
        }
        for (const [k, v] of entries) {
          if (!k || typeof v !== 'string' || !v.trim()) {
            return res.status(400).json({ ok: false, error: 'or_filter values must be non-empty strings' });
          }
        }
      }
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid or_filter json' });
    }
  }
  const opts = {
    ...(parsed.data.id ? { id: parsed.data.id } : {}),
    ...(filter ? { filter } : {}),
    ...(orFilter ? { orFilter } : {}),
    ...(parsed.data.sort_by ? { sortBy: parsed.data.sort_by } : {}),
    ...(parsed.data.sort_dir ? { sortDir: parsed.data.sort_dir } : {}),
    ...(parsed.data.include_deleted != null ? { includeDeleted: parsed.data.include_deleted } : {}),
    ...(parsed.data.date_field ? { dateField: parsed.data.date_field } : {}),
    ...(parsed.data.date_from != null ? { dateFrom: parsed.data.date_from } : {}),
    ...(parsed.data.date_to != null ? { dateTo: parsed.data.date_to } : {}),
    ...(parsed.data.like_field ? { likeField: parsed.data.like_field } : {}),
    ...(parsed.data.like ? { like: parsed.data.like } : {}),
    ...(parsed.data.regex_field ? { regexField: parsed.data.regex_field } : {}),
    ...(parsed.data.regex ? { regex: parsed.data.regex } : {}),
    ...(parsed.data.regex_flags ? { regexFlags: parsed.data.regex_flags } : {}),
    ...(parsed.data.cursor_value != null ? { cursorValue: parsed.data.cursor_value } : {}),
    ...(parsed.data.cursor_id ? { cursorId: parsed.data.cursor_id } : {}),
    ...(parsed.data.limit != null ? { limit: parsed.data.limit } : {}),
    ...(parsed.data.offset != null ? { offset: parsed.data.offset } : {}),
  };
  const rows = queryState(parsed.data.table, opts);
  return res.json({ ok: true, rows });
});

ledgerRouter.get('/state/changes', async (req, res) => {
  const syncV2Enforced = String(process.env.SYNC_V2_ENFORCE ?? '').trim() === '1';
  const parsed = z
    .object({
      since: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(20000).optional(),
      client_id: z.string().min(1).max(200).optional(),
      sync_protocol_version: z.coerce.number().int().optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const protocolVersion = Number(parsed.data.sync_protocol_version ?? 1);
  if (syncV2Enforced && protocolVersion < 2) {
    return res.status(426).json({
      ok: false,
      error: 'sync protocol upgrade required',
      required_sync_protocol_version: 2,
    });
  }
  if (parsed.data.since === 0) {
    await ensureLedgerBootstrap().catch(() => null);
  }
  const actor = (req as AuthenticatedRequest).user;
  if (!actor) return res.status(401).json({ ok: false, error: 'auth required' });
  const pull = await pullChangesSince(
    parsed.data.since,
    { id: String(actor.id), role: String(actor.role) },
    parsed.data.limit ?? 5000,
    { clientId: parsed.data.client_id ?? null },
  );
  const invalidCounts = new Map<string, number>();
  const filtered = pull.changes.filter((ch) => {
    const validator = syncRowSchemas[String(ch.table)];
    if (!validator) return true;
    try {
      const payload = JSON.parse(String(ch.payload_json ?? ''));
      const ok = validator(payload);
      if (!ok) invalidCounts.set(String(ch.table), (invalidCounts.get(String(ch.table)) ?? 0) + 1);
      return ok;
    } catch {
      invalidCounts.set(String(ch.table), (invalidCounts.get(String(ch.table)) ?? 0) + 1);
      return false;
    }
  });
  const lastSeq = pull.server_cursor;
  const clientId = parsed.data.client_id ?? actor?.id ?? null;
  if (clientId) {
    const now = Date.now();
    await db
      .insert(syncState)
      .values({
        clientId: String(clientId),
        lastPulledServerSeq: lastSeq,
        lastPulledAt: now,
        lastPushedAt: null,
      })
      .onConflictDoUpdate({
        target: syncState.clientId,
        set: {
          lastPulledServerSeq: lastSeq,
          lastPulledAt: now,
        },
      });
  }
  return res.json({
    sync_protocol_version: 2,
    sync_mode: 'incremental',
    server_cursor: pull.server_cursor,
    server_last_seq: pull.server_last_seq,
    has_more: pull.has_more,
    changes: filtered,
  });
});

ledgerRouter.get('/blocks', (req, res) => {
  const parsed = z
    .object({
      since: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(2000).optional(),
    })
    .safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
  const blocks = listBlocksSince(parsed.data.since, parsed.data.limit ?? 200);
  const lastHeight = blocks.at(-1)?.height ?? parsed.data.since;
  return res.json({ ok: true, last_height: lastHeight, blocks });
});

ledgerRouter.post('/releases/publish', (req, res) => {
  const user = (req as AuthenticatedRequest).user;
  if (!user) return res.status(401).json({ ok: false, error: 'auth required' });
  const role = String(user.role ?? '').toLowerCase();
  const isAdmin = role === 'admin' || role === 'superadmin';
  if (!isAdmin) return res.status(403).json({ ok: false, error: 'admin only' });

  const parsed = z
    .object({
      version: z.string().min(1),
      notes: z.string().optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
      fileName: z.string().min(1).optional(),
      size: z.number().int().positive().optional(),
      metadata: z.record(z.unknown()).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

  const now = Date.now();
  const row = {
    id: randomUUID(),
    version: parsed.data.version,
    notes: parsed.data.notes ?? null,
    sha256: parsed.data.sha256 ?? null,
    file_name: parsed.data.fileName ?? null,
    size: parsed.data.size ?? null,
    payload_json: parsed.data.metadata ? JSON.stringify(parsed.data.metadata) : null,
    created_at: now,
    created_by_user_id: user.id,
    created_by_username: user.username,
  };
  const result = signAndAppend([
    {
      type: 'upsert',
      table: LedgerTableName.ReleaseRegistry,
      row,
      row_id: row.id,
      actor: { userId: user.id, username: user.username, role: user.role },
      ts: now,
    },
  ]);
  return res.json({ ok: true, applied: result.applied, last_seq: result.lastSeq });
});

ledgerRouter.get('/releases/latest', (req, res) => {
  const rows = queryState(LedgerTableName.ReleaseRegistry, {
    sortBy: 'created_at',
    sortDir: 'desc',
    limit: 1,
    includeDeleted: false,
  });
  return res.json({ ok: true, release: rows[0] ?? null });
});
