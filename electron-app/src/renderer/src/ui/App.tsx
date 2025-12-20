import React, { useEffect, useState } from 'react';

declare global {
  interface Window {
    matrica: {
      ping: () => Promise<{ ok: boolean; ts: number }>;
      engines: {
        list: () => Promise<any[]>;
        create: () => Promise<{ id: string }>;
        get: (id: string) => Promise<any>;
        setAttr: (engineId: string, code: string, value: unknown) => Promise<void>;
      };
      operations: {
        list: (engineId: string) => Promise<any[]>;
        add: (engineId: string, operationType: string, status: string, note?: string) => Promise<void>;
      };
      audit: {
        list: () => Promise<any[]>;
      };
      sync: {
        run: () => Promise<{ ok: boolean; pushed: number; pulled: number; serverCursor: number; error?: string }>;
      };
      update: {
        check: () => Promise<{ ok: boolean; updateAvailable?: boolean; version?: string; error?: string }>;
        download: () => Promise<{ ok: boolean; error?: string }>;
        install: () => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}

export function App() {
  const [ping, setPing] = useState<string>('...');
  const [engines, setEngines] = useState<any[]>([]);
  const [syncStatus, setSyncStatus] = useState<string>('');
  const [tab, setTab] = useState<'engines' | 'engine' | 'sync' | 'audit'>('engines');
  const [selectedEngineId, setSelectedEngineId] = useState<string | null>(null);
  const [engineDetails, setEngineDetails] = useState<any | null>(null);
  const [ops, setOps] = useState<any[]>([]);
  const [audit, setAudit] = useState<any[]>([]);
  const [newOpType, setNewOpType] = useState<string>('acceptance');
  const [newOpStatus, setNewOpStatus] = useState<string>('выполнено');
  const [newOpNote, setNewOpNote] = useState<string>('');
  const [updateStatus, setUpdateStatus] = useState<string>('');

  useEffect(() => {
    window.matrica
      .ping()
      .then((r) => setPing(`ok=${r.ok}, ts=${new Date(r.ts).toLocaleString('ru-RU')}`))
      .catch((e) => setPing(`ошибка: ${String(e)}`));

    window.matrica.engines
      .list()
      .then(setEngines)
      .catch(() => setEngines([]));
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

  async function refreshAudit() {
    const a = await window.matrica.audit.list();
    setAudit(a);
  }

  function TabButton(props: { id: typeof tab; title: string }) {
    const active = tab === props.id;
    return (
      <button
        onClick={() => setTab(props.id)}
        style={{
          padding: '6px 10px',
          borderRadius: 8,
          border: '1px solid #ddd',
          background: active ? '#f3f4f6' : '#fff',
          cursor: 'pointer',
        }}
      >
        {props.title}
      </button>
    );
  }

  return (
    <div style={{ fontFamily: 'system-ui', padding: 16 }}>
      <h1 style={{ margin: 0 }}>Матрица РМЗ</h1>
      <p style={{ color: '#555' }}>Тест связи renderer → main (IPC): {ping}</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <TabButton id="engines" title="Двигатели" />
        <TabButton id="sync" title="Синхронизация" />
        <TabButton id="audit" title="Журнал действий" />
        <span style={{ flex: 1 }} />
        <span style={{ color: '#555' }}>{syncStatus}</span>
      </div>

      {tab === 'engines' && (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 }}>
            <button
              onClick={async () => {
                const r = await window.matrica.engines.create();
                await window.matrica.engines.setAttr(r.id, 'engine_number', 'ТЕСТ-001');
                await window.matrica.engines.setAttr(r.id, 'engine_brand', 'ТЕСТ-МАРКА');
                await refreshEngines();
              }}
            >
              Добавить тестовый двигатель
            </button>
            <button onClick={refreshEngines}>Обновить список</button>
          </div>

          <h2 style={{ marginTop: 16 }}>Двигатели</h2>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Номер</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Марка</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Sync</th>
              </tr>
            </thead>
            <tbody>
              {engines.map((e) => (
                <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => openEngine(e.id)}>
                  <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{e.engineNumber ?? '-'}</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{e.engineBrand ?? '-'}</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{e.syncStatus ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === 'engine' && selectedEngineId && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
            <button onClick={() => setTab('engines')}>← Назад</button>
            <strong>Карточка двигателя</strong>
          </div>

          {engineDetails ? (
            <>
              <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '160px 1fr', gap: 8 }}>
                <div style={{ color: '#555' }}>Номер двигателя</div>
                <input
                  value={String(engineDetails.attributes?.engine_number ?? '')}
                  onChange={(e) =>
                    setEngineDetails({
                      ...engineDetails,
                      attributes: { ...(engineDetails.attributes ?? {}), engine_number: e.target.value },
                    })
                  }
                />
                <div style={{ color: '#555' }}>Марка двигателя</div>
                <input
                  value={String(engineDetails.attributes?.engine_brand ?? '')}
                  onChange={(e) =>
                    setEngineDetails({
                      ...engineDetails,
                      attributes: { ...(engineDetails.attributes ?? {}), engine_brand: e.target.value },
                    })
                  }
                />
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button
                  onClick={async () => {
                    await window.matrica.engines.setAttr(
                      selectedEngineId,
                      'engine_number',
                      engineDetails.attributes?.engine_number ?? '',
                    );
                    await window.matrica.engines.setAttr(
                      selectedEngineId,
                      'engine_brand',
                      engineDetails.attributes?.engine_brand ?? '',
                    );
                    await refreshEngines();
                    const d = await window.matrica.engines.get(selectedEngineId);
                    setEngineDetails(d);
                  }}
                >
                  Сохранить
                </button>
                <button
                  onClick={async () => {
                    const d = await window.matrica.engines.get(selectedEngineId);
                    setEngineDetails(d);
                  }}
                >
                  Отменить
                </button>
              </div>

              <h3 style={{ marginTop: 16 }}>Операции / стадии</h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <select value={newOpType} onChange={(e) => setNewOpType(e.target.value)}>
                  <option value="acceptance">Приемка</option>
                  <option value="kitting">Комплектовка</option>
                  <option value="defect">Дефектовка</option>
                  <option value="repair">Ремонт</option>
                  <option value="test">Испытания</option>
                </select>
                <input
                  value={newOpStatus}
                  onChange={(e) => setNewOpStatus(e.target.value)}
                  placeholder="Статус"
                />
                <input value={newOpNote} onChange={(e) => setNewOpNote(e.target.value)} placeholder="Примечание" />
                <button
                  onClick={async () => {
                    await window.matrica.operations.add(selectedEngineId, newOpType, newOpStatus, newOpNote || undefined);
                    const o = await window.matrica.operations.list(selectedEngineId);
                    setOps(o);
                    setNewOpNote('');
                  }}
                >
                  Добавить операцию
                </button>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Дата</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Тип</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Статус</th>
                    <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Примечание</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.map((o) => (
                    <tr key={o.id}>
                      <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>
                        {new Date(o.createdAt).toLocaleString('ru-RU')}
                      </td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{o.operationType}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{o.status}</td>
                      <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{o.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p style={{ color: '#555' }}>Загрузка...</p>
          )}
        </>
      )}

      {tab === 'sync' && (
        <>
          <h2 style={{ marginTop: 16 }}>Синхронизация</h2>
          <button
            onClick={async () => {
              setSyncStatus('Синхронизация...');
              const r = await window.matrica.sync.run();
              setSyncStatus(
                r.ok
                  ? `OK: push=${r.pushed}, pull=${r.pulled}, cursor=${r.serverCursor}`
                  : `Ошибка: ${r.error ?? 'unknown'}`,
              );
              await refreshEngines();
            }}
          >
            Синхронизировать сейчас
          </button>
          <p style={{ color: '#555' }}>
            Для теста: запустите backend-api и укажите адрес через переменную окружения <code>MATRICA_API_URL</code>.
          </p>

          <h3 style={{ marginTop: 16 }}>Обновления</h3>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              onClick={async () => {
                setUpdateStatus('Проверка обновлений...');
                const r = await window.matrica.update.check();
                setUpdateStatus(
                  r.ok
                    ? r.updateAvailable
                      ? `Доступно обновление: ${r.version ?? ''}`
                      : 'Обновлений нет'
                    : `Ошибка: ${r.error ?? 'unknown'}`,
                );
              }}
            >
              Проверить обновления
            </button>
            <button
              onClick={async () => {
                setUpdateStatus('Скачивание обновления...');
                const r = await window.matrica.update.download();
                setUpdateStatus(r.ok ? 'Обновление скачано. Нажмите “Установить”.' : `Ошибка: ${r.error ?? 'unknown'}`);
              }}
            >
              Скачать
            </button>
            <button
              onClick={async () => {
                await window.matrica.update.install();
              }}
            >
              Установить
            </button>
            <span style={{ color: '#555' }}>{updateStatus}</span>
          </div>
        </>
      )}

      {tab === 'audit' && (
        <>
          <h2 style={{ marginTop: 16 }}>Журнал действий</h2>
          <button
            onClick={async () => {
              await refreshAudit();
            }}
          >
            Обновить журнал
          </button>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Дата</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Кто</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Действие</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid #ddd', padding: 8 }}>Сущность</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id}>
                  <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>
                    {new Date(a.createdAt).toLocaleString('ru-RU')}
                  </td>
                  <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{a.actor}</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{a.action}</td>
                  <td style={{ borderBottom: '1px solid #eee', padding: 8 }}>{a.entityId ?? '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}


