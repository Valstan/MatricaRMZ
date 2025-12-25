import React, { useMemo, useState } from 'react';

import type { EngineDetails, OperationItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';

type LinkOpt = { id: string; label: string };

function escapeHtml(s: string) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function printEngineReport(engine: EngineDetails, ops: OperationItem[]) {
  const number = String(engine.attributes?.engine_number ?? '');
  const brand = String(engine.attributes?.engine_brand ?? '');
  const created = new Date(engine.createdAt).toLocaleString('ru-RU');

  const rows = [...ops].sort((a, b) => (a.performedAt ?? a.createdAt) - (b.performedAt ?? b.createdAt));
  const opsHtml = rows
    .map((o) => {
      const dt = new Date(o.performedAt ?? o.createdAt).toLocaleString('ru-RU');
      return `<tr>
  <td>${escapeHtml(dt)}</td>
  <td>${escapeHtml(opLabel(o.operationType))}</td>
  <td>${escapeHtml(o.status)}</td>
  <td>${escapeHtml(o.note ?? '')}</td>
</tr>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Карта двигателя</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 24px; }
    h1 { margin: 0 0 12px 0; font-size: 20px; }
    .meta { color: #444; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 12px; }
    th { background: #f5f5f5; }
    .muted { color: #666; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px;">
    <button onclick="window.print()">Печать</button>
  </div>
  <h1>Карта двигателя</h1>
  <div class="meta">
    <div><b>Номер:</b> ${escapeHtml(number || '-')}</div>
    <div><b>Марка:</b> ${escapeHtml(brand || '-')}</div>
    <div class="muted"><b>Создан:</b> ${escapeHtml(created)}</div>
  </div>
  <h2 style="font-size:14px;margin:0 0 8px 0;">Таймлайн операций</h2>
  <table>
    <thead><tr><th>Дата</th><th>Тип</th><th>Статус</th><th>Комментарий</th></tr></thead>
    <tbody>
      ${opsHtml || '<tr><td colspan="4" class="muted">Нет операций</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  // дать браузеру отрисовать
  setTimeout(() => w.focus(), 200);
}

function opLabel(type: string) {
  switch (type) {
    case 'acceptance':
      return 'Приемка';
    case 'kitting':
      return 'Комплектовка';
    case 'defect':
      return 'Дефектовка';
    case 'repair':
      return 'Ремонт';
    case 'test':
      return 'Испытания';
    case 'disassembly':
      return 'Разборка';
    case 'otk':
      return 'ОТК';
    case 'packaging':
      return 'Упаковка';
    case 'shipment':
      return 'Отгрузка';
    case 'customer_delivery':
      return 'Доставка заказчику';
    default:
      return type;
  }
}

export function EngineDetailsPage(props: {
  engineId: string;
  engine: EngineDetails;
  ops: OperationItem[];
  onBack: () => void;
  onReload: () => Promise<void>;
  onSaveAttrs: (engineNumber: string, engineBrand: string) => Promise<void>;
  onAddOp: (operationType: string, status: string, note?: string) => Promise<void>;
  canEditEngines: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canPrintEngineCard: boolean;
  canViewMasterData: boolean;
}) {
  const [engineNumber, setEngineNumber] = useState(String(props.engine.attributes?.engine_number ?? ''));
  const [engineBrand, setEngineBrand] = useState(String(props.engine.attributes?.engine_brand ?? ''));

  const [customerId, setCustomerId] = useState(String(props.engine.attributes?.customer_id ?? ''));
  const [contractId, setContractId] = useState(String(props.engine.attributes?.contract_id ?? ''));
  const [workOrderId, setWorkOrderId] = useState(String(props.engine.attributes?.work_order_id ?? ''));
  const [workshopId, setWorkshopId] = useState(String(props.engine.attributes?.workshop_id ?? ''));
  const [sectionId, setSectionId] = useState(String(props.engine.attributes?.section_id ?? ''));

  const [linkLists, setLinkLists] = useState<Record<string, LinkOpt[]>>({});

  const [newOpType, setNewOpType] = useState<string>('acceptance');
  const [newOpStatus, setNewOpStatus] = useState<string>('выполнено');
  const [newOpNote, setNewOpNote] = useState<string>('');

  const sortedOps = useMemo(() => {
    return [...props.ops].sort((a, b) => (b.performedAt ?? b.createdAt) - (a.performedAt ?? a.createdAt));
  }, [props.ops]);

  async function loadLinkLists() {
    const types = await window.matrica.admin.entityTypes.list();
    const typeIdByCode = new Map(types.map((t) => [t.code, t.id] as const));
    async function load(code: string, key: string) {
      const tid = typeIdByCode.get(code);
      if (!tid) return;
      const rows = await window.matrica.admin.entities.listByEntityType(tid);
      setLinkLists((p) => ({ ...p, [key]: rows.map((x) => ({ id: x.id, label: x.displayName ? `${x.displayName}` : x.id })) }));
    }
    await load('customer', 'customer_id');
    await load('contract', 'contract_id');
    await load('work_order', 'work_order_id');
    await load('workshop', 'workshop_id');
    await load('section', 'section_id');
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Button variant="ghost" onClick={props.onBack}>
          ← Назад
        </Button>
        {props.canPrintEngineCard && (
          <Button
            variant="ghost"
            onClick={() => {
              printEngineReport(props.engine, props.ops);
            }}
          >
            Печать
          </Button>
        )}
        <div style={{ flex: 1 }} />
        <Button variant="ghost" onClick={props.onReload}>
          Обновить
        </Button>
      </div>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10 }}>
          <div style={{ color: '#6b7280' }}>Номер двигателя</div>
          <Input value={engineNumber} disabled={!props.canEditEngines} onChange={(e) => setEngineNumber(e.target.value)} />
          <div style={{ color: '#6b7280' }}>Марка двигателя</div>
          <Input value={engineBrand} disabled={!props.canEditEngines} onChange={(e) => setEngineBrand(e.target.value)} />

          {props.canViewMasterData && (
            <>
              <div style={{ color: '#6b7280' }}>Заказчик</div>
              <select
                value={customerId}
                disabled={!props.canEditEngines}
                onFocus={() => {
                  if (!linkLists.customer_id) void loadLinkLists();
                }}
                onChange={(e) => setCustomerId(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                <option value="">(не выбрано)</option>
                {(linkLists.customer_id ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          )}

          {props.canViewMasterData && (
            <>
              <div style={{ color: '#6b7280' }}>Контракт</div>
              <select
                value={contractId}
                disabled={!props.canEditEngines}
                onFocus={() => {
                  if (!linkLists.contract_id) void loadLinkLists();
                }}
                onChange={(e) => setContractId(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                <option value="">(не выбрано)</option>
                {(linkLists.contract_id ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          )}

          {props.canViewMasterData && (
            <>
              <div style={{ color: '#6b7280' }}>Наряд</div>
              <select
                value={workOrderId}
                disabled={!props.canEditEngines}
                onFocus={() => {
                  if (!linkLists.work_order_id) void loadLinkLists();
                }}
                onChange={(e) => setWorkOrderId(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                <option value="">(не выбрано)</option>
                {(linkLists.work_order_id ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          )}

          {props.canViewMasterData && (
            <>
              <div style={{ color: '#6b7280' }}>Цех</div>
              <select
                value={workshopId}
                disabled={!props.canEditEngines}
                onFocus={() => {
                  if (!linkLists.workshop_id) void loadLinkLists();
                }}
                onChange={(e) => setWorkshopId(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                <option value="">(не выбрано)</option>
                {(linkLists.workshop_id ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          )}

          {props.canViewMasterData && (
            <>
              <div style={{ color: '#6b7280' }}>Участок</div>
              <select
                value={sectionId}
                disabled={!props.canEditEngines}
                onFocus={() => {
                  if (!linkLists.section_id) void loadLinkLists();
                }}
                onChange={(e) => setSectionId(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                <option value="">(не выбрано)</option>
                {(linkLists.section_id ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          {props.canEditEngines && (
            <Button
              onClick={() => {
                void props.onSaveAttrs(engineNumber, engineBrand);
              }}
            >
              Сохранить
            </Button>
          )}
          {props.canEditEngines && props.canViewMasterData && (
            <Button
              variant="ghost"
              onClick={() => {
                void window.matrica.engines.setAttr(props.engineId, 'customer_id', customerId || null);
                void window.matrica.engines.setAttr(props.engineId, 'contract_id', contractId || null);
                void window.matrica.engines.setAttr(props.engineId, 'work_order_id', workOrderId || null);
                void window.matrica.engines.setAttr(props.engineId, 'workshop_id', workshopId || null);
                void window.matrica.engines.setAttr(props.engineId, 'section_id', sectionId || null);
                void props.onReload();
              }}
            >
              Сохранить связи
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => {
              setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
              setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
              setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
              setContractId(String(props.engine.attributes?.contract_id ?? ''));
              setWorkOrderId(String(props.engine.attributes?.work_order_id ?? ''));
              setWorkshopId(String(props.engine.attributes?.workshop_id ?? ''));
              setSectionId(String(props.engine.attributes?.section_id ?? ''));
            }}
          >
            Отменить
          </Button>
        </div>
      </div>

      {props.canViewOperations && (
        <div style={{ marginTop: 14 }}>
          <h2 style={{ margin: '8px 0' }}>Таймлайн / операции</h2>

          {props.canEditOperations && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
              <select
                value={newOpType}
                onChange={(e) => setNewOpType(e.target.value)}
                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
              >
                <option value="acceptance">Приемка</option>
                <option value="kitting">Комплектовка</option>
                <option value="disassembly">Разборка</option>
                <option value="defect">Дефектовка</option>
                <option value="repair">Ремонт</option>
                <option value="test">Испытания</option>
                <option value="otk">ОТК</option>
                <option value="packaging">Упаковка</option>
                <option value="shipment">Отгрузка</option>
                <option value="customer_delivery">Доставка заказчику</option>
              </select>
              <div style={{ width: 180 }}>
                <Input value={newOpStatus} onChange={(e) => setNewOpStatus(e.target.value)} placeholder="Статус" />
              </div>
              <div style={{ flex: 1 }}>
                <Input value={newOpNote} onChange={(e) => setNewOpNote(e.target.value)} placeholder="Комментарий" />
              </div>
              <Button
                onClick={() => {
                  void props.onAddOp(newOpType, newOpStatus, newOpNote || undefined);
                  setNewOpNote('');
                }}
              >
                Добавить
              </Button>
            </div>
          )}

          <div style={{ marginTop: 10, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'linear-gradient(135deg, #1d4ed8 0%, #7c3aed 120%)', color: '#fff' }}>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Дата</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Тип</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Статус</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid rgba(255,255,255,0.25)', padding: 10 }}>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {sortedOps.map((o) => (
                  <tr key={o.id}>
                    <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>
                      {new Date(o.performedAt ?? o.createdAt).toLocaleString('ru-RU')}
                    </td>
                    <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{opLabel(o.operationType)}</td>
                    <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{o.status}</td>
                    <td style={{ borderBottom: '1px solid #f3f4f6', padding: 10 }}>{o.note ?? ''}</td>
                  </tr>
                ))}
                {sortedOps.length === 0 && (
                  <tr>
                    <td style={{ padding: 12, color: '#6b7280' }} colSpan={4}>
                      Операций пока нет
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


