import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { SearchSelect } from '../components/SearchSelect.js';

export function SettingsPage() {
  const [loggingEnabled, setLoggingEnabled] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [backupLoading, setBackupLoading] = useState<boolean>(false);
  const [backupStatus, setBackupStatus] = useState<{ mode: 'live' | 'backup'; backupDate: string | null } | null>(null);
  const [backupList, setBackupList] = useState<Array<{ date: string; name: string; size: number | null; modified: string | null }>>([]);
  const [backupPick, setBackupPick] = useState<string | null>(null);

  async function loadSettings() {
    try {
      setLoading(true);
      const r = await window.matrica.logging.getEnabled();
      if (r.ok) {
        setLoggingEnabled(r.enabled);
      } else {
        setStatus(`Ошибка загрузки: ${r.error}`);
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function refreshBackups() {
    try {
      setBackupLoading(true);
      const st = await window.matrica.backups.status().catch(() => null);
      if (st && (st as any).ok === true) setBackupStatus({ mode: (st as any).mode, backupDate: (st as any).backupDate ?? null });

      const r = await window.matrica.backups.nightlyList();
      if (!r.ok) {
        setStatus(`Ошибка резервных копий: ${r.error}`);
        return;
      }
      setBackupList(r.backups ?? []);
    } catch (e) {
      setStatus(`Ошибка резервных копий: ${String(e)}`);
    } finally {
      setBackupLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
    void refreshBackups();
  }, []);

  async function handleToggleLogging() {
    try {
      setStatus('Сохранение...');
      const newValue = !loggingEnabled;
      const r = await window.matrica.logging.setEnabled(newValue);
      if (r.ok) {
        setLoggingEnabled(newValue);
        setStatus(newValue ? 'Отправка логов включена' : 'Отправка логов отключена');
        setTimeout(() => setStatus(''), 2000);
      } else {
        setStatus(`Ошибка: ${r.error}`);
      }
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  if (loading) {
    return <div style={{ padding: 20, color: '#6b7280' }}>Загрузка настроек...</div>;
  }

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ marginTop: 0, marginBottom: 20 }}>Настройки</h2>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Отправка логов на сервер</h3>
        <p style={{ color: '#6b7280', marginBottom: 16 }}>
          При включении логи работы клиента будут отправляться на сервер для диагностики проблем. Логи сохраняются в папку{' '}
          <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: 4 }}>logs/</code> на сервере.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button onClick={() => void handleToggleLogging()} variant={loggingEnabled ? 'ghost' : 'primary'}>
            {loggingEnabled ? 'Отключить отправку логов' : 'Включить отправку логов'}
          </Button>
          {loggingEnabled && <span style={{ color: '#059669' }}>✓ Включено</span>}
          {!loggingEnabled && <span style={{ color: '#6b7280' }}>Отключено</span>}
        </div>
      </div>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 20, marginBottom: 20 }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Ночные резервные копии базы</h3>
        <p style={{ color: '#6b7280', marginBottom: 16 }}>
          Выберите ночную резервную копию и откройте её в режиме просмотра. В этом режиме синхронизация отключена, данные изменять нельзя.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <SearchSelect
                value={backupPick}
                options={backupList.map((b) => ({ id: b.date, label: b.date }))}
                placeholder={backupLoading ? 'Загрузка…' : backupList.length ? 'Выберите дату…' : 'Резервных копий нет'}
                disabled={backupLoading || backupList.length === 0 || backupStatus?.mode === 'backup'}
                onChange={setBackupPick}
              />
            </div>
            <Button
              onClick={() => void refreshBackups()}
              variant="ghost"
              disabled={backupLoading}
              title="Обновить список резервных копий"
            >
              Обновить
            </Button>
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              onClick={() => {
                void (async () => {
                  setStatus('Запуск резервного копирования…');
                  const r = await window.matrica.backups.nightlyRunNow();
                  if (r.ok) {
                    setStatus('Резервное копирование запущено на сервере.');
                    // Через пару секунд обновим список, чтобы новая дата появилась (если ещё не была).
                    setTimeout(() => void refreshBackups(), 4000);
                  } else {
                    setStatus(`Ошибка: ${r.error}`);
                  }
                })();
              }}
              variant="ghost"
              disabled={backupLoading}
              title="Запустить ночной бэкап прямо сейчас на сервере"
            >
              Сделать бэкап сейчас
            </Button>

            <Button
              onClick={() => {
                if (!backupPick) return;
                void (async () => {
                  setStatus('Загрузка резервной копии…');
                  const r = await window.matrica.backups.nightlyEnter({ date: backupPick });
                  if (r.ok) {
                    setStatus('Открыт режим просмотра резервной копии.');
                    setBackupStatus({ mode: 'backup', backupDate: backupPick });
                  } else {
                    setStatus(`Ошибка: ${r.error}`);
                  }
                })();
              }}
              variant="primary"
              disabled={backupLoading || !backupPick || backupStatus?.mode === 'backup'}
            >
              Открыть резервную копию
            </Button>

            <Button
              onClick={() => {
                void (async () => {
                  setStatus('Выход из режима просмотра…');
                  const r = await window.matrica.backups.exit();
                  if (r.ok) {
                    setStatus('Возврат к актуальной базе выполнен.');
                    setBackupStatus({ mode: 'live', backupDate: null });
                  } else {
                    setStatus(`Ошибка: ${r.error}`);
                  }
                })();
              }}
              variant="ghost"
              disabled={backupLoading || backupStatus?.mode !== 'backup'}
            >
              Выйти из режима просмотра
            </Button>

            {backupStatus?.mode === 'backup' && (
              <span style={{ color: '#b91c1c', fontWeight: 800 }}>
                Сейчас открыт просмотр: {backupStatus.backupDate ?? '—'}
              </span>
            )}
          </div>
        </div>
      </div>

      {status && (
        <div style={{ marginTop: 16, padding: 12, background: status.startsWith('Ошибка') ? '#fee2e2' : '#d1fae5', color: status.startsWith('Ошибка') ? '#991b1b' : '#065f46', borderRadius: 8 }}>
          {status}
        </div>
      )}
    </div>
  );
}

