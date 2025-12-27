import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';

export function SettingsPage() {
  const [loggingEnabled, setLoggingEnabled] = useState<boolean>(false);
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);

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

  useEffect(() => {
    void loadSettings();
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

      {status && (
        <div style={{ marginTop: 16, padding: 12, background: status.startsWith('Ошибка') ? '#fee2e2' : '#d1fae5', color: status.startsWith('Ошибка') ? '#991b1b' : '#065f46', borderRadius: 8 }}>
          {status}
        </div>
      )}
    </div>
  );
}

