import { replayLedgerToDb } from '../services/sync/ledgerReplayService.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';

async function main() {
  const superadminId = await getSuperadminUserId().catch(() => null);
  if (!superadminId) {
    throw new Error('Пользователь superadmin не найден');
  }
  const result = await replayLedgerToDb({ id: superadminId, username: 'superadmin', role: 'superadmin' });
  console.log(`[ledger-replay] applied=${result.applied}`);
}

main().catch((e) => {
  console.error('[ledger-replay] ошибка', e);
  process.exit(1);
});
