import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { ListCount } from '../components/ListCount.js';
import { RowNumberCell, RowNumberHeaderCell } from '../components/RowNumberCell.js';
import { useConfirm } from '../components/ConfirmContext.js';

type NodeRow = { name: string; url: string };
type ProbeRow = { url: string; live: boolean; httpStatus: number | null; ms: number; error: string | null };
type HarnessState = {
  installed: boolean;
  installedVersion: string;
  latestKnown: string;
  updateAvailable: boolean;
  running: boolean;
  serveVersion: string;
  firewallRulePresent: boolean;
  exePath: string;
  lastError: string | null;
};

/** OpenCode-узлы (мандат brain 2026-10-12): таблица `opencode serve` в LAN. Только суперадмин. */
export function OpenCodeNodesPage() {
  const [rows, setRows] = useState<NodeRow[]>([]);
  const [probes, setProbes] = useState<Record<string, ProbeRow>>({});
  const [harness, setHarness] = useState<HarnessState | null>(null);
  const [status, setStatus] = useState('');
  const [probing, setProbing] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');

  const { confirm } = useConfirm();

  const refresh = useCallback(async (withProbe: boolean) => {
    setStatus('Загрузка...');
    try {
      const [listRes, harnessRes] = await Promise.all([
        window.matrica.opencodeNodes.list(),
        window.matrica.opencodeNodes.harnessStatus(),
      ]);
      if (!listRes.ok) {
        setStatus(`Ошибка: ${listRes.error}`);
        return;
      }
      setRows(listRes.nodes);
      if (harnessRes.ok) setHarness(harnessRes.status);
      setStatus('');
      if (withProbe) await runProbe(listRes.nodes.length > 0);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }, []);

  async function runProbe(hasRows?: boolean) {
    if (hasRows === false) {
      setProbes({});
      return;
    }
    setProbing(true);
    try {
      const res = await window.matrica.opencodeNodes.probe();
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      const map: Record<string, ProbeRow> = {};
      for (const p of res.probes) map[p.url] = p;
      setProbes(map);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    } finally {
      setProbing(false);
    }
  }

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  const liveCount = useMemo(() => rows.filter((r) => probes[r.url]?.live).length, [rows, probes]);

  async function persist(next: NodeRow[], busy: string) {
    setStatus(busy);
    try {
      const res = await window.matrica.opencodeNodes.save({ nodes: next });
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      setRows(res.nodes);
      setStatus('');
      await runProbe(res.nodes.length > 0);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function addNode() {
    const url = newUrl.trim();
    if (!url) {
      setStatus('Заполните «Адрес»');
      return;
    }
    await persist([...rows, { name: newName.trim(), url }], 'Сохраняю...');
    setNewName('');
    setNewUrl('');
  }

  async function stopHarness() {
    const ok = await confirm({
      title: 'Остановить serve?',
      detail: 'Фоновый serve на этой машине остановится; при следующем запуске клиента он поднимется сам. Узел покажет «мёртв».',
      confirmLabel: 'Остановить',
    });
    if (!ok) return;
    setStatus('Останавливаю...');
    try {
      const res = await window.matrica.opencodeNodes.harnessStop();
      if (!res.ok) {
        setStatus(`Ошибка: ${res.error}`);
        return;
      }
      await refresh(true);
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  async function deleteNode(row: NodeRow) {
    const ok = await confirm({
      title: 'Убрать узел?',
      detail: `Узел «${row.name}» (${row.url}) будет убран из локального реестра на этой машине. Сам serve на узле продолжит работать.`,
      confirmLabel: 'Убрать',
    });
    if (!ok) return;
    await persist(rows.filter((r) => r.url !== row.url), 'Убираю...');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>OpenCode-узлы</h2>
        <Button variant="ghost" onClick={() => void refresh(false)}>Обновить</Button>
        <Button variant="ghost" onClick={() => void runProbe()} disabled={probing || rows.length === 0}>
          {probing ? 'Проверяю...' : 'Проверить'}
        </Button>
        <span style={{ color: 'var(--subtle)', fontSize: 12 }}>
          Живых: {liveCount} из {rows.length}. Реестр — локальный файл этой машины (в git не кладётся).
        </span>
      </div>

      <div style={{ color: 'var(--subtle)', fontSize: 12 }}>
        Бесплатные модели узлов ротируются, лимиты не публикуются, данные могут идти в обучение —
        для чувствительного — Claude Code или ключ OpenRouter. Порт serve — 3080.
      </div>

      {harness ? (
        <div style={{ padding: 8, border: '1px solid var(--border)', borderRadius: 4, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>Служба на этой машине:</strong>
            <span>
              {harness.installed ? `установлена (${harness.installedVersion || 'версия?'})` : 'не установлена — встанет сама при запуске клиента'}
            </span>
            <span>{harness.running ? `· serve отвечает${harness.serveVersion ? ` (${harness.serveVersion})` : ''}` : '· serve молчит'}</span>
            {harness.updateAvailable ? <span>· доступно обновление ({harness.latestKnown}) — подтянется само</span> : null}
            <Button variant="ghost" onClick={() => void stopHarness()} disabled={!harness.running}>
              Остановить serve
            </Button>
          </div>
          {!harness.firewallRulePresent ? (
            <div style={{ marginTop: 6, color: 'var(--subtle)' }}>
              Правила брандмауэра нет — с соседних машин узел недоступен (клиент не может создать
              его без прав администратора). Разовая команда администратора на этой машине:
              <code style={{ display: 'block', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                {`netsh advfirewall firewall add rule name="MatricaRMZ - OpenCode serve (входящий, LAN)" dir=in action=allow protocol=TCP localport=3080 remoteip=localsubnet program="${harness.exePath}" profile=domain,private`}
              </code>
            </div>
          ) : null}
          {harness.lastError ? (
            <div style={{ marginTop: 6, color: 'var(--danger)' }}>Служба: {harness.lastError}</div>
          ) : null}
        </div>
      ) : null}

      {status ? (
        <div style={{ color: status.startsWith('Ошибка') ? 'var(--danger)' : 'var(--subtle)' }}>{status}</div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 8, border: '1px solid var(--border)', borderRadius: 4 }}>
        <strong style={{ minWidth: 120 }}>Новый узел:</strong>
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Имя (например, «PC79»)"
          style={{ width: 200 }}
        />
        <Input
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void addNode(); }}
          placeholder="Адрес (например, «192.168.1.10» или «http://192.168.1.10:3080»)"
          style={{ flex: 1 }}
        />
        <Button onClick={() => void addNode()}>Добавить</Button>
      </div>

      <ListCount total={rows.length} shown={rows.length} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', border: '1px solid var(--border)' }}>
        <table className="list-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <RowNumberHeaderCell />
              <th data-col-kind="name" style={{ width: 200 }}>Имя</th>
              <th data-col-kind="name">Адрес</th>
              <th data-col-kind="flag" title="Статус" style={{ width: 110, textAlign: 'center' }}>Статус</th>
              <th data-col-kind="num" title="Отклик" style={{ width: 100, textAlign: 'right' }}>Отклик, мс</th>
              <th style={{ width: 190 }}>Действия</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', color: 'var(--subtle)', padding: 12 }}>
                  Нет узлов — добавьте первый кнопкой выше
                </td>
              </tr>
            ) : (
              rows.map((row, i) => {
                const probe = probes[row.url];
                return (
                  <tr key={row.url}>
                    <RowNumberCell n={i + 1} />
                    <td data-col-kind="name">{row.name}</td>
                    <td data-col-kind="name">
                      <a href={row.url} target="_blank" rel="noreferrer">
                        <code style={{ fontSize: 12 }}>{row.url}</code>
                      </a>
                    </td>
                    <td data-col-kind="flag" style={{ textAlign: 'center' }} title={probe?.error ?? ''}>
                      {!probe ? (
                        <span style={{ color: 'var(--subtle)' }}>—</span>
                      ) : probe.live ? (
                        <span style={{ color: '#166534' }}>● жив{probe.httpStatus != null ? ` (${probe.httpStatus})` : ''}</span>
                      ) : (
                        <span style={{ color: 'var(--danger)' }}>● мёртв</span>
                      )}
                    </td>
                    <td data-col-kind="num" style={{ textAlign: 'right' }}>{probe ? probe.ms : '—'}</td>
                    <td>
                      <Button variant="ghost" onClick={() => void deleteNode(row)}>Убрать</Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
