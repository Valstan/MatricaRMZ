import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { db } from '../database/db.js';
import { diagnosticsEntityDiffs } from '../database/schema.js';
import { getEntityDetails } from './adminMasterdataService.js';

type EntityPayload = {
  id: string;
  updatedAt?: number | null;
  createdAt?: number | null;
  attributes?: Record<string, unknown>;
};

type EntityDiffItem = {
  key: string;
  status: 'diff' | 'missing_server' | 'missing_client';
  serverValue: unknown;
  clientValue: unknown;
};

function normalizeValue(v: unknown): string | null {
  if (v == null) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function buildDiff(server: EntityPayload, client: EntityPayload): EntityDiffItem[] {
  const serverAttrs = server.attributes ?? {};
  const clientAttrs = client.attributes ?? {};
  const keys = new Set([...Object.keys(serverAttrs), ...Object.keys(clientAttrs)]);
  const out: EntityDiffItem[] = [];
  for (const key of keys) {
    const s = (serverAttrs as any)[key];
    const c = (clientAttrs as any)[key];
    const sn = normalizeValue(s);
    const cn = normalizeValue(c);
    if (sn === cn) continue;
    if (sn == null && cn != null) {
      out.push({ key, status: 'missing_server', serverValue: null, clientValue: c });
      continue;
    }
    if (sn != null && cn == null) {
      out.push({ key, status: 'missing_client', serverValue: s, clientValue: null });
      continue;
    }
    out.push({ key, status: 'diff', serverValue: s, clientValue: c });
  }
  return out;
}

export async function storeEntityDiff(args: { clientId: string; entityId: string; clientEntity: EntityPayload }) {
  const serverEntity = await getEntityDetails(args.entityId);
  const serverPayload: EntityPayload = {
    id: serverEntity.id,
    updatedAt: serverEntity.updatedAt ?? null,
    createdAt: serverEntity.createdAt ?? null,
    attributes: serverEntity.attributes ?? {},
  };
  const clientPayload: EntityPayload = {
    id: args.clientEntity.id,
    updatedAt: args.clientEntity.updatedAt ?? null,
    createdAt: args.clientEntity.createdAt ?? null,
    attributes: args.clientEntity.attributes ?? {},
  };
  const diff = buildDiff(serverPayload, clientPayload);
  const payload = {
    clientId: args.clientId,
    entityId: args.entityId,
    createdAt: Date.now(),
    server: serverPayload,
    client: clientPayload,
    diff,
  };
  const id = randomUUID();
  await db.insert(diagnosticsEntityDiffs).values({
    id,
    clientId: args.clientId,
    entityId: args.entityId as any,
    payloadJson: JSON.stringify(payload),
    createdAt: payload.createdAt,
  });
  return payload;
}

export async function getLatestEntityDiff(clientId: string, entityId: string) {
  const rows = await db
    .select()
    .from(diagnosticsEntityDiffs)
    .where(and(eq(diagnosticsEntityDiffs.clientId, clientId), eq(diagnosticsEntityDiffs.entityId, entityId as any)))
    .orderBy(desc(diagnosticsEntityDiffs.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  try {
    return JSON.parse(String(row.payloadJson));
  } catch {
    return null;
  }
}
