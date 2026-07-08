// Периодический опрос, «засыпающий» при скрытом окне (свёрнуто / не на экране): пока
// document.visibilityState === 'hidden', тик не дёргается — свёрнутый на ночь клиент не шлёт
// лишних запросов на прод. При возврате в фокус — немедленный опрос, чтобы бейдж/данные не были
// устаревшими. Ставить ТОЛЬКО на поллы без фонового побочного эффекта (визуальные бейджи,
// refresh-on-focus): не для чат-звука новых сообщений и не для presence-heartbeat (multi-user).
export function pollWhenVisible(fn: () => void, intervalMs: number): () => void {
  let disposed = false;
  const id = window.setInterval(() => {
    if (!disposed && document.visibilityState !== 'hidden') fn();
  }, intervalMs);
  const onVisible = () => {
    if (!disposed && document.visibilityState === 'visible') fn();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    disposed = true;
    window.clearInterval(id);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
