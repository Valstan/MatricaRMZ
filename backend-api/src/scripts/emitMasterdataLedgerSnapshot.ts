import { emitAllMasterdataSyncSnapshot } from '../services/masterdataSyncService.js';

(async () => {
  await emitAllMasterdataSyncSnapshot();
  console.log('сформирован снимок мастерданных для синхронизации');
})().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
