import React, { useEffect, useRef, useState } from 'react';

import type { EngineDetails } from '@matricarmz/shared';

import { Button } from '../components/Button.js';
import { Input } from '../components/Input.js';
import { RepairChecklistPanel } from '../components/RepairChecklistPanel.js';
import { AttachmentsPanel } from '../components/AttachmentsPanel.js';
import { SearchSelectWithCreate } from '../components/SearchSelectWithCreate.js';
import { DraggableFieldList } from '../components/DraggableFieldList.js';
import { escapeHtml, openPrintPreview } from '../utils/printPreview.js';
import { ensureAttributeDefs, orderFieldsByDefs, persistFieldOrder, type AttributeDefRow } from '../utils/fieldOrder.js';

type LinkOpt = { id: string; label: string };

function normalizeForMatch(s: string) {
  return String(s ?? '').trim().toLowerCase();
}

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`)
    .join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list)
    ? list.filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string')
    : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items.map((f) => `<li>${escapeHtml(String((f as any).name))}</li>`).join('')}</ul>`;
}

function printEngineReport(
  engine: EngineDetails,
  context?: {
    engineNumber?: string;
    engineBrand?: string;
    customer?: string;
    contract?: string;
  },
  orderedRows?: Array<[string, string]>,
) {
  const attrs = engine.attributes ?? {};
  const mainRows: Array<[string, string]> =
    orderedRows && orderedRows.length > 0
      ? orderedRows
      : [
          ['Номер двигателя', String(context?.engineNumber ?? attrs.engine_number ?? '')],
          ['Марка двигателя', String(context?.engineBrand ?? attrs.engine_brand ?? '')],
          ['Контрагент', String(context?.customer ?? attrs.customer_id ?? '')],
          ['Контракт', String(context?.contract ?? attrs.contract_id ?? '')],
        ];

  openPrintPreview({
    title: `Карточка двигателя`,
    subtitle: (context?.engineNumber ?? attrs.engine_number) ? `Номер: ${String(context?.engineNumber ?? attrs.engine_number)}` : undefined,
    sections: [
      { id: 'main', title: 'Основное', html: keyValueTable(mainRows) },
      { id: 'files', title: 'Файлы', html: fileListHtml(attrs.attachments) },
    ],
  });
}

export function EngineDetailsPage(props: {
  engineId: string;
  engine: EngineDetails;
  onReload: () => Promise<void>;
  onEngineUpdated: () => Promise<void>;
  canEditEngines: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canPrintEngineCard: boolean;
  canViewMasterData: boolean;
  canEditMasterData: boolean;
  canExportReports?: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
  onClose: () => void;
}) {
  const [engineNumber, setEngineNumber] = useState(String(props.engine.attributes?.engine_number ?? ''));
  const [engineBrand, setEngineBrand] = useState(String(props.engine.attributes?.engine_brand ?? ''));
  const [engineBrandId, setEngineBrandId] = useState(String(props.engine.attributes?.engine_brand_id ?? ''));

  const [customerId, setCustomerId] = useState(String(props.engine.attributes?.customer_id ?? ''));
  const [contractId, setContractId] = useState(String(props.engine.attributes?.contract_id ?? ''));

  const [linkLists, setLinkLists] = useState<Record<string, LinkOpt[]>>({});
  const typeIdByCode = useRef<Record<string, string>>({});
  const [engineTypeId, setEngineTypeId] = useState<string>('');
  const [engineDefs, setEngineDefs] = useState<AttributeDefRow[]>([]);
  const [coreDefsReady, setCoreDefsReady] = useState(false);

  const [saveStatus, setSaveStatus] = useState<string>('');
  const engineBrandOptions =
    (linkLists.engine_brand ?? []).length > 0
      ? (linkLists.engine_brand ?? [])
      : engineBrandId && engineBrand
        ? [{ id: engineBrandId, label: engineBrand }]
        : [];
  const sessionHadChanges = useRef<boolean>(false);
  const initialSnapshot = useRef<{
    engineNumber: string;
    engineBrand: string;
  } | null>(null);

  // Синхронизируем локальные поля с тем, что реально лежит в БД (важно при reload/после sync).
  useEffect(() => {
    setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
    setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
    setEngineBrandId(String(props.engine.attributes?.engine_brand_id ?? ''));
    setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
    setContractId(String(props.engine.attributes?.contract_id ?? ''));
  }, [props.engineId, props.engine.updatedAt]);

  useEffect(() => {
    if (!engineBrandId || engineBrand) return;
    const label = (linkLists.engine_brand ?? []).find((o) => o.id === engineBrandId)?.label ?? '';
    if (!label) return;
    setEngineBrand(label);
    void saveAttr('engine_brand', label);
  }, [engineBrandId, engineBrand, linkLists.engine_brand]);

  useEffect(() => {
    if (engineBrandId || !engineBrand.trim()) return;
    const match = (linkLists.engine_brand ?? []).find(
      (o) => normalizeForMatch(o.label) === normalizeForMatch(engineBrand),
    );
    if (!match) return;
    setEngineBrandId(match.id);
    void saveAttr('engine_brand_id', match.id);
  }, [engineBrandId, engineBrand, linkLists.engine_brand]);

  useEffect(() => {
    // Reset “editing session” baseline on engine switch.
    initialSnapshot.current = {
      engineNumber: String(props.engine.attributes?.engine_number ?? ''),
      engineBrand: String(props.engine.attributes?.engine_brand ?? ''),
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

  async function saveAllAndClose() {
    if (props.canEditEngines) {
      const labelById = (id: string) => (linkLists.engine_brand ?? []).find((o) => o.id === id)?.label ?? '';
      const brandLabel = engineBrandId ? labelById(engineBrandId) || engineBrand : engineBrand;
      await saveAttr('engine_number', engineNumber);
      await saveAttr('engine_brand_id', engineBrandId || null);
      await saveAttr('engine_brand', brandLabel || null);
      await saveAttr('customer_id', customerId || null);
      await saveAttr('contract_id', contractId || null);
    }
    props.onClose();
  }

  async function handleDelete() {
    if (!props.canEditEngines) return;
    if (!confirm('Удалить двигатель?')) return;
    try {
      setSaveStatus('Удаление…');
      const r = await window.matrica.engines.delete(props.engineId);
      if (!r.ok) {
        setSaveStatus(`Ошибка удаления: ${r.error ?? 'unknown'}`);
        return;
      }
      setSaveStatus('Удалено');
      setTimeout(() => setSaveStatus(''), 900);
      props.onClose();
    } catch (e) {
      setSaveStatus(`Ошибка удаления: ${String(e)}`);
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
      if (!fieldsChanged.length) return;
      await window.matrica.audit.add({
        action: 'ui.engine.edit_done',
        entityId: props.engineId,
        tableName: 'entities',
        payload: {
          engineId: props.engineId,
          engineNumber: String(engineNumber || '').trim() || null,
          engineBrand: String(engineBrand || '').trim() || null,
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
    const engineType = types.find((t) => String(t.code) === 'engine');
    if (engineType?.id) {
      setEngineTypeId(String(engineType.id));
      const defs = await window.matrica.admin.attributeDefs.listByEntityType(String(engineType.id));
      setEngineDefs(defs as AttributeDefRow[]);
      setCoreDefsReady(false);
    }
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
  }

  useEffect(() => {
    if (!props.canViewMasterData) return;
    void loadLinkLists();
  }, [props.canViewMasterData]);

  useEffect(() => {
    if (!props.canEditMasterData || !engineTypeId || engineDefs.length === 0 || coreDefsReady) return;
    const desired = [
      { code: 'engine_number', name: 'Номер двигателя', dataType: 'text', sortOrder: 10 },
      {
        code: 'engine_brand_id',
        name: 'Марка двигателя',
        dataType: 'link',
        sortOrder: 20,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'engine_brand' }),
      },
      {
        code: 'customer_id',
        name: 'Контрагент',
        dataType: 'link',
        sortOrder: 30,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'customer' }),
      },
      {
        code: 'contract_id',
        name: 'Контракт',
        dataType: 'link',
        sortOrder: 40,
        metaJson: JSON.stringify({ linkTargetTypeCode: 'contract' }),
      },
    ];
    void ensureAttributeDefs(engineTypeId, desired, engineDefs).then((next) => {
      if (next.length !== engineDefs.length) setEngineDefs(next);
      setCoreDefsReady(true);
    });
  }, [props.canEditMasterData, engineTypeId, engineDefs.length, coreDefsReady]);

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
    };
    const attr = attrByType[typeCode] ?? 'name';
    await window.matrica.admin.entities.setAttr(created.id, attr, label);
    await loadLinkLists();
    return created.id;
  }

  const mainFieldItems = [
    {
      code: 'engine_number',
      defaultOrder: 10,
      label: 'Номер двигателя',
      value: engineNumber,
      render: (
        <Input
          value={engineNumber}
          disabled={!props.canEditEngines}
          onChange={(e) => setEngineNumber(e.target.value)}
          onBlur={() => void saveEngineNumber()}
        />
      ),
    },
    {
      code: 'engine_brand_id',
      defaultOrder: 20,
      label: 'Марка двигателя',
      value: engineBrand,
      render: (
        <div style={{ display: 'grid', gap: 6 }}>
          <SearchSelectWithCreate
            value={engineBrandId || null}
            options={engineBrandOptions}
            disabled={!props.canEditEngines}
            canCreate={props.canEditMasterData}
            createLabel="Новая марка двигателя"
            onChange={(next) => {
              const nextId = next ?? '';
              const label = next ? engineBrandOptions.find((o) => o.id === next)?.label ?? '' : '';
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
          {(linkLists.engine_brand ?? []).length === 0 && (
            <span style={{ color: '#6b7280', fontSize: 12 }}>Справочник марок пуст — выберите или создайте значение.</span>
          )}
        </div>
      ),
    },
    props.canViewMasterData
      ? {
          code: 'customer_id',
          defaultOrder: 30,
          label: 'Контрагент',
          value: (linkLists.customer_id ?? []).find((o) => o.id === customerId)?.label ?? customerId,
          render: (
            <SearchSelectWithCreate
              value={customerId || null}
              options={linkLists.customer_id ?? []}
              disabled={!props.canEditEngines}
              canCreate={props.canEditMasterData}
              createLabel="Новый контрагент"
              onChange={(next) => {
                const v = next ?? '';
                setCustomerId(v);
                void saveAttr('customer_id', next ?? null);
              }}
              onCreate={async (label) => createMasterDataItem('customer', label)}
            />
          ),
        }
      : null,
    props.canViewMasterData
      ? {
          code: 'contract_id',
          defaultOrder: 40,
          label: 'Контракт',
          value: (linkLists.contract_id ?? []).find((o) => o.id === contractId)?.label ?? contractId,
          render: (
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
          ),
        }
      : null,
  ].filter(Boolean);
  const mainFields = orderFieldsByDefs(mainFieldItems as any[], engineDefs);

  const orderedPrintRows = mainFields.map((f) => [f.label, String(f.value ?? '')] as [string, string]);
  const headerTitle = engineNumber.trim() ? `Двигатель: ${engineNumber.trim()}` : 'Карточка двигателя';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <div style={{ flex: 1 }} />
        {props.canEditEngines && (
          <Button variant="ghost" onClick={() => void saveAllAndClose()}>
            Сохранить
          </Button>
        )}
        {props.canEditEngines && (
          <Button variant="ghost" onClick={() => void handleDelete()} style={{ color: '#b91c1c' }}>
            Удалить
          </Button>
        )}
        {props.canPrintEngineCard && (
          <Button
            variant="ghost"
            onClick={() => {
              const pickLabel = (key: string, id: string) => (linkLists[key] ?? []).find((o) => o.id === id)?.label ?? id;
              printEngineReport(
                props.engine,
                {
                  engineNumber,
                  engineBrand,
                  customer: pickLabel('customer_id', customerId),
                  contract: pickLabel('contract_id', contractId),
                },
                orderedPrintRows,
              );
            }}
          >
            Распечатать
          </Button>
        )}
        {saveStatus && <div style={{ color: saveStatus.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{saveStatus}</div>}
        <Button variant="ghost" onClick={props.onReload}>
          Обновить
        </Button>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>
        <div style={{ border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <DraggableFieldList
          items={mainFields}
          getKey={(f) => f.code}
          canDrag={props.canEditMasterData}
          onReorder={(next) => {
            if (!engineTypeId) return;
            void persistFieldOrder(
              next.map((f) => f.code),
              engineDefs,
              { entityTypeId: engineTypeId },
            ).then(() => setEngineDefs([...engineDefs]));
          }}
          renderItem={(field, itemProps, _dragHandleProps, state) => (
            <div
              {...itemProps}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(140px, 180px) 1fr',
                gap: 10,
                alignItems: 'center',
                padding: '6px 8px',
                borderRadius: 8,
                border: state.isOver ? '1px dashed #93c5fd' : '1px solid transparent',
                background: state.isDragging ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
              }}
            >
              <div style={{ color: '#6b7280' }}>{field.label}</div>
              {field.render}
            </div>
          )}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
          <Button
            variant="ghost"
            onClick={() => {
              setEngineNumber(String(props.engine.attributes?.engine_number ?? ''));
              setEngineBrand(String(props.engine.attributes?.engine_brand ?? ''));
              setEngineBrandId(String(props.engine.attributes?.engine_brand_id ?? ''));
              setCustomerId(String(props.engine.attributes?.customer_id ?? ''));
              setContractId(String(props.engine.attributes?.contract_id ?? ''));
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
        <RepairChecklistPanel
          engineId={props.engineId}
          stage="defect"
          canEdit={props.canEditOperations}
          canEditMasterData={props.canEditMasterData}
          canPrint={props.canPrintEngineCard}
          canExport={props.canExportReports === true}
          engineNumber={engineNumber}
          engineBrand={engineBrand}
          engineBrandId={engineBrandId || undefined}
          canViewFiles={props.canViewFiles}
          canUploadFiles={props.canUploadFiles}
          defaultCollapsed
        />
      )}

      {props.canViewOperations && (
        <RepairChecklistPanel
          engineId={props.engineId}
          stage="completeness"
          canEdit={props.canEditOperations}
          canEditMasterData={props.canEditMasterData}
          canPrint={props.canPrintEngineCard}
          canExport={props.canExportReports === true}
          engineNumber={engineNumber}
          engineBrand={engineBrand}
          engineBrandId={engineBrandId || undefined}
          canViewFiles={props.canViewFiles}
          canUploadFiles={props.canUploadFiles}
          defaultCollapsed
        />
      )}

      {props.canViewOperations && (
        <RepairChecklistPanel
          engineId={props.engineId}
          stage="repair"
          canEdit={props.canEditOperations}
          canEditMasterData={props.canEditMasterData}
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
    </div>
  );
}


