import React, { useEffect, useRef, useState } from 'react';

import type { AuditItem, AuthStatus, EngineDetails, EngineListItem, OperationItem, ServerHealthResult, SyncStatus } from '@matricarmz/shared';

import { Page } from './layout/Page.js';
import { Tabs, type TabId } from './layout/Tabs.js';
import { EnginesPage } from './pages/EnginesPage.js';
import { EngineDetailsPage } from './pages/EngineDetailsPage.js';
import { ChangesPage } from './pages/ChangesPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { AdminPage } from './pages/AdminPage.js';
import { AuditPage } from './pages/AuditPage.js';
import { AuthPage } from './pages/AuthPage.js';
import { SupplyRequestsPage } from './pages/SupplyRequestsPage.js';
import { SupplyRequestDetailsPage } from './pages/SupplyRequestDetailsPage.js';
import { PartsPage } from './pages/PartsPage.js';
import { PartDetailsPage } from './pages/PartDetailsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { deriveUiCaps } from './auth/permissions.js';
import { Button } from './components/Button.js';
import { ChatPanel } from './components/ChatPanel.js';

export function App() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ loggedIn: false, user: null, permissions: null });
  const [tab, setTab] = useState<TabId>('engines');
  const [postLoginSyncMsg, setPostLoginSyncMsg] = useState<string>('');
  const prevLoggedIn = useRef<boolean>(false);
  const [clientVersion, setClientVersion] = useState<string>('');
  const [serverInfo, setServerInfo] = useState<ServerHealthResult | null>(null);
  const [backupMode, setBackupMode] = useState<{ mode: 'live' | 'backup'; backupDate: string | null } | null>(null);

  const [engines, setEngines] = useState<EngineListItem[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [engineDetails, setEngineDetails] = useState<EngineDetails | null>(null);
  const [ops, setOps] = useState<OperationItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState<boolean>(true);
  const [chatUnreadTotal, setChatUnreadTotal] = useState<number>(0);

  useEffect(() => {
    void refreshEngines();
    void window.matrica.auth.status().then(setAuthStatus).catch(() => {});
    void window.matrica.app.version().then((r) => (r.ok ? setClientVersion(r.version) : setClientVersion(''))).catch(() => {});
    void refreshServerHealth();
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await window.matrica.backups.status();
        if (!alive) return;
        if (r && (r as any).ok === true) {
          setBackupMode({ mode: (r as any).mode, backupDate: (r as any).backupDate ?? null });
        }
      } catch {
        // ignore
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // When switching live <-> backup mode, reload lists from the current DB.
  useEffect(() => {
    if (!backupMode) return;
    void refreshEngines();
    // Reset opened details when data source changes.
    setSelectedEngineId(null);
    setEngineDetails(null);
    setOps([]);
    setSelectedRequestId(null);
    setSelectedPartId(null);
  }, [backupMode?.mode, backupMode?.backupDate]);

  async function refreshServerHealth() {
    const r = await window.matrica.server.health().catch(() => null);
    if (r) setServerInfo(r);
  }

  // Update backend version occasionally (it can change after deploy).
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await window.matrica.server.health();
        if (!alive) return;
        setServerInfo(r);
      } catch {
        // ignore
      }
    };
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function runSyncNow(opts?: { showStatusMessage?: boolean }) {
    try {
      if (backupMode?.mode === 'backup') {
        if (opts?.showStatusMessage) setPostLoginSyncMsg('Режим просмотра резервной копии: синхронизация отключена.');
        return;
      }
      if (opts?.showStatusMessage) setPostLoginSyncMsg('Синхронизация…');
      const r = await window.matrica.sync.run();
      if (r.ok) {
        await refreshEngines();
        if (opts?.showStatusMessage) setPostLoginSyncMsg(`Синхронизация выполнена: push=${r.pushed}, pull=${r.pulled}.`);
      } else {
        if (opts?.showStatusMessage) setPostLoginSyncMsg(`Не удалось синхронизироваться: ${r.error ?? 'unknown'}.`);
      }
    } catch (e) {
      if (opts?.showStatusMessage) setPostLoginSyncMsg(`Не удалось синхронизироваться: ${String(e)}.`);
    } finally {
      if (opts?.showStatusMessage) setTimeout(() => setPostLoginSyncMsg(''), 12_000);
    }
  }

  // After successful login: run one sync so the user immediately sees shared data (e.g. engines created by admins).
  useEffect(() => {
    const was = prevLoggedIn.current;
    const now = authStatus.loggedIn === true;
    prevLoggedIn.current = now;
    if (now && !was && backupMode?.mode !== 'backup') {
      setPostLoginSyncMsg('После входа выполняю синхронизацию…');
      void runSyncNow({ showStatusMessage: true });
    }
  }, [authStatus.loggedIn, backupMode?.mode]);

  // Periodically sync auth permissions from server (important for delegated permissions).
  useEffect(() => {
    if (!authStatus.loggedIn) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await window.matrica.auth.sync();
        if (!alive) return;
        setAuthStatus(s);
      } catch {
        // ignore
      }
    };
    const id = setInterval(() => void poll(), 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [authStatus.loggedIn]);

  const capsBase = deriveUiCaps(authStatus.permissions ?? null);
  const viewMode = backupMode?.mode === 'backup';
  const canChat = !!authStatus.permissions?.['chat.use'];
  const canChatExport = !!authStatus.permissions?.['chat.export'];
  const canChatAdminView = !!authStatus.permissions?.['chat.admin.view'];
  const caps = viewMode
    ? {
        ...capsBase,
        canUseSync: false,
        canUseUpdates: false,
        canEditEngines: false,
        canEditOperations: false,
        canCreateSupplyRequests: false,
        canEditSupplyRequests: false,
        canSignSupplyRequests: false,
        canApproveSupplyRequests: false,
        canAcceptSupplyRequests: false,
        canFulfillSupplyRequests: false,
        canUploadFiles: false,
        canCreateParts: false,
        canEditParts: false,
        canDeleteParts: false,
        canManageUsers: false,
        canEditMasterData: false,
        canViewParts: false,
      }
    : capsBase;
  const visibleTabs: Exclude<TabId, 'engine' | 'request' | 'part'>[] = [
    ...(caps.canViewEngines ? (['engines'] as const) : []),
    ...(caps.canViewSupplyRequests ? (['requests'] as const) : []),
    ...(caps.canViewParts ? (['parts'] as const) : []),
    ...(caps.canUseUpdates ? (['changes'] as const) : []),
    ...(caps.canViewReports ? (['reports'] as const) : []),
    ...((caps.canViewMasterData || caps.canManageUsers) ? (['admin'] as const) : []),
    ...(caps.canViewAudit ? (['audit'] as const) : []),
    'settings',
    'auth',
  ];
  const visibleTabsKey = visibleTabs.join('|');

  // Gate: без входа показываем только вкладку "Вход".
  useEffect(() => {
    if (!authStatus.loggedIn && tab !== 'auth') setTab('auth');
  }, [authStatus.loggedIn, tab]);

  // Gate: chat requires auth + permission.
  useEffect(() => {
    if (!authStatus.loggedIn || !canChat) setChatOpen(false);
  }, [authStatus.loggedIn, canChat]);

  // Poll unread count (for the "Открыть чат" counter).
  useEffect(() => {
    if (!authStatus.loggedIn || !canChat || viewMode) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.matrica.chat.unreadCount();
        if (!alive) return;
        if ((r as any)?.ok) setChatUnreadTotal(Number((r as any).total ?? 0));
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [authStatus.loggedIn, canChat, viewMode]);

  // Gate: если вкладка скрылась по permissions — переключаем на первую доступную.
  useEffect(() => {
    if (tab === 'engine' || tab === 'request' || tab === 'part') return;
    if (visibleTabs.includes(tab)) return;
    setTab(visibleTabs[0] ?? 'auth');
  }, [tab, visibleTabsKey]);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await window.matrica.sync.status();
        if (!alive) return;
        setSyncStatus(s);
      } catch {
        // ignore
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  async function refreshEngines() {
    const list = await window.matrica.engines.list();
    setEngines(list);
  }

  async function openEngine(id: string) {
    setSelectedEngineId(id);
    setTab('engine');
    const d = await window.matrica.engines.get(id);
    setEngineDetails(d);
    const o = await window.matrica.operations.list(id);
    setOps(o);
  }

  async function openRequest(id: string) {
    setSelectedRequestId(id);
    setTab('request');
  }

  async function openPart(id: string) {
    setSelectedPartId(id);
    setTab('part');
  }

  async function navigateDeepLink(link: any) {
    const tabId = String(link?.tab ?? '') as any;
    const engineId = link?.engineId ? String(link.engineId) : null;
    const requestId = link?.requestId ? String(link.requestId) : null;
    const partId = link?.partId ? String(link.partId) : null;

    // Prefer opening specific entities if IDs are present.
    if (engineId) {
      await openEngine(engineId);
      return;
    }
    if (requestId) {
      await openRequest(requestId);
      return;
    }
    if (partId) {
      await openPart(partId);
      return;
    }
    setTab(tabId);
  }

  async function sendCurrentPositionToChat() {
    if (!authStatus.loggedIn || !canChat) return;
    const link = {
      kind: 'app_link',
      tab,
      engineId: selectedEngineId ?? null,
      requestId: selectedRequestId ?? null,
      partId: selectedPartId ?? null,
    };
    const r = await window.matrica.chat.sendDeepLink({ recipientUserId: null, link }).catch(() => null);
    if (r && (r as any).ok && !viewMode) void window.matrica.sync.run().catch(() => {});
  }

  async function reloadEngine() {
    if (!selectedEngineId) return;
    const d = await window.matrica.engines.get(selectedEngineId);
    setEngineDetails(d);
    const o = await window.matrica.operations.list(selectedEngineId);
    setOps(o);
  }

  async function refreshAudit() {
    const a = await window.matrica.audit.list();
    setAudit(a);
  }

  const pageTitle =
    tab === 'engines'
      ? 'Матрица РМЗ — Двигатели'
      : tab === 'engine'
        ? 'Матрица РМЗ — Карточка двигателя'
        : tab === 'changes'
          ? 'Матрица РМЗ — Изменения'
        : tab === 'requests'
          ? 'Матрица РМЗ — Заявки'
          : tab === 'request'
            ? 'Матрица РМЗ — Заявка'
          : tab === 'parts'
            ? 'Матрица РМЗ — Детали'
            : tab === 'part'
              ? 'Матрица РМЗ — Карточка детали'
        : tab === 'auth'
          ? 'Матрица РМЗ — Вход'
        : tab === 'settings'
          ? 'Матрица РМЗ — Настройки'
        : tab === 'reports'
          ? 'Матрица РМЗ — Отчёты'
          : tab === 'admin'
            ? 'Матрица РМЗ — Справочники'
          : 'Матрица РМЗ — Журнал';

  function formatSyncStatusRu(s: SyncStatus | null): { text: string; isError: boolean } {
    if (viewMode) return { text: 'Синхр: ОТКЛ (режим просмотра резервной копии)', isError: true };
    if (!s) return { text: 'Синхр: … | последн.: — | следующий через —', isError: false };
    const stateLabel = s.state === 'idle' ? 'OK' : s.state === 'syncing' ? 'СИНХР' : 'ОШИБКА';
    const last = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString('ru-RU') : '—';
    const next =
      s.nextAutoSyncInMs == null
        ? '—'
        : s.nextAutoSyncInMs >= 60_000
          ? `${Math.ceil(s.nextAutoSyncInMs / 60_000)} мин.`
          : `${Math.ceil(s.nextAutoSyncInMs / 1000)} сек.`;
    return {
      text: `Синхр: ${stateLabel} | последн.: ${last} | следующий через ${next}`,
      isError: s.state === 'error',
    };
  }

  return (
    <Page
      title={pageTitle}
      right={
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'flex-end' }}>
          {authStatus.loggedIn && canChat && !chatOpen && (
            <Button
              variant="ghost"
              onClick={() => setChatOpen(true)}
              title="Открыть окно чата"
            >
              Открыть Чат
              {chatUnreadTotal > 0 ? (
                <span style={{ marginLeft: 6, color: '#b91c1c', fontWeight: 900 }}>
                  {chatUnreadTotal}
                </span>
              ) : null}
            </Button>
          )}
          {authStatus.loggedIn && canChat && (
            <Button variant="ghost" onClick={() => void sendCurrentPositionToChat()} title="Отправить ссылку на текущий раздел в общий чат">
              Отправить ссылку
            </Button>
          )}
          {authStatus.loggedIn && caps.canUseSync && !viewMode && (
            <Button
              variant="ghost"
              onClick={() => void runSyncNow({ showStatusMessage: true })}
              disabled={syncStatus?.state === 'syncing'}
              title="Запустить синхронизацию вручную"
            >
              Синхронизировать сейчас
            </Button>
          )}
          <div
            style={{
              color: formatSyncStatusRu(syncStatus).isError ? '#b91c1c' : '#6b7280',
              fontSize: 12,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              alignItems: 'center',
              maxWidth: 700,
              justifyContent: 'flex-end',
            }}
          >
            <span>
              Клиент:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{clientVersion || '—'}</span>
            </span>
            <span>|</span>
            <span>
              Сервер:{' '}
              <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                {serverInfo?.ok ? serverInfo.version ?? '—' : '—'}
              </span>
            </span>
            <span>|</span>
            <span>{formatSyncStatusRu(syncStatus).text}</span>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', gap: 10, height: '100%', minHeight: 0 }}>
        <div
          style={{
            flex: chatOpen && authStatus.loggedIn && canChat ? '0 0 75%' : '1 1 auto',
            minWidth: 0,
            overflow: 'auto',
            paddingRight: 2,
          }}
        >
          {viewMode && (
            <div style={{ marginBottom: 10, padding: 10, borderRadius: 12, border: '1px solid #fecaca', background: '#fff1f2', color: '#b91c1c', fontWeight: 800 }}>
              Режим просмотра резервной копии, данные изменять невозможно, только копировать и сохранять в файлы
            </div>
          )}
          <Tabs
            tab={tab}
            onTab={(t) => {
              if (!authStatus.loggedIn && t !== 'auth') {
                setTab('auth');
                return;
              }
              if (!visibleTabs.includes(t)) return;
              setTab(t);
              if (t === 'audit') void refreshAudit();
            }}
            visibleTabs={visibleTabs}
            authLabel={authStatus.loggedIn ? authStatus.user?.username ?? 'Вход' : 'Войти'}
          />

          <div style={{ marginTop: 14 }}>
            {postLoginSyncMsg && (
              <div style={{ marginBottom: 12, padding: 10, borderRadius: 12, background: '#ecfeff', color: '#155e75' }}>
                {postLoginSyncMsg}
              </div>
            )}
            {!authStatus.loggedIn && tab !== 'auth' && (
              <div style={{ color: '#6b7280' }}>Требуется вход.</div>
            )}

        {tab === 'engines' && (
          <EnginesPage
            engines={engines}
            onRefresh={refreshEngines}
            onOpen={openEngine}
            onCreate={async () => {
              const r = await window.matrica.engines.create();
              await window.matrica.engines.setAttr(r.id, 'engine_number', '');
              await window.matrica.engines.setAttr(r.id, 'engine_brand', '');
                    await refreshEngines();
              await openEngine(r.id);
                  }}
            canCreate={caps.canEditEngines}
            canDelete={caps.canEditEngines}
          />
        )}

        {tab === 'requests' && (
          <SupplyRequestsPage
            onOpen={openRequest}
            canCreate={caps.canCreateSupplyRequests}
            canDelete={caps.canEditSupplyRequests}
          />
        )}

        {tab === 'engine' && selectedEngineId && engineDetails && (
          <EngineDetailsPage
            key={selectedEngineId}
            engineId={selectedEngineId}
            engine={engineDetails}
            ops={ops}
            onReload={reloadEngine}
            onEngineUpdated={async () => {
              await refreshEngines();
              await reloadEngine();
            }}
            onAddOp={async (operationType, status, note) => {
              await window.matrica.operations.add(selectedEngineId, operationType, status, note);
              await reloadEngine();
              }}
            canEditEngines={caps.canEditEngines}
            canViewOperations={caps.canViewOperations}
            canEditOperations={caps.canEditOperations}
            canPrintEngineCard={caps.canPrintReports}
            canViewMasterData={caps.canViewMasterData}
            canExportReports={caps.canExportReports}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
          />
      )}

        {tab === 'request' && selectedRequestId && (
          <SupplyRequestDetailsPage
            key={selectedRequestId}
            id={selectedRequestId}
            canEdit={caps.canEditSupplyRequests}
            canSign={caps.canSignSupplyRequests}
            canApprove={caps.canApproveSupplyRequests}
            canAccept={caps.canAcceptSupplyRequests}
            canFulfill={caps.canFulfillSupplyRequests}
            canPrint={caps.canPrintSupplyRequests}
            canViewMasterData={caps.canViewMasterData}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
          />
        )}

        {tab === 'parts' && (
          <PartsPage
            onOpen={async (id) => {
              setSelectedPartId(id);
              setTab('part');
            }}
            canCreate={caps.canCreateParts}
          />
        )}

        {tab === 'part' && selectedPartId && (
          <PartDetailsPage
            key={selectedPartId}
            partId={selectedPartId}
            canEdit={caps.canEditParts}
            canDelete={caps.canDeleteParts}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
          />
        )}

        {tab === 'changes' && authStatus.loggedIn && authStatus.user && (
          <ChangesPage me={authStatus.user} canDecideAsAdmin={String(authStatus.user.role ?? '').toLowerCase() === 'admin'} />
        )}

        {tab === 'settings' && <SettingsPage />}

        {tab === 'reports' && <ReportsPage canExport={caps.canExportReports} />}

        {tab === 'admin' && (
          <AdminPage
            permissions={authStatus.permissions ?? {}}
            canViewMasterData={caps.canViewMasterData}
            canEditMasterData={caps.canEditMasterData}
            canManageUsers={caps.canManageUsers}
          />
        )}

        {tab === 'auth' && (
          <AuthPage
            onChanged={(s) => {
              setAuthStatus(s);
            }}
          />
        )}

        {tab === 'audit' && <AuditPage audit={audit} onRefresh={refreshAudit} />}

        {tab === 'engine' && (!selectedEngineId || !engineDetails) && (
          <div style={{ color: '#6b7280' }}>Выберите двигатель из списка.</div>
      )}

        {tab === 'request' && !selectedRequestId && (
          <div style={{ color: '#6b7280' }}>Выберите заявку из списка.</div>
        )}

        {tab === 'part' && !selectedPartId && (
          <div style={{ color: '#6b7280' }}>Выберите деталь из списка.</div>
        )}
          </div>
        </div>

        {chatOpen && authStatus.loggedIn && canChat && (
          <div style={{ flex: '0 0 25%', minWidth: 320, borderLeft: '1px solid rgba(0,0,0,0.08)', overflow: 'hidden' }}>
            <ChatPanel
              meUserId={authStatus.user?.id ?? ''}
              canExport={canChatExport}
              canAdminViewAll={canChatAdminView}
              viewMode={viewMode}
              onHide={() => setChatOpen(false)}
              onNavigate={(link) => {
                void navigateDeepLink(link);
              }}
            />
          </div>
        )}
      </div>
    </Page>
  );
}


