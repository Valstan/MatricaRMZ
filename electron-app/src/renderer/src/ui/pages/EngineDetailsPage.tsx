import React, { useEffect, useMemo, useRef, useState } from 'react';

import type { EngineDetails, OperationItem } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { RepairChecklistPanel } from '../components/RepairChecklistPanel.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { SearchSelect } from '../components/SearchSelect.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';

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
  onReload: () => Promise<void>;
  onEngineUpdated: () => Promise<void>;
  onAddOp: (operationType: string, status: string, note?: string) => Promise<void>;
  canEditEngines: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canPrintEngineCard: boolean;
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canExportReports?: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [engineNumber, setEngineNumber] = useState(String(props.engine.attributes?.engine_number ?? ''));
  const [engineBrand, setEngineBrand] = useState(String(props.engine.attributes?.engine_brand ?? ''));
  const [engineBrandId, setEngineBrandId] = useState(String(props.engine.attributes?.engine_brand_id ?? ''));

  const [customerId, setCustomerId] = useState(String(props.engine.attributes?.customer_id ?? ''));
  const [contractId, setContractId] = useState(String(props.engine.attributes?.contract_id ?? ''));
  const [workOrderId, setWorkOrderId] = useState(String(props.engine.attributes?.work_order_id ?? ''));
  const [workshopId, setWorkshopId] = useState(String(props.engine.attributes?.workshop_id ?? ''));
  const [sectionId, setSectionId] = useState(String(props.engine.attributes?.section_id ?? ''));

  const [linkLists, setLinkLists] = useState<Record<string, LinkOpt[]>>({});
  const typeIdByCode = useRef<Record<string, string>>({});

  const [newOpType, setNewOpType] = useState<string>('acceptance');
  const [newOpStatus, setNewOpStatus] = useState<string>('выполнено');
  const [newOpNote, setNewOpNote] = useState<string>('');

  const [saveStatus, setSaveStatus] = useState<string>('');
  const sessionHadChanges = useRef<boolean>(false);
  const initialSnapshot = useRef<{
    engineNumber: string;
    engineBrand: string;
    workshopId: string;
    sectionId: string;
  } | null>(null);

  const sortedOps = useMemo(() => {
    return [...props.ops].sort((a, b) => (b.performedAt ?? b.createdAt) - (a.performedAt ?? a.createdAt));
  }, [props.ops]);

  // Синхронизируем локальные поля с тем, что реально лежит в БД (важно при reload/после sync).
  useEffect(() => {
    setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
    setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
    setEngineBrandId(String(props.engine.attributes?.engine_brand_id ?? ''));
    setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
    setContractId(String(props.engine.attributes?.contract_id ?? ''));
    setWorkOrderId(String(props.engine.attributes?.work_order_id ?? ''));
    setWorkshopId(String(props.engine.attributes?.workshop_id ?? ''));
    setSectionId(String(props.engine.attributes?.section_id ?? ''));
  }, [props.engineId, props.engine.updatedAt]);

  useEffect(() => {
    // Reset “editing session” baseline on engine switch.
    initialSnapshot.current = {
      engineNumber: String(props.engine.attributes?.engine_number ?? ''),
      engineBrand: String(props.engine.attributes?.engine_brand ?? ''),
      workshopId: String(props.engine.attributes?.workshop_id ?? ''),
      sectionId: String(props.engine.attributes?.section_id ?? ''),
    };
    sessionHadChanges.current = false;
  }, [props.engineId]);

  async function saveAttr(code: string, value: unknown) {
    if (!props.canEditEngines) return;
    try {
      setSaveStatus('Сохраняю...');
      await window.matrica.engines.setAttr(props.engineId, code, value);
      await props.onEngineUpdated();
      sessionHadChanges.current = true;
      setSaveStatus('Сохранено');
      setTimeout(() => setSaveStatus(''), 700);
    } catch (e) {
      setSaveStatus(`Ошибка сохранения: ${String(e)}`);
    }
  }

  async function auditEditDone() {
    try {
      if (!sessionHadChanges.current) return;
      const base = initialSnapshot.current;
      const fieldsChanged: string[] = [];
      const push = (ru: string, a: string, b: string) => {
        if ((a ?? '') !== (b ?? '')) fieldsChanged.push(ru);
      };
      push('Номер', base?.engineNumber ?? '', String(engineNumber ?? ''));
      push('Марка', base?.engineBrand ?? '', String(engineBrand ?? ''));
      push('Цех', base?.workshopId ?? '', String(workshopId ?? ''));
      push('Участок', base?.sectionId ?? '', String(sectionId ?? ''));
      if (!fieldsChanged.length) return;
      await window.matrica.audit.add({
        action: 'ui.engine.edit_done',
        entityId: props.engineId,
        tableName: 'entities',
        payload: {
          engineId: props.engineId,
          engineNumber: String(engineNumber || '').trim() || null,
          engineBrand: String(engineBrand || '').trim() || null,
          workshopId: String(workshopId || '').trim() || null,
          sectionId: String(sectionId || '').trim() || null,
          fieldsChanged,
          summaryRu: `Изменил: ${fieldsChanged.join(', ')}`,
        },
      });
      sessionHadChanges.current = false;
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    return () => {
      void auditEditDone();
    };
  }, []);

  async function saveEngineNumber() {
    if (!props.canEditEngines) return;
    await saveAttr('engine_number', engineNumber);
  }

  async function saveAttachments(next: any[]) {
    try {
      await saveAttr('attachments', next);
      return { ok: true as const };
    } catch (e) {
      return { ok: false as const, error: String(e) };
    }
  }

  async function loadLinkLists() {
    const types = await window.matrica.admin.entityTypes.list();
    typeIdByCode.current = Object.fromEntries(types.map((t) => [String(t.code), String(t.id)]));
    const typeIdByCodeMap = new Map(types.map((t) => [t.code, t.id] as const));
    async function load(code: string, key: string) {
      const tid = typeIdByCodeMap.get(code);
      if (!tid) return;
      const rows = await window.matrica.admin.entities.listByEntityType(tid);
      const opts = rows.map((x) => ({ id: x.id, label: x.displayName ? `${x.displayName}` : x.id }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setLinkLists((p) => ({ ...p, [key]: opts }));
    }
    await load('engine_brand', 'engine_brand');
    await load('customer', 'customer_id');
    await load('contract', 'contract_id');
    await load('work_order', 'work_order_id');
    await load('workshop', 'workshop_id');
    await load('section', 'section_id');
  }

  useEffect(() => {
    if (!props.canViewMasterData) return;
    void loadLinkLists();
  }, [props.canViewMasterData]);

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const typeId = typeIdByCode.current[typeCode];
    if (!typeId) {
      setSaveStatus(`Справочник не найден: ${typeCode}`);
      return null;
    }
    const created = await window.matrica.admin.entities.create(typeId);
    if (!created.ok || !created.id) {
      setSaveStatus(`Ошибка создания: ${typeCode}`);
      return null;
    }
    const attrByType: Record<string, string> = {
      engine_brand: 'name',
      customer: 'name',
      contract: 'number',
      work_order: 'number',
      workshop: 'name',
      section: 'name',
    };
    const attr = attrByType[typeCode] ?? 'name';
    await window.matrica.admin.entities.setAttr(created.id, attr, label);
    await loadLinkLists();
    return created.id;
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
        {saveStatus && <div style={{ color: saveStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{saveStatus}</div>}
        <Button variant="ghost" onClick={props.onReload}>
          Обновить
        </Button>
      </div>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 180px) 1fr', gap: 10 }}>
          <div style={{ color: '#6b7280' }}>Номер двигателя</div>
          <Input
            value={engineNumber}
            disabled={!props.canEditEngines}
            onChange={(e) => setEngineNumber(e.target.value)}
            onBlur={() => void saveEngineNumber()}
          />
          <div style={{ color: '#6b7280' }}>Марка двигателя</div>
          {(linkLists.engine_brand ?? []).length > 0 ? (
            <SearchSelectWithCreate
              value={engineBrandId || null}
              options={linkLists.engine_brand ?? []}
              disabled={!props.canEditEngines}
              canCreate={props.canEditMasterData}
              createLabel="Новая марка двигателя"
              onChange={(next) => {
                const nextId = next ?? '';
                const label = next ? (linkLists.engine_brand ?? []).find((o) => o.id === next)?.label ?? '' : '';
                setEngineBrandId(nextId);
                setEngineBrand(label);
                void saveAttr('engine_brand_id', next || null);
                if (next) void saveAttr('engine_brand', label || null);
                else void saveAttr('engine_brand', null);
              }}
              onCreate={async (label) => {
                const id = await createMasterDataItem('engine_brand', label);
                if (!id) return null;
                setEngineBrandId(id);
                setEngineBrand(label);
                void saveAttr('engine_brand_id', id);
                void saveAttr('engine_brand', label);
                return id;
              }}
            />
          ) : (
            <Input
              value={engineBrand}
              disabled={!props.canEditEngines}
              onChange={(e) => setEngineBrand(e.target.value)}
              onBlur={() => void saveAttr('engine_brand', engineBrand)}
              placeholder="Нет справочника марок — введите вручную"
            />
          )}

          {props.canViewMasterData && (
            <>
          <div style={{ color: '#6b7280' }}>Заказчик</div>
          <SearchSelectWithCreate
            value={customerId || null}
            options={linkLists.customer_id ?? []}
            disabled={!props.canEditEngines}
            canCreate={props.canEditMasterData}
            createLabel="Новый заказчик"
            onChange={(next) => {
              const v = next ?? '';
              setCustomerId(v);
              void saveAttr('customer_id', next ?? null);
            }}
            onCreate={async (label) => createMasterDataItem('customer', label)}
          />
            </>
          )}

          {props.canViewMasterData && (
            <>
          <div style={{ color: '#6b7280' }}>Контракт</div>
          <SearchSelectWithCreate
            value={contractId || null}
            options={linkLists.contract_id ?? []}
            disabled={!props.canEditEngines}
            canCreate={props.canEditMasterData}
            createLabel="Номер контракта"
            onChange={(next) => {
              const v = next ?? '';
              setContractId(v);
              void saveAttr('contract_id', next ?? null);
            }}
            onCreate={async (label) => createMasterDataItem('contract', label)}
          />
            </>
          )}

          {props.canViewMasterData && (
            <>
          <div style={{ color: '#6b7280' }}>Наряд</div>
          <SearchSelectWithCreate
            value={workOrderId || null}
            options={linkLists.work_order_id ?? []}
            disabled={!props.canEditEngines}
            canCreate={props.canEditMasterData}
            createLabel="Номер наряда"
            onChange={(next) => {
              const v = next ?? '';
              setWorkOrderId(v);
              void saveAttr('work_order_id', next ?? null);
            }}
            onCreate={async (label) => createMasterDataItem('work_order', label)}
          />
            </>
          )}

          {props.canViewMasterData && (
            <>
          <div style={{ color: '#6b7280' }}>Цех</div>
          <SearchSelectWithCreate
            value={workshopId || null}
            options={linkLists.workshop_id ?? []}
            disabled={!props.canEditEngines}
            canCreate={props.canEditMasterData}
            createLabel="Новый цех"
            onChange={(next) => {
              const v = next ?? '';
              setWorkshopId(v);
              void saveAttr('workshop_id', next ?? null);
            }}
            onCreate={async (label) => createMasterDataItem('workshop', label)}
          />
            </>
          )}

          {props.canViewMasterData && (
            <>
          <div style={{ color: '#6b7280' }}>Участок</div>
          <SearchSelectWithCreate
            value={sectionId || null}
            options={linkLists.section_id ?? []}
            disabled={!props.canEditEngines}
            canCreate={props.canEditMasterData}
            createLabel="Новый участок"
            onChange={(next) => {
              const v = next ?? '';
              setSectionId(v);
              void saveAttr('section_id', next ?? null);
            }}
            onCreate={async (label) => createMasterDataItem('section', label)}
          />
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <Button
            variant="ghost"
            onClick={() => {
              setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
              setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
              setEngineBrandId(String(props.engine.attributes?.engine_brand_id ?? ''));
              setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
              setContractId(String(props.engine.attributes?.contract_id ?? ''));
              setWorkOrderId(String(props.engine.attributes?.work_order_id ?? ''));
              setWorkshopId(String(props.engine.attributes?.workshop_id ?? ''));
              setSectionId(String(props.engine.attributes?.section_id ?? ''));
            }}
          >
            Отменить
          </Button>
          <div style={{ flex: 1 }} />
          {props.canEditEngines && (
            <div style={{ color: '#64748b', fontSize: 12 }}>
              Автосохранение: номер — при выходе из поля, марка/связи — сразу при выборе.
            </div>
          )}
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

      {props.canViewOperations && (
        <RepairChecklistPanel
          engineId={props.engineId}
          stage="defect"
          canEdit={props.canEditOperations}
          canPrint={props.canPrintEngineCard}
          canExport={props.canExportReports === true}
          engineNumber={engineNumber}
          engineBrand={engineBrand}
          engineBrandId={engineBrandId || undefined}
          canViewFiles={props.canViewFiles}
          canUploadFiles={props.canUploadFiles}
        />
      )}

      {props.canViewOperations && (
        <RepairChecklistPanel
          engineId={props.engineId}
          stage="repair"
          canEdit={props.canEditOperations}
          canPrint={props.canPrintEngineCard}
          canExport={props.canExportReports === true}
          engineNumber={engineNumber}
          engineBrand={engineBrand}
          engineBrandId={engineBrandId || undefined}
          defaultCollapsed
          canViewFiles={props.canViewFiles}
          canUploadFiles={props.canUploadFiles}
        />
      )}

      <AttachmentsPanel
        title="Вложения к двигателю"
        value={props.engine.attributes?.attachments}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEditEngines}
        onChange={saveAttachments}
      />
    </div>
  );
}


