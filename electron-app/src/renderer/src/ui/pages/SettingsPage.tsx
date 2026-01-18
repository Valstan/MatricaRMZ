import React, { useEffect, useState } from 'react';

import { Button } from '../components/Button.js';
import { SearchSelect } from '../components/SearchSelect.js';

export function SettingsPage(props: {
  uiPrefs: { theme: 'auto' | 'light' | 'dark'; chatSide: 'left' | 'right' };
  onUiPrefsChange: (prefs: { theme: 'auto' | 'light' | 'dark'; chatSide: 'left' | 'right' }) => void;
  onLogout: () => void;
}) {
  const [loggingEnabled, setLoggingEnabled] = useState<boolean>(false);
  const [loggingMode, setLoggingMode] = useState<'prod' | 'dev'>('prod');
  const [status, setStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [authUser, setAuthUser] = useState<{ id: string; username: string; role: string } | null>(null);
  const [profileStatus, setProfileStatus] = useState<string>('');
  const [profileForm, setProfileForm] = useState<{ fullName: string; chatDisplayName: string; position: string; sectionName: string }>({
    fullName: '',
    chatDisplayName: '',
    position: '',
    sectionName: '',
  });
  const [uiTheme, setUiTheme] = useState<'auto' | 'light' | 'dark'>(props.uiPrefs.theme);
  const [chatSide, setChatSide] = useState<'left' | 'right'>(props.uiPrefs.chatSide);
  const [pwCurrent, setPwCurrent] = useState<string>('');
  const [pwNew, setPwNew] = useState<string>('');
  const [pwRepeat, setPwRepeat] = useState<string>('');
  const [pwStatus, setPwStatus] = useState<string>('');
  const [backupLoading, setBackupLoading] = useState<boolean>(false);
  const [backupStatus, setBackupStatus] = useState<{ mode: 'live' | 'backup'; backupDate: string | null } | null>(null);
  const [backupList, setBackupList] = useState<Array<{ date: string; name: string; size: number | null; modified: string | null }>>([]);
  const [backupPick, setBackupPick] = useState<string | null>(null);

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

  async function loadSettings() {
    try {
      setLoading(true);
      const r = await window.matrica.logging.getConfig();
      if (r.ok) {
        setLoggingEnabled(r.enabled);
        setLoggingMode(r.mode);
      } else {
        setStatus(`Ошибка загрузки: ${formatError(r.error)}`);
      }
      const auth = await window.matrica.auth.status().catch(() => null);
      if (auth?.loggedIn) {
        setAuthUser(auth.user ?? null);
        const p = await window.matrica.auth.profileGet().catch(() => null);
        if (p && (p as any).ok && (p as any).profile) {
          const profile = (p as any).profile;
          setProfileForm({
            fullName: String(profile.fullName ?? ''),
            chatDisplayName: String(profile.chatDisplayName ?? ''),
            position: String(profile.position ?? ''),
            sectionName: String(profile.sectionName ?? ''),
          });
        }
      }
    } catch (e) {
      setStatus(`Ошибка: ${formatError(e)}`);
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

  useEffect(() => {
    void loadSettings();
    void refreshBackups();
  }, []);

  useEffect(() => {
    setUiTheme(props.uiPrefs.theme);
    setChatSide(props.uiPrefs.chatSide);
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

  async function handleSaveProfile() {
    if (!authUser?.id) {
      setProfileStatus('Требуется вход в систему.');
      return;
    }
    setProfileStatus('Сохранение профиля...');
    const r = await window.matrica.auth.profileUpdate({
      fullName: profileForm.fullName.trim() || null,
      chatDisplayName: profileForm.chatDisplayName.trim() || null,
      position: profileForm.position.trim() || null,
      sectionName: profileForm.sectionName.trim() || null,
    });
    if (r && (r as any).ok) {
      const profile = (r as any).profile ?? null;
      setProfileForm({
        fullName: String(profile?.fullName ?? profileForm.fullName),
        chatDisplayName: String(profile?.chatDisplayName ?? profileForm.chatDisplayName),
        position: String(profile?.position ?? profileForm.position),
        sectionName: String(profile?.sectionName ?? profileForm.sectionName),
      });
      setProfileStatus('Профиль сохранён.');
    } else {
      setProfileStatus(`Ошибка: ${formatError((r as any)?.error ?? 'unknown error')}`);
    }
  }

  async function handleSaveUiPrefs() {
    const r = await window.matrica.settings.uiSet({ theme: uiTheme, chatSide });
    if (r && (r as any).ok) {
      props.onUiPrefsChange({ theme: (r as any).theme, chatSide: (r as any).chatSide });
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

  if (loading) {
    return <div style={{ padding: 20, color: 'var(--muted)' }}>Загрузка настроек...</div>;
  }

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ marginTop: 0, marginBottom: 20 }}>Настройки</h2>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20, background: 'var(--surface)' }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Профиль пользователя</h3>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
          Эти данные видны в системе и могут быть обновлены вами.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', maxWidth: 680 }}>
          <div style={{ color: 'var(--muted)' }}>Логин</div>
          <div style={{ fontWeight: 700 }}>{authUser?.username ?? '—'}</div>
          <div style={{ color: 'var(--muted)' }}>Роль</div>
          <div style={{ fontWeight: 700 }}>{authUser?.role ?? '—'}</div>
          <div style={{ color: 'var(--muted)' }}>ФИО</div>
          <input
            value={profileForm.fullName}
            onChange={(e) => setProfileForm((p) => ({ ...p, fullName: e.target.value }))}
            placeholder="Фамилия Имя Отчество"
            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
          />
          <div style={{ color: 'var(--muted)' }}>Имя в чате</div>
          <input
            value={profileForm.chatDisplayName}
            onChange={(e) => setProfileForm((p) => ({ ...p, chatDisplayName: e.target.value }))}
            placeholder="Например: Саша, Мастер участка"
            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
          />
          <div style={{ color: 'var(--muted)' }}>Должность</div>
          <input
            value={profileForm.position}
            onChange={(e) => setProfileForm((p) => ({ ...p, position: e.target.value }))}
            placeholder="Должность"
            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
          />
          <div style={{ color: 'var(--muted)' }}>Цех / участок</div>
          <input
            value={profileForm.sectionName}
            onChange={(e) => setProfileForm((p) => ({ ...p, sectionName: e.target.value }))}
            placeholder="Например: Цех № 4"
            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid var(--input-border)', background: 'var(--input-bg)', color: 'var(--text)' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
          <Button variant="ghost" onClick={() => void handleSaveProfile()} disabled={!authUser?.id}>
            Сохранить профиль
          </Button>
          {profileStatus && <span style={{ color: 'var(--muted)' }}>{profileStatus}</span>}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20, background: 'var(--surface)' }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Интерфейс</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', maxWidth: 680 }}>
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
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
          <Button variant="ghost" onClick={() => void handleSaveUiPrefs()}>
            Сохранить настройки интерфейса
          </Button>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20, background: 'var(--surface)' }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Отправка логов на сервер</h3>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
          При включении логи работы клиента будут отправляться на сервер для диагностики проблем. Логи сохраняются в папку{' '}
          <code style={{ background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 4 }}>logs/</code> на сервере.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button onClick={() => void handleToggleLogging()} variant={loggingEnabled ? 'ghost' : 'primary'}>
            {loggingEnabled ? 'Отключить отправку логов' : 'Включить отправку логов'}
          </Button>
          {loggingEnabled && <span style={{ color: 'var(--success)' }}>✓ Включено</span>}
          {!loggingEnabled && <span style={{ color: 'var(--muted)' }}>Отключено</span>}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--muted)' }}>Режим логирования:</span>
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

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20, background: 'var(--surface)' }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Ночные резервные копии базы</h3>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
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

            {backupStatus?.mode === 'backup' && (
              <span style={{ color: 'var(--danger)', fontWeight: 800 }}>
                Сейчас открыт просмотр: {backupStatus.backupDate ?? '—'}
              </span>
            )}
          </div>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20, background: 'var(--surface)' }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Смена пароля</h3>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
          Вы можете сменить пароль своей учетной записи. Суперадмин может менять пароль любого пользователя в разделе Админ.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', maxWidth: 520 }}>
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
          <Button variant="ghost" onClick={() => void handleChangePassword()} disabled={!authUser?.id}>
            Сменить пароль
          </Button>
          {pwStatus && <span style={{ color: 'var(--muted)' }}>{pwStatus}</span>}
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 20, background: 'var(--surface)' }}>
        <h3 style={{ marginTop: 0, marginBottom: 12 }}>Аккаунт</h3>
        <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
          Выйти из аккаунта текущего оператора. После выхода потребуется повторный вход.
        </p>
        <Button variant="ghost" onClick={() => void handleLogout()}>
          Выйти из аккаунта
        </Button>
      </div>

      {status && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: status.startsWith('Ошибка') ? 'rgba(248, 113, 113, 0.16)' : 'rgba(34, 197, 94, 0.16)',
            color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--success)',
            borderRadius: 8,
          }}
        >
          {status}
        </div>
      )}
    </div>
  );
}

