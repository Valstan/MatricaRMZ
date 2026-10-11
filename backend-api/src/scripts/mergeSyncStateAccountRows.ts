// M102: heartbeat push'а (`sync_state.last_pushed_at`) шёл по id аккаунта, а не
// машины — у машин колонка пуста, а «аккаунты» выглядят машинами-призраками.
// Путь push'а починен (client_id в теле /ledger/tx/submit), здесь — разовая
// чистка накопленных строк: однозначные мёрджим в строку машины, остальные
// удаляем. Идемпотентно: повторный прогон находит пустой план.
//
// Запуск: corepack pnpm -F @matricarmz/backend-api sync:merge-account-rows        (dry-run)
//         corepack pnpm -F @matricarmz/backend-api sync:merge-account-rows --apply
import { eq } from 'drizzle-orm';

import { db } from '../database/db.js';
import { clientSettings, syncState, users } from '../database/schema.js';

const APPLY = process.argv.includes('--apply');

export type SyncStateLiteRow = {
  clientId: string;
  lastPushedAt: number | null;
};

export type SyncStateMergePlan = {
  /** account -> единственная машина: перенести max(lastPushedAt), строку аккаунта удалить. */
  merge: Array<{ account: string; machine: string; pushedAt: number | null }>;
  /** Удалить без переноса: нет машин, машин несколько или строка ни к чему не привязана. */
  remove: Array<{ account: string; reason: string }>;
  /** Не трогать: машины (`HOST-uuid`), служебные (`system`, `ledger-replay`, …). */
  kept: string[];
};

const UUID_ONLY_RE = /^[0-9a-fA-F-]{36}$/;

export function planSyncStateAccountMerge(args: {
  syncRows: SyncStateLiteRow[];
  /** userId -> login (users.id — это и есть id аккаунта-строки). */
  userLoginById: ReadonlyMap<string, string>;
  /** login (нижний регистр) -> client_id машин из client_settings. */
  machineIdsByLogin: ReadonlyMap<string, string[]>;
}): SyncStateMergePlan {
  const plan: SyncStateMergePlan = { merge: [], remove: [], kept: [] };
  const syncIds = new Set(args.syncRows.map((r) => r.clientId));
  for (const row of args.syncRows) {
    const id = String(row.clientId ?? '');
    if (!UUID_ONLY_RE.test(id)) {
      plan.kept.push(id);
      continue;
    }
    const login = args.userLoginById.get(id);
    if (!login) {
      plan.remove.push({ account: id, reason: 'ничейный uuid (нет в users)' });
      continue;
    }
    const machines = (args.machineIdsByLogin.get(login.toLowerCase()) ?? []).filter((m) => m !== id && syncIds.has(m));
    if (machines.length === 1) {
      plan.merge.push({ account: id, machine: machines[0] as string, pushedAt: row.lastPushedAt });
    } else {
      plan.remove.push({ account: id, reason: machines.length === 0 ? 'нет строк машин' : `машин несколько: ${machines.length}` });
    }
  }
  return plan;
}

async function main() {
  const syncRows = await db
    .select({ clientId: syncState.clientId, lastPushedAt: syncState.lastPushedAt })
    .from(syncState);
  const userRows = await db.select({ id: users.id, login: users.login }).from(users);
  const settingsRows = await db
    .select({ clientId: clientSettings.clientId, lastUsername: clientSettings.lastUsername })
    .from(clientSettings);
  const userLoginById = new Map(userRows.map((u) => [String(u.id), String(u.login ?? '')]));
  const machineIdsByLogin = new Map<string, string[]>();
  for (const s of settingsRows) {
    const login = String(s.lastUsername ?? '').trim().toLowerCase();
    if (!login) continue;
    const list = machineIdsByLogin.get(login) ?? [];
    list.push(String(s.clientId));
    machineIdsByLogin.set(login, list);
  }
  const plan = planSyncStateAccountMerge({ syncRows, userLoginById, machineIdsByLogin });
  console.log(`sync_state строк: ${syncRows.length}, слить: ${plan.merge.length}, удалить: ${plan.remove.length}, оставить: ${plan.kept.length}`);
  for (const m of plan.merge) {
    console.log(`  merge ${m.account} -> ${m.machine} (pushedAt ${m.pushedAt ?? 'null'})`);
  }
  for (const r of plan.remove) {
    console.log(`  delete ${r.account} (${r.reason})`);
  }
  if (!APPLY) {
    console.log('DRY-RUN: изменений не внесено. Запусти с --apply после подтверждения владельца.');
    return;
  }
  const pushedByMachine = new Map(syncRows.map((r) => [String(r.clientId), r.lastPushedAt ?? null]));
  for (const m of plan.merge) {
    const prev = pushedByMachine.get(m.machine) ?? null;
    const next = Math.max(Number(prev ?? 0), Number(m.pushedAt ?? 0)) || null;
    await db.update(syncState).set({ lastPushedAt: next }).where(eq(syncState.clientId, m.machine));
    await db.delete(syncState).where(eq(syncState.clientId, m.account));
  }
  for (const r of plan.remove) {
    await db.delete(syncState).where(eq(syncState.clientId, r.account));
  }
  console.log(`APPLY готово: слито ${plan.merge.length}, удалено ${plan.remove.length}.`);
}

const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('mergeSyncStateAccountRows.ts');
if (isDirectRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
