import { useCallback, useEffect, useState } from 'react';

import type { TrustRootStatus } from '@matricarmz/shared';

/**
 * Состояние доверия и подписи на стороне окна: опрос машины и две установки (ADR-0003).
 *
 * Один хук на два места — панель в окне обслуживания и подсказка при старте. Дублировать
 * логику установки в двух компонентах нельзя: они разъедутся (и это будет выглядеть как
 * «в подсказке кнопка работает, а в окне — нет»).
 */
export function useTrustRoot(
  opts: { notify?: ((text: string, tone?: 'info' | 'error') => void) | undefined } = {},
) {
  const [status, setStatus] = useState<TrustRootStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (force = false) => {
    try {
      const s = await window.matrica.trustRoot.status({ force });
      setStatus(s);
      return s;
    } catch {
      setStatus(null);
      return null;
    }
  }, []);

  const installUser = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.matrica.trustRoot.installUser();
      if (!res.ok) {
        opts.notify?.(res.error ?? 'Не удалось поставить корень.', 'error');
      } else {
        opts.notify?.('Корень поставлен в ваше хранилище — Windows доверяет подписи программы.');
      }
      await refresh(true);
      return res.ok;
    } catch (e) {
      opts.notify?.(`Не удалось поставить корень: ${String(e)}`, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [opts, refresh]);

  const installMachine = useCallback(async () => {
    setBusy(true);
    try {
      // Шаг с правами администратора: Windows спросит пароль, окно скрипта будет видно.
      const res = await window.matrica.trustRoot.installMachine();
      if (!res.ok) {
        opts.notify?.(res.error ?? 'Не удалось поставить корень на всю машину.', 'error');
      } else {
        opts.notify?.('Корень поставлен в машинные хранилища.');
      }
      await refresh(true);
      return res.ok;
    } catch (e) {
      opts.notify?.(`Не удалось поставить корень на всю машину: ${String(e)}`, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }, [opts, refresh]);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  return { status, busy, refresh, installUser, installMachine };
}
