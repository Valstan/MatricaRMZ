import React, { useEffect, useRef, useState } from 'react';

import type { AuditItem, AuthStatus, EngineDetails, EngineListItem, OperationItem, SyncStatus } from '@matricarmz/shared';

import { Page } from './layout/Page.js';
import { Tabs, type TabId } from './layout/Tabs.js';
import { EnginesPage } from './pages/EnginesPage.js';
import { EngineDetailsPage } from './pages/EngineDetailsPage.js';
import { ChangesPage } from './pages/ChangesPage.js';
import { SyncPage } from './pages/SyncPage.js';
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

export function App() {
  const [ping, setPing] = useState<string>('...');
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({ loggedIn: false, user: null });
  const [tab, setTab] = useState<TabId>('engines');
  const [postLoginSyncMsg, setPostLoginSyncMsg] = useState<string>('');
  const prevLoggedIn = useRef<boolean>(false);

  const [engines, setEngines] = useState<EngineListItem[]>([]);
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [engineDetails, setEngineDetails] = useState<EngineDetails | null>(null);
  const [ops, setOps] = useState<OperationItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);

  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null);

  useEffect(() => {
    window.matrica
      .ping()
      .then((r) => setPing(`ok=${r.ok}, ts=${new Date(r.ts).toLocaleString('ru-RU')}`))
      .catch((e) => setPing(`ошибка: ${String(e)}`));

    void refreshEngines();
    void window.matrica.auth.status().then(setAuthStatus).catch(() => {});
  }, []);

  // After successful login: run one sync so the user immediately sees shared data (e.g. engines created by admins).
  useEffect(() => {
    const was = prevLoggedIn.current;
    const now = authStatus.loggedIn === true;
    prevLoggedIn.current = now;
    if (now && !was) {
      setPostLoginSyncMsg('После входа выполняю синхронизацию…');
      void (async () => {
        try {
          const r = await window.matrica.sync.run();
          if (r.ok) {
            await refreshEngines();
            setPostLoginSyncMsg(`Синхронизация выполнена: push=${r.pushed}, pull=${r.pulled}.`);
          } else {
            setPostLoginSyncMsg(`Не удалось синхронизироваться автоматически: ${r.error ?? 'unknown'}. Откройте вкладку «Синхронизация».`);
          }
        } catch (e) {
          setPostLoginSyncMsg(`Не удалось синхронизироваться автоматически: ${String(e)}. Откройте вкладку «Синхронизация».`);
        } finally {
          // keep message visible a bit, then hide
          setTimeout(() => setPostLoginSyncMsg(''), 12_000);
        }
      })();
    }
  }, [authStatus.loggedIn]);

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

  const caps = deriveUiCaps(authStatus.permissions ?? null);
  const visibleTabs: Exclude<TabId, 'engine' | 'request' | 'part'>[] = [
    ...(caps.canViewEngines ? (['engines'] as const) : []),
    ...(caps.canViewSupplyRequests ? (['requests'] as const) : []),
    ...(caps.canViewParts ? (['parts'] as const) : []),
    ...(caps.canUseUpdates ? (['changes'] as const) : []),
    ...(caps.canUseSync ? (['sync'] as const) : []),
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
        : tab === 'sync'
          ? 'Матрица РМЗ — Синхронизация'
        : tab === 'settings'
          ? 'Матрица РМЗ — Настройки'
        : tab === 'reports'
          ? 'Матрица РМЗ — Отчёты'
          : tab === 'admin'
            ? 'Матрица РМЗ — Справочники'
          : 'Матрица РМЗ — Журнал';

  function formatSyncStatus(s: SyncStatus | null): string {
    if (!s) return 'SYNC: ...';
    const stateLabel = s.state === 'idle' ? 'OK' : s.state === 'syncing' ? 'SYNC' : 'ERR';
    const last = s.lastSyncAt ? new Date(s.lastSyncAt).toLocaleTimeString('ru-RU') : '-';
    const next =
      s.nextAutoSyncInMs == null
        ? '-'
        : s.nextAutoSyncInMs >= 60_000
          ? `${Math.ceil(s.nextAutoSyncInMs / 60_000)}м`
          : `${Math.ceil(s.nextAutoSyncInMs / 1000)}с`;
    return `SYNC: ${stateLabel} | last ${last} | next ${next}`;
  }

  return (
    <Page
      title={pageTitle}
      right={
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
          <div style={{ color: '#6b7280', fontSize: 12 }}>IPC: {ping}</div>
          <div style={{ color: '#6b7280', fontSize: 12 }}>
            AUTH: {authStatus.loggedIn ? authStatus.user?.username ?? 'ok' : 'no'}
          </div>
          <div style={{ color: syncStatus?.state === 'error' ? '#b91c1c' : '#6b7280', fontSize: 12 }}>
            {formatSyncStatus(syncStatus)}
          </div>
          </div>
      }
    >
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
            engineId={selectedEngineId}
            engine={engineDetails}
            ops={ops}
            onBack={() => setTab('engines')}
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
            id={selectedRequestId}
            onBack={() => setTab('requests')}
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
            onOpen={(id) => {
              setSelectedPartId(id);
              setTab('part');
            }}
            canCreate={caps.canCreateParts}
          />
        )}

        {tab === 'part' && selectedPartId && (
          <PartDetailsPage
            partId={selectedPartId}
            canEdit={caps.canEditParts}
            canDelete={caps.canDeleteParts}
            canViewFiles={caps.canViewFiles}
            canUploadFiles={caps.canUploadFiles}
            onBack={() => setTab('parts')}
          />
        )}

        {tab === 'sync' && <SyncPage onAfterSync={refreshEngines} />}

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
    </Page>
  );
}


