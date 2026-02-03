import { emitAllMasterdataSyncSnapshot } from '../services/masterdataSyncService.js';

(async () => {
  await emitAllMasterdataSyncSnapshot();
  console.log('masterdata ledger snapshot emitted');
})().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
