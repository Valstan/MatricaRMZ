import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { commandIdempotency } from '../database/schema.js';

function nowMs() {
  return Date.now();
}

export async function getIdempotentCommandResult(args: { clientId: string; clientOperationId: string }) {
  const row = await db
    .select()
    .from(commandIdempotency)
    .where(and(eq(commandIdempotency.clientId, args.clientId), eq(commandIdempotency.clientOperationId, args.clientOperationId)))
    .limit(1);
  const hit = row[0];
  if (!hit?.responseJson) return null;
  try {
    const parsed = JSON.parse(String(hit.responseJson));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function saveIdempotentCommandResult(args: {
  clientId: string;
  clientOperationId: string;
  commandType: string;
  aggregateId?: string | null;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}) {
  const ts = nowMs();
  await db
    .insert(commandIdempotency)
    .values({
      id: randomUUID(),
      clientId: args.clientId,
      clientOperationId: args.clientOperationId,
      commandType: args.commandType,
      aggregateId: args.aggregateId == null ? null : String(args.aggregateId),
      requestJson: JSON.stringify(args.request),
      responseJson: JSON.stringify(args.response),
      status: 'applied',
      createdAt: ts,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: [commandIdempotency.clientId, commandIdempotency.clientOperationId],
      set: {
        responseJson: JSON.stringify(args.response),
        requestJson: JSON.stringify(args.request),
        commandType: args.commandType,
        aggregateId: args.aggregateId == null ? null : String(args.aggregateId),
        status: 'applied',
        updatedAt: ts,
      },
    });
}

