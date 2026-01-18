import 'dotenv/config';
import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';

import { db, pool } from '../database/db.js';
import { attributeDefs, attributeValues, entities, entityTypes } from '../database/schema.js';
import { hashPassword } from '../auth/password.js';
import { ensureEmployeeAuthDefs, getEmployeeAuthByLogin, getEmployeeTypeId, setEmployeeAuth, setEmployeeFullName } from '../services/employeeAuthService.js';

function nowMs() {
  return Date.now();
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) {
        args[k] = v;
        i++;
      } else {
        args[k] = 'true';
      }
    }
  }
  return args;
}

async function getEntityTypeIdByCode(code: string) {
  const rows = await db
    .select({ id: entityTypes.id })
    .from(entityTypes)
    .where(and(eq(entityTypes.code, code), isNull(entityTypes.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function getAttributeDefId(entityTypeId: string, code: string) {
  const rows = await db
    .select({ id: attributeDefs.id })
    .from(attributeDefs)
    .where(and(eq(attributeDefs.entityTypeId, entityTypeId as any), eq(attributeDefs.code, code), isNull(attributeDefs.deletedAt)))
    .limit(1);
  return rows[0]?.id ? String(rows[0].id) : null;
}

async function upsertAttributeValue(entityId: string, defId: string, value: unknown) {
  const ts = nowMs();
  const payloadJson = value == null ? null : JSON.stringify(value);
  const existing = await db
    .select({ id: attributeValues.id, createdAt: attributeValues.createdAt })
    .from(attributeValues)
    .where(and(eq(attributeValues.entityId, entityId as any), eq(attributeValues.attributeDefId, defId as any)))
    .limit(1);
  if (existing[0]) {
    await db
      .update(attributeValues)
      .set({ valueJson: payloadJson, updatedAt: ts, syncStatus: 'synced' })
      .where(eq(attributeValues.id, existing[0].id as any));
  } else {
    await db.insert(attributeValues).values({
      id: randomUUID(),
      entityId: entityId as any,
      attributeDefId: defId as any,
      valueJson: payloadJson,
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
      syncStatus: 'synced',
    });
  }
  await db.update(entities).set({ updatedAt: ts, syncStatus: 'synced' }).where(eq(entities.id, entityId as any));
}

async function ensureSectionEntity(sectionNameRaw: string): Promise<string | null> {
  const sectionName = String(sectionNameRaw ?? '').trim();
  if (!sectionName) return null;

  const sectionTypeId = await getEntityTypeIdByCode('section');
  if (!sectionTypeId) return null;
  const nameDefId = await getAttributeDefId(sectionTypeId, 'name');
  if (!nameDefId) return null;

  const existing = await db
    .select({ id: entities.id })
    .from(entities)
    .innerJoin(attributeValues, eq(attributeValues.entityId, entities.id))
    .where(
      and(
        eq(entities.typeId, sectionTypeId as any),
        isNull(entities.deletedAt),
        eq(attributeValues.attributeDefId, nameDefId as any),
        eq(attributeValues.valueJson, JSON.stringify(sectionName)),
        isNull(attributeValues.deletedAt),
      ),
    )
    .limit(1);

  if (existing[0]?.id) return String(existing[0].id);

  const ts = nowMs();
  const id = randomUUID();
  await db.insert(entities).values({
    id,
    typeId: sectionTypeId,
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  await db.insert(attributeValues).values({
    id: randomUUID(),
    entityId: id as any,
    attributeDefId: nameDefId as any,
    valueJson: JSON.stringify(sectionName),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    syncStatus: 'synced',
  });
  return id;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const usernameRaw = String(args.username ?? '').trim();
  const password = String(args.password ?? '').trim();
  const role = String(args.role ?? 'admin').trim() || 'admin';
  const fullName = String(args.fullName ?? '').trim();
  const position = String(args.position ?? '').trim();
  const sectionName = String(args.section ?? '').trim();

  if (!usernameRaw || !password) {
    console.error(
      'Usage: pnpm --filter @matricarmz/backend-api user:create -- --username <login> --password <pass> [--role admin|user] [--fullName "Name"] [--position "Job title"] [--section "Section name"]',
    );
    process.exit(2);
  }

  const login = usernameRaw.toLowerCase();
  const ts = nowMs();
  await ensureEmployeeAuthDefs();

  const passwordHash = await hashPassword(password);
  const existing = await getEmployeeAuthByLogin(login);
  if (existing) {
    await setEmployeeAuth(existing.id, { passwordHash, systemRole: role, accessEnabled: true, login });
    if (fullName) await setEmployeeFullName(existing.id, fullName);
    if (position) {
      const employeeTypeId = await getEmployeeTypeId();
      if (employeeTypeId) {
        const roleDefId = await getAttributeDefId(employeeTypeId, 'role');
        if (roleDefId) await upsertAttributeValue(existing.id, roleDefId, position);
      }
    }
    if (sectionName) {
      const employeeTypeId = await getEmployeeTypeId();
      if (employeeTypeId) {
        const sectionDefId = await getAttributeDefId(employeeTypeId, 'section_id');
        const sectionId = await ensureSectionEntity(sectionName);
        if (sectionDefId && sectionId) await upsertAttributeValue(existing.id, sectionDefId, sectionId);
      }
    }
    console.log(`Updated employee login: ${login} (id=${existing.id}, role=${role})`);
    return;
  }

  const employeeTypeId = await getEmployeeTypeId();
  if (!employeeTypeId) {
    console.error('Employee entity type not found');
    process.exit(1);
  }

  const id = randomUUID();
  await db.insert(entities).values({ id, typeId: employeeTypeId, createdAt: ts, updatedAt: ts, deletedAt: null, syncStatus: 'synced' });
  await setEmployeeAuth(id, { login, passwordHash, systemRole: role, accessEnabled: true });
  if (fullName) await setEmployeeFullName(id, fullName);
  if (position) {
    const roleDefId = await getAttributeDefId(employeeTypeId, 'role');
    if (roleDefId) await upsertAttributeValue(id, roleDefId, position);
  }
  if (sectionName) {
    const sectionDefId = await getAttributeDefId(employeeTypeId, 'section_id');
    const sectionId = await ensureSectionEntity(sectionName);
    if (sectionDefId && sectionId) await upsertAttributeValue(id, sectionDefId, sectionId);
  }

  console.log(`Created employee login: ${login} (id=${id}, role=${role})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });


