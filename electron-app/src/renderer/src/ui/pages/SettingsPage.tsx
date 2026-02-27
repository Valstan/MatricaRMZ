import React, { useEffect, useState } from 'react';
import type { UiDisplayPrefs } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { SearchSelect } from '../components/SearchSelect.js';

export function SettingsPage(props: {
  uiPrefs: { theme: 'auto' | 'light' | 'dark'; chatSide: 'left' | 'right'; enterAsTab: boolean; displayPrefs: UiDisplayPrefs };
  onUiPrefsChange: (prefs: {
    theme: 'auto' | 'light' | 'dark';
    chatSide: 'left' | 'right';
    enterAsTab: boolean;
    displayPrefs: UiDisplayPrefs;
  }) => void;
  onLogout: () => void;
}) {
  const [loggingEnabled, setLoggingEnabled] = useState<boolean>(false);
  const [loggingMode, setLoggingMode] = useState<'prod' | 'dev'>('prod');
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [authUser, setAuthUser] = useState<{ id: string; username: string; role: string } | null>(null);
  const [profileUser, setProfileUser] = useState<{ login: string; role: string } | null>(null);
  const [telegramLogin, setTelegramLogin] = useState<string>('');
  const [maxLogin, setMaxLogin] = useState<string>('');
  const [messengerStatus, setMessengerStatus] = useState<string>('');
  const [uiTheme, setUiTheme] = useState<'auto' | 'light' | 'dark'>(props.uiPrefs.theme);
  const [chatSide, setChatSide] = useState<'left' | 'right'>(props.uiPrefs.chatSide);
  const [enterAsTab, setEnterAsTab] = useState<boolean>(props.uiPrefs.enterAsTab === true);
  const [pwCurrent, setPwCurrent] = useState<string>('');
  const [pwNew, setPwNew] = useState<string>('');
  const [pwRepeat, setPwRepeat] = useState<string>('');
  const [pwStatus, setPwStatus] = useState<string>('');
  const [backupLoading, setBackupLoading] = useState<boolean>(false);
  const [backupStatus, setBackupStatus] = useState<{ mode: 'live' | 'backup'; backupDate: string | null } | null>(null);
  const [backupList, setBackupList] = useState<Array<{ date: string; name: string; size: number | null; modified: string | null }>>([]);
  const [backupPick, setBackupPick] = useState<string | null>(null);
  const [e2eStatus, setE2eStatus] = useState<{ enabled: boolean; primaryPresent: boolean; previousCount: number; updatedAt: number } | null>(
    null,
  );
  const [e2eExport, setE2eExport] = useState<string>('');
  const [e2eLoading, setE2eLoading] = useState<boolean>(false);
  const [updateResetLoading, setUpdateResetLoading] = useState<boolean>(false);
  const [localDbResetLoading, setLocalDbResetLoading] = useState<boolean>(false);
  const [fullSyncLoading, setFullSyncLoading] = useState<boolean>(false);
  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  const [apiSaveStatus, setApiSaveStatus] = useState<string>('');
  const [clientVersion, setClientVersion] = useState<string>('');
  const [serverInfo, setServerInfo] = useState<
    | { ok: true; url: string; serverOk: boolean; version: string | null; buildDate: string | null }
    | { ok: false; url: string; error: string }
    | null
  >(null);
  const [serverStatus, setServerStatus] = useState<string>('');

  function formatError(e: unknown): string {
    if (e == null) return 'unknown error';
    if (typeof e === 'string') return e;
    if (e instanceof Error) return e.message || String(e);
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }

  async function refreshLoggingConfig() {
    try {
      const r = await window.matrica.logging.getConfig();
      if (r.ok) {
        setLoggingEnabled(r.enabled);
        setLoggingMode(r.mode);
      } else {
        setStatus(`Ошибка загрузки: ${formatError(r.error)}`);
      }
    } catch (e) {
      setStatus(`Ошибка: ${formatError(e)}`);
    }
  }

  async function loadSettings() {
    try {
      setLoading(true);
      await refreshLoggingConfig();
      const auth = await window.matrica.auth.status().catch(() => null);
      if (auth?.loggedIn) {
        setAuthUser(auth.user ?? null);
        const p = await window.matrica.auth.profileGet().catch(() => null);
        if (p && (p as any).ok && (p as any).profile) {
          const profile = (p as any).profile;
          setProfileUser({
            login: String(profile.login ?? auth.user?.username ?? ''),
            role: String(profile.role ?? auth.user?.role ?? ''),
          });
          setTelegramLogin(String(profile.telegramLogin ?? '').trim());
          setMaxLogin(String(profile.maxLogin ?? '').trim());
        } else if (auth.user) {
          setProfileUser({ login: String(auth.user.username ?? ''), role: String(auth.user.role ?? '') });
          setTelegramLogin('');
          setMaxLogin('');
        }
      }
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
        setStatus(`Ошибка резервных копий: ${formatError(r.error)}`);
        return;
      }
      setBackupList(r.backups ?? []);
    } catch (e) {
      setStatus(`Ошибка резервных копий: ${formatError(e)}`);
    } finally {
      setBackupLoading(false);
    }
  }

  async function refreshE2eStatus() {
    try {
      setE2eLoading(true);
      const r = await window.matrica.e2eKeys.status();
      if (r.ok) {
        setE2eStatus({
          enabled: r.enabled,
          primaryPresent: r.primaryPresent,
          previousCount: r.previousCount,
          updatedAt: r.updatedAt,
        });
      } else {
        setE2eStatus(null);
      }
    } catch {
      setE2eStatus(null);
    } finally {
      setE2eLoading(false);
    }
  }

  async function handleResetUpdates() {
    if (!confirm('Сбросить кэш обновлений и начать загрузку заново?')) return;
    try {
      setUpdateResetLoading(true);
      const r = await window.matrica.update.reset();
      if (r?.ok) {
        setStatus('Кэш обновлений очищен. При следующей проверке начнется новая загрузка.');
        setTimeout(() => setStatus(''), 4000);
      } else {
        setStatus(`Ошибка сброса обновлений: ${formatError(r?.error ?? 'unknown error')}`);
      }
    } catch (e) {
      setStatus(`Ошибка сброса обновлений: ${formatError(e)}`);
    } finally {
      setUpdateResetLoading(false);
    }
  }

  async function handleResetLocalDb() {
    if (
      !confirm(
        'Сбросить локальную базу данных? Все локальные данные, настройки и авторизация будут удалены. Клиент перезапустится и попросит вход заново.',
      )
    )
      return;
    try {
      setLocalDbResetLoading(true);
      const r = await window.matrica.sync.resetLocalDb();
      if (r?.ok) {
        setStatus('Локальная база очищена. Клиент перезапускается...');
      } else {
        setStatus(`Ошибка сброса базы: ${formatError(r?.error ?? 'unknown error')}`);
      }
    } catch (e) {
      setStatus(`Ошибка сброса базы: ${formatError(e)}`);
    } finally {
      setLocalDbResetLoading(false);
    }
  }

  async function handleFullSync() {
    if (!confirm('Запустить полную синхронизацию без сброса базы? Это может занять много времени.')) return;
    try {
      setFullSyncLoading(true);
      setStatus('Полная синхронизация запущена...');
      const r = await window.matrica.sync.fullPull();
      if (r.ok) setStatus(`Полная синхронизация завершена: push=${r.pushed}, pull=${r.pulled}.`);
      else setStatus(`Ошибка: ${r.error ?? 'unknown'}`);
    } catch (e) {
      setStatus(`Ошибка: ${formatError(e)}`);
    } finally {
      setFullSyncLoading(false);
      setTimeout(() => setStatus(''), 6000);
    }
  }

  async function refreshServerHealth(baseUrlOverride?: string) {
    setServerStatus('Проверяю сервер...');
    const base = (baseUrlOverride ?? apiBaseUrl ?? '').trim();
    const r = await window.matrica.server.health().catch((e) => ({ ok: false as const, url: base, error: String(e) }));
    setServerInfo(r);
    setServerStatus(r.ok ? '' : `Ошибка: ${r.error}`);
  }

  async function loadSyncConnectionSettings() {
    const cfg = await window.matrica.sync.configGet().catch(() => null);
    if (cfg?.ok && cfg.apiBaseUrl) setApiBaseUrl(cfg.apiBaseUrl);

    const v = await window.matrica.app.version().catch(() => null);
    if (v?.ok && v.version) setClientVersion(v.version);

    await refreshServerHealth(cfg?.ok && cfg.apiBaseUrl ? cfg.apiBaseUrl : undefined);
  }

  useEffect(() => {
    void loadSettings();
    void refreshBackups();
    void refreshE2eStatus();
    void loadSyncConnectionSettings();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => void refreshLoggingConfig(), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setUiTheme(props.uiPrefs.theme);
    setChatSide(props.uiPrefs.chatSide);
    setEnterAsTab(props.uiPrefs.enterAsTab === true);
  }, [props.uiPrefs]);

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
        setStatus(`Ошибка: ${formatError(r.error)}`);
      }
    } catch (e) {
      setStatus(`Ошибка: ${formatError(e)}`);
    }
  }

  async function handleSetLoggingMode(mode: 'dev' | 'prod') {
    try {
      setStatus('Сохранение...');
      const r = await window.matrica.logging.setMode(mode);
      if (r.ok) {
        setLoggingMode(r.mode);
        setStatus(mode === 'dev' ? 'Режим логирования: разработка' : 'Режим логирования: прод');
        setTimeout(() => setStatus(''), 2000);
      } else {
        setStatus(`Ошибка: ${formatError((r as any).error)}`);
      }
    } catch (e) {
      setStatus(`Ошибка: ${formatError(e)}`);
    }
  }

  async function handleChangePassword() {
    if (!authUser?.id) {
      setPwStatus('Требуется вход в систему.');
      return;
    }
    const cur = pwCurrent.trim();
    const next = pwNew.trim();
    const repeat = pwRepeat.trim();
    if (!cur || !next) {
      setPwStatus('Введите текущий и новый пароль.');
      return;
    }
    if (next !== repeat) {
      setPwStatus('Новый пароль и подтверждение не совпадают.');
      return;
    }
    setPwStatus('Смена пароля...');
    const r = await window.matrica.auth.changePassword({ currentPassword: cur, newPassword: next });
    if (r.ok) {
      setPwStatus('Пароль обновлён.');
      setPwCurrent('');
      setPwNew('');
      setPwRepeat('');
    } else {
      setPwStatus(`Ошибка: ${formatError(r.error)}`);
    }
  }

  async function handleSaveUiPrefs() {
    const r = await window.matrica.settings.uiSet({ theme: uiTheme, chatSide, enterAsTab });
    if (r && (r as any).ok) {
      props.onUiPrefsChange({
        theme: (r as any).theme,
        chatSide: (r as any).chatSide,
        enterAsTab: (r as any).enterAsTab === true,
        displayPrefs: props.uiPrefs.displayPrefs,
      });
      setStatus('Настройки интерфейса сохранены.');
      setTimeout(() => setStatus(''), 2000);
    } else {
      setStatus(`Ошибка: ${formatError((r as any)?.error ?? 'unknown error')}`);
    }
  }

  async function handleLogout() {
    setStatus('Выход из аккаунта...');
    await window.matrica.auth.logout({});
    setStatus('');
    props.onLogout();
  }

  async function handleSaveMessengers() {
    try {
      setMessengerStatus('Сохранение...');
      const r = await window.matrica.auth.profileUpdate({
        telegramLogin: telegramLogin.trim() || null,
        maxLogin: maxLogin.trim() || null,
      });
      if (r.ok) {
        setMessengerStatus('Мессенджеры обновлены.');
        const profile = (r as any).profile ?? null;
        if (profile) {
          setTelegramLogin(String(profile.telegramLogin ?? '').trim());
          setMaxLogin(String(profile.maxLogin ?? '').trim());
        }
        setTimeout(() => setMessengerStatus(''), 2000);
      } else {
        setMessengerStatus(`Ошибка: ${formatError((r as any).error)}`);
      }
    } catch (e) {
      setMessengerStatus(`Ошибка: ${formatError(e)}`);
    }
  }

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--muted)' }}>Загрузка настроек...</div>;
  }

  const sectionBaseStyle: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: 16,
  };

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ marginTop: 0, marginBottom: 14 }}>Настройки</h2>

      {status && (
        <div
          style={{
            marginBottom: 14,
            padding: 12,
            background: status.startsWith('Ошибка') ? 'rgba(248, 113, 113, 0.16)' : 'rgba(34, 197, 94, 0.16)',
            color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--success)',
            borderRadius: 10,
          }}
        >
          {status}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(480px, 1fr))', gap: 14, alignItems: 'start' }}>
        <div style={{ ...sectionBaseStyle, background: 'rgba(59, 130, 246, 0.08)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Профиль пользователя</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Основные данные пользователя и рабочие контакты.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: 'var(--muted)' }}>Логин</div>
            <div style={{ fontWeight: 700 }}>{profileUser?.login ?? authUser?.username ?? '—'}</div>
            <div style={{ color: 'var(--muted)' }}>Роль</div>
            <div style={{ fontWeight: 700 }}>{profileUser?.role ?? authUser?.role ?? '—'}</div>
            <div style={{ color: 'var(--muted)' }}>Telegram</div>
            <input
              value={telegramLogin}
              onChange={(e) => setTelegramLogin(e.target.value)}
              placeholder="@username"
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
            />
            <div style={{ color: 'var(--muted)' }}>MAX</div>
            <input
              value={maxLogin}
              onChange={(e) => setMaxLogin(e.target.value)}
              placeholder="логин"
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => void handleSaveMessengers()}>
              Сохранить мессенджеры
            </Button>
            {messengerStatus && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{messengerStatus}</span>}
          </div>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(16, 185, 129, 0.1)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Интерфейс</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Часто используемые настройки внешнего вида и поведения.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: 'var(--muted)' }}>Цветовая схема</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant={uiTheme === 'auto' ? 'primary' : 'ghost'} onClick={() => setUiTheme('auto')}>
                Авто
              </Button>
              <Button variant={uiTheme === 'light' ? 'primary' : 'ghost'} onClick={() => setUiTheme('light')}>
                Светлая
              </Button>
              <Button variant={uiTheme === 'dark' ? 'primary' : 'ghost'} onClick={() => setUiTheme('dark')}>
                Тёмная
              </Button>
            </div>
            <div style={{ color: 'var(--muted)' }}>Чат в интерфейсе</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant={chatSide === 'right' ? 'primary' : 'ghost'} onClick={() => setChatSide('right')}>
                Справа
              </Button>
              <Button variant={chatSide === 'left' ? 'primary' : 'ghost'} onClick={() => setChatSide('left')}>
                Слева
              </Button>
            </div>
            <div style={{ color: 'var(--muted)' }}>Enter как Tab</div>
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant={enterAsTab ? 'primary' : 'ghost'} onClick={() => setEnterAsTab(true)}>
                  Включено
                </Button>
                <Button variant={!enterAsTab ? 'primary' : 'ghost'} onClick={() => setEnterAsTab(false)}>
                  Выключено
                </Button>
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                Enter — переход к следующему полю, Shift+Enter — к предыдущему.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => void handleSaveUiPrefs()}>
              Сохранить настройки интерфейса
            </Button>
          </div>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(168, 85, 247, 0.1)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Смена пароля</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Безопасность вашей учетной записи.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'center' }}>
            <div style={{ color: 'var(--muted)' }}>Текущий пароль</div>
            <input
              type="password"
              value={pwCurrent}
              onChange={(e) => setPwCurrent(e.target.value)}
              placeholder="текущий пароль"
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
            />
            <div style={{ color: 'var(--muted)' }}>Новый пароль</div>
            <input
              type="password"
              value={pwNew}
              onChange={(e) => setPwNew(e.target.value)}
              placeholder="новый пароль"
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
            />
            <div style={{ color: 'var(--muted)' }}>Повтор пароля</div>
            <input
              type="password"
              value={pwRepeat}
              onChange={(e) => setPwRepeat(e.target.value)}
              placeholder="повтор пароля"
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
            />
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => void handleChangePassword()} disabled={!authUser?.id}>
              Сменить пароль
            </Button>
            {pwStatus && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{pwStatus}</span>}
          </div>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(245, 158, 11, 0.1)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Аккаунт</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Действия, связанные с сессией пользователя.
          </p>
          <Button variant="ghost" onClick={() => void handleLogout()}>
            Выйти из аккаунта
          </Button>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(14, 165, 233, 0.1)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Сервер синхронизации</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Обычно не требуется. Используйте при смене адреса сервера или диагностике.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <input
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="http://server:3001"
              style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button
                variant="ghost"
                onClick={async () => {
                  setApiSaveStatus('Сохраняю...');
                  const r = await window.matrica.sync.configSet({ apiBaseUrl });
                  setApiSaveStatus(r.ok ? 'Сохранено' : `Ошибка: ${formatError((r as any).error ?? 'unknown error')}`);
                  if (r.ok) await refreshServerHealth(apiBaseUrl);
                }}
              >
                Сохранить
              </Button>
              <Button variant="ghost" onClick={() => void refreshServerHealth()}>
                Проверить сервер
              </Button>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>{apiSaveStatus}</span>
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>
              Клиент:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{clientVersion || '—'}</span>
              {'  '}| Сервер:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {serverInfo?.ok ? serverInfo.version ?? '—' : '—'}
              </span>
              {serverInfo?.ok && serverInfo.buildDate && (
                <>
                  {' '}
                  | build: <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{serverInfo.buildDate}</span>
                </>
              )}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 12 }}>
              Версии клиента и сервера независимы (несовпадение не блокирует синхронизацию).
            </div>
            {serverStatus && <div style={{ color: serverStatus.startsWith('Ошибка') ? 'var(--danger)' : 'var(--muted)', fontSize: 12 }}>{serverStatus}</div>}
          </div>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(236, 72, 153, 0.1)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Ночные резервные копии базы</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Открытие базы в режиме просмотра и запуск ночного бэкапа вручную.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <SearchSelect
              value={backupPick}
              options={backupList.map((b) => ({ id: b.date, label: b.date }))}
              placeholder={backupLoading ? 'Загрузка…' : backupList.length ? 'Выберите дату…' : 'Резервных копий нет'}
              disabled={backupLoading || backupList.length === 0 || backupStatus?.mode === 'backup'}
              onChange={setBackupPick}
            />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <Button onClick={() => void refreshBackups()} variant="ghost" disabled={backupLoading} title="Обновить список резервных копий">
                Обновить
              </Button>
              <Button
                onClick={() => {
                  void (async () => {
                    setStatus('Запуск резервного копирования…');
                    const r = await window.matrica.backups.nightlyRunNow();
                    if (r.ok) {
                      setStatus('Резервное копирование запущено на сервере.');
                      setTimeout(() => void refreshBackups(), 4000);
                    } else {
                      setStatus(`Ошибка: ${formatError(r.error)}`);
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
                      setStatus(`Ошибка: ${formatError(r.error)}`);
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
            </div>
            {backupStatus?.mode === 'backup' && (
              <div style={{ color: 'var(--danger)', fontWeight: 800, fontSize: 12 }}>
                Сейчас открыт просмотр: {backupStatus.backupDate ?? '—'}
              </div>
            )}
          </div>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(234, 179, 8, 0.1)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Обновления</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            При проблеме с загрузкой можно очистить кэш обновлений.
          </p>
          <Button variant="ghost" disabled={updateResetLoading} onClick={() => void handleResetUpdates()}>
            Сбросить кэш обновлений
          </Button>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(239, 68, 68, 0.1)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Локальная база</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Редкие операции восстановления: сброс базы и полная пересинхронизация.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant="ghost" disabled={localDbResetLoading} onClick={() => void handleResetLocalDb()}>
              Сбросить локальную базу
            </Button>
            <Button variant="ghost" disabled={fullSyncLoading} onClick={() => void handleFullSync()}>
              Полная синхронизация
            </Button>
          </div>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(107, 114, 128, 0.12)' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>Отправка логов на сервер</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Диагностическая опция. Обычно используется при разборе проблем.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button onClick={() => void handleToggleLogging()} variant={loggingEnabled ? 'ghost' : 'primary'}>
              {loggingEnabled ? 'Отключить отправку логов' : 'Включить отправку логов'}
            </Button>
            {loggingEnabled && <span style={{ color: 'var(--success)', fontSize: 12 }}>Включено</span>}
            {!loggingEnabled && <span style={{ color: 'var(--muted)', fontSize: 12 }}>Отключено</span>}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>Режим:</span>
            <Button
              variant={loggingMode === 'prod' ? 'primary' : 'ghost'}
              onClick={() => void handleSetLoggingMode('prod')}
              disabled={!loggingEnabled}
              title="Минимальные логи: только критичные события"
            >
              Прод
            </Button>
            <Button
              variant={loggingMode === 'dev' ? 'primary' : 'ghost'}
              onClick={() => void handleSetLoggingMode('dev')}
              disabled={!loggingEnabled}
              title="Подробные логи для диагностики"
            >
              Разработка
            </Button>
          </div>
        </div>

        <div style={{ ...sectionBaseStyle, background: 'rgba(17, 24, 39, 0.08)', gridColumn: '1 / -1' }}>
          <h3 style={{ marginTop: 0, marginBottom: 10 }}>E2E ключи ledger</h3>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            Редкий технический раздел для управления ключами шифрования ledger.
          </p>
          {e2eStatus ? (
            <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
              <div className="muted">
                Основной ключ: {e2eStatus.primaryPresent ? 'есть' : 'нет'} • Предыдущих: {e2eStatus.previousCount}
              </div>
              <div className="muted">Обновлён: {e2eStatus.updatedAt ? new Date(e2eStatus.updatedAt).toLocaleString() : '—'}</div>
            </div>
          ) : (
            <div className="muted" style={{ marginBottom: 12 }}>
              Статус недоступен.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              variant="ghost"
              disabled={e2eLoading}
              onClick={async () => {
                setE2eExport('');
                await refreshE2eStatus();
              }}
            >
              Обновить статус
            </Button>
            <Button
              disabled={e2eLoading}
              onClick={async () => {
                setE2eLoading(true);
                const r = await window.matrica.e2eKeys.export();
                if (r.ok) {
                  setE2eExport(JSON.stringify(r.ring, null, 2));
                } else {
                  setStatus(`Ошибка экспорта ключей: ${formatError((r as any).error)}`);
                }
                setE2eLoading(false);
              }}
            >
              Экспорт ключей
            </Button>
            <Button
              variant="ghost"
              disabled={e2eLoading}
              onClick={async () => {
                if (!confirm('Ротация ключа создаст новый основной ключ. Старые останутся для чтения истории. Продолжить?')) return;
                setE2eLoading(true);
                const r = await window.matrica.e2eKeys.rotate();
                if (r.ok) {
                  setE2eExport(JSON.stringify(r.ring, null, 2));
                  await refreshE2eStatus();
                  setStatus('Ключ обновлён.');
                } else {
                  setStatus(`Ошибка ротации: ${formatError((r as any).error)}`);
                }
                setE2eLoading(false);
              }}
            >
              Ротация ключа
            </Button>
          </div>
          {e2eExport && (
            <div style={{ marginTop: 12 }}>
              <div className="muted" style={{ marginBottom: 6 }}>
                Сохраните этот JSON в безопасном месте для восстановления.
              </div>
              <textarea
                value={e2eExport}
                readOnly
                style={{ width: '100%', minHeight: 120, padding: 10, borderRadius: 8, border: '1px solid var(--border)' }}
              />
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

