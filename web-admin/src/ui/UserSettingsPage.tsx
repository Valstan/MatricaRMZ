import React, { useEffect, useState } from 'react';

import { profileGet, profileUpdate } from '../api/auth.js';
import { getLatestUpdateInfo, getUpdateStatus } from '../api/updates.js';
import { Button } from './components/Button.js';
import { Input } from './components/Input.js';

export type UiPrefs = {
  theme: 'auto' | 'light' | 'dark';
  chatSide: 'left' | 'right';
  chatDocked: boolean;
  loggingEnabled: boolean;
};

type UserProfile = {
  fullName: string;
  position: string;
  sectionName: string;
};

export function UserSettingsPage(props: {
  user: { id: string; username: string; role: string } | null;
  prefs: UiPrefs;
  onPrefsChange: (prefs: UiPrefs) => void;
  onLogout: () => void;
}) {
  const [profile, setProfile] = useState<UserProfile>({ fullName: '', position: '', sectionName: '' });
  const [status, setStatus] = useState<string>('');
  const [profileStatus, setProfileStatus] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [prefs, setPrefs] = useState<UiPrefs>(props.prefs);
  const [updateInfo, setUpdateInfo] = useState<{
    version: string;
    torrentUrl: string;
    qbittorrentUrl: string;
  } | null>(null);
  const [updateStatusInfo, setUpdateStatusInfo] = useState<{
    enabled: boolean;
    updatesDir?: string | null;
    lastScanAt?: number | null;
    lastError?: string | null;
    latest?: { version: string; fileName: string; size: number };
  } | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string>('');
  const [updateLoading, setUpdateLoading] = useState<boolean>(false);

  useEffect(() => {
    setPrefs(props.prefs);
  }, [props.prefs]);

  useEffect(() => {
    if (!props.user) return;
    let alive = true;
    void (async () => {
      setLoading(true);
      const r = await profileGet().catch(() => null);
      if (!alive) return;
      if (r && (r as any).ok && (r as any).profile) {
        const p = (r as any).profile;
        setProfile({
          fullName: String(p.fullName ?? ''),
          position: String(p.position ?? ''),
          sectionName: String(p.sectionName ?? ''),
        });
      }
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [props.user?.id]);

  function describeUpdateStatus(status: typeof updateStatusInfo): string {
    if (!status) return '';
    if (!status.enabled) return 'Обновления отключены: папка обновлений не настроена.';
    const err = status.lastError ?? '';
    if (err.startsWith('seed_failed:')) return `Ошибка подготовки торрента: ${err.replace('seed_failed:', '').trim()}`;
    if (err === 'updates_dir_not_set') return 'Обновления отключены: папка обновлений не задана.';
    if (err === 'no_installer_found') return 'Не найден установщик .exe в папке обновлений.';
    if (status.latest) return 'Торрент обновления доступен.';
    return 'Торрент обновления пока недоступен.';
  }

  async function refreshUpdateInfo() {
    setUpdateLoading(true);
    setUpdateStatus('');
    const statusRes = await getUpdateStatus().catch(() => null);
    if (statusRes && (statusRes as any).ok && (statusRes as any).status) {
      const st = (statusRes as any).status;
      setUpdateStatusInfo({
        enabled: !!st.enabled,
        updatesDir: st.updatesDir ?? null,
        lastScanAt: st.lastScanAt ?? null,
        lastError: st.lastError ?? null,
        latest: st.latest
          ? {
              version: String(st.latest.version ?? ''),
              fileName: String(st.latest.fileName ?? ''),
              size: Number(st.latest.size ?? 0),
            }
          : undefined,
      });
      if (st.latest) {
        const r = await getLatestUpdateInfo().catch(() => null);
        if (r && (r as any).ok) {
          setUpdateInfo({
            version: String((r as any).version ?? ''),
            torrentUrl: String((r as any).torrentUrl ?? ''),
            qbittorrentUrl: String((r as any).qbittorrentUrl ?? 'https://www.qbittorrent.org/download'),
          });
        } else {
          setUpdateInfo(null);
          setUpdateStatus(`Ошибка загрузки обновлений: ${(r as any)?.error ?? 'unknown'}`);
        }
      } else {
        setUpdateInfo(null);
      }
    } else {
      setUpdateStatusInfo(null);
      setUpdateInfo(null);
      setUpdateStatus(`Ошибка загрузки обновлений: ${(statusRes as any)?.error ?? 'unknown'}`);
    }
    setUpdateLoading(false);
  }

  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!alive) return;
      await refreshUpdateInfo();
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function handleSaveProfile() {
    if (!props.user) {
      setProfileStatus('Требуется вход.');
      return;
    }
    setProfileStatus('Сохранение профиля...');
    const r = await profileUpdate({
      fullName: profile.fullName.trim() || null,
      position: profile.position.trim() || null,
      sectionName: profile.sectionName.trim() || null,
    });
    if (r && (r as any).ok && (r as any).profile) {
      const p = (r as any).profile;
      setProfile({
        fullName: String(p.fullName ?? ''),
        position: String(p.position ?? ''),
        sectionName: String(p.sectionName ?? ''),
      });
      setProfileStatus('Профиль сохранён.');
    } else {
      setProfileStatus(`Ошибка: ${(r as any)?.error ?? 'unknown error'}`);
    }
  }

  function handleSavePrefs() {
    props.onPrefsChange(prefs);
    setStatus('Настройки интерфейса сохранены.');
    setTimeout(() => setStatus(''), 2000);
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setUpdateStatus('Ссылка скопирована.');
      setTimeout(() => setUpdateStatus(''), 1500);
    } catch {
      setUpdateStatus('Не удалось скопировать ссылку.');
    }
  }

  if (!props.user) {
    return <div className="card">Требуется вход.</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card">
        <h2 style={{ marginTop: 0 }}>Настройки пользователя</h2>
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', maxWidth: 700 }}>
          <div className="muted">Логин</div>
          <div style={{ fontWeight: 800 }}>{props.user.username}</div>
          <div className="muted">Роль</div>
          <div style={{ fontWeight: 800 }}>{props.user.role}</div>
          <div className="muted">ФИО</div>
          <Input value={profile.fullName} onChange={(e) => setProfile((p) => ({ ...p, fullName: e.target.value }))} placeholder="ФИО" />
          <div className="muted">Должность</div>
          <Input value={profile.position} onChange={(e) => setProfile((p) => ({ ...p, position: e.target.value }))} placeholder="Должность" />
          <div className="muted">Цех / участок</div>
          <Input value={profile.sectionName} onChange={(e) => setProfile((p) => ({ ...p, sectionName: e.target.value }))} placeholder="Цех № 4" />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
          <Button onClick={() => void handleSaveProfile()} disabled={loading}>
            Сохранить профиль
          </Button>
          {profileStatus && <span className="muted">{profileStatus}</span>}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Интерфейс</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', maxWidth: 700 }}>
          <div className="muted">Цветовая схема</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant={prefs.theme === 'auto' ? 'primary' : 'ghost'} onClick={() => setPrefs((p) => ({ ...p, theme: 'auto' }))}>
              Авто
            </Button>
            <Button variant={prefs.theme === 'light' ? 'primary' : 'ghost'} onClick={() => setPrefs((p) => ({ ...p, theme: 'light' }))}>
              Светлая
            </Button>
            <Button variant={prefs.theme === 'dark' ? 'primary' : 'ghost'} onClick={() => setPrefs((p) => ({ ...p, theme: 'dark' }))}>
              Тёмная
            </Button>
          </div>
          <div className="muted">Чат в интерфейсе</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button variant={prefs.chatDocked ? 'primary' : 'ghost'} onClick={() => setPrefs((p) => ({ ...p, chatDocked: !p.chatDocked }))}>
              {prefs.chatDocked ? 'Показывать сбоку' : 'Скрывать сбоку'}
            </Button>
            <Button
              variant={prefs.chatSide === 'right' ? 'primary' : 'ghost'}
              onClick={() => setPrefs((p) => ({ ...p, chatSide: 'right' }))}
              disabled={!prefs.chatDocked}
            >
              Справа
            </Button>
            <Button
              variant={prefs.chatSide === 'left' ? 'primary' : 'ghost'}
              onClick={() => setPrefs((p) => ({ ...p, chatSide: 'left' }))}
              disabled={!prefs.chatDocked}
            >
              Слева
            </Button>
          </div>
          <div className="muted">Локальное логирование</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              variant={prefs.loggingEnabled ? 'primary' : 'ghost'}
              onClick={() => setPrefs((p) => ({ ...p, loggingEnabled: !p.loggingEnabled }))}
            >
              {prefs.loggingEnabled ? 'Выключить' : 'Включить'}
            </Button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
          <Button variant="ghost" onClick={() => handleSavePrefs()}>
            Сохранить настройки
          </Button>
          {status && <span className="muted">{status}</span>}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Обновление клиента</h3>
        <div className="muted" style={{ marginBottom: 12 }}>
          Ссылка на торрент последней версии «Матрица РМЗ» и скачивание qBittorrent.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <Button variant="ghost" onClick={() => void refreshUpdateInfo()} disabled={updateLoading}>
            Обновить
          </Button>
          {updateStatusInfo?.lastScanAt ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Проверено: {new Date(updateStatusInfo.lastScanAt).toLocaleString('ru-RU')}
            </span>
          ) : null}
        </div>
        {updateStatusInfo && <div className="muted" style={{ marginBottom: 8 }}>{describeUpdateStatus(updateStatusInfo)}</div>}
        {updateLoading ? (
          <div className="muted">Загрузка…</div>
        ) : updateInfo && updateInfo.torrentUrl ? (
          <div style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
            <div className="muted">Версия: {updateInfo.version || '—'}</div>
            <Input value={updateInfo.torrentUrl} readOnly />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => void handleCopy(updateInfo.torrentUrl)}>
                Скопировать ссылку
              </Button>
              <a href={updateInfo.torrentUrl} target="_blank" rel="noreferrer">
                <Button variant="primary">Скачать торрент</Button>
              </a>
              <a href={updateInfo.qbittorrentUrl} target="_blank" rel="noreferrer">
                <Button variant="ghost">Скачать qBittorrent</Button>
              </a>
            </div>
          </div>
        ) : (
          <div className="muted">Торрент обновления пока недоступен.</div>
        )}
        {updateStatus && <div className="muted" style={{ marginTop: 8 }}>{updateStatus}</div>}
      </div>

      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 800 }}>Сессия</div>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => props.onLogout()}>
          Выйти
        </Button>
      </div>
    </div>
  );
}
