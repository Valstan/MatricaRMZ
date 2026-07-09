import { subscribeLiveDataPulse } from '../services/liveDataService.js';

// Периодический опрос, «засыпающий» при скрытом окне (свёрнуто / не на экране): пока
// document.visibilityState === 'hidden', тик не дёргается — свёрнутый на ночь клиент не шлёт
// лишних запросов на прод. При возврате в фокус — немедленный опрос, чтобы бейдж/данные не были
// устаревшими. Ставить ТОЛЬКО на поллы без фонового побочного эффекта (визуальные бейджи,
// refresh-on-focus): не для чат-звука новых сообщений и не для presence-heartbeat (multi-user).
//
// Все вызовы сидят на едином 15-секундном pulse liveDataService (один setInterval на всех
// вместо таймера на каждый полл); intervalMs — троттлинг поверх pulse, поэтому фактический
// период кратен 15с (30_000 → каждый 2-й pulse, 60_000 → каждый 4-й).
export function pollWhenVisible(fn: () => void, intervalMs: number): () => void {
  // Все сайты вызова делают немедленный первичный опрос сами — первый pulse-тик
  // ждёт полный intervalMs (как ждал бы setInterval), без стадного прогона на t=15с.
  let lastRunAt = Date.now();
  return subscribeLiveDataPulse((pulse) => {
    if (pulse.reason === 'sync_done') return;
    if (document.visibilityState === 'hidden') return;
    if (pulse.reason === 'interval' && pulse.at - lastRunAt < intervalMs) return;
    // focus/visibility → немедленный опрос, но с полом 5с против шторма при частом alt-tab.
    if (pulse.reason !== 'interval' && pulse.at - lastRunAt < 5_000) return;
    lastRunAt = Date.now();
    fn();
  });
}
