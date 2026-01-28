import React, { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from './components/Button.js';
import { Input } from './components/Input.js';
import { SearchSelect } from './components/SearchSelect.js';
import { AttachmentsPanel } from './components/AttachmentsPanel.js';
import { RepairChecklistPanel } from './components/RepairChecklistPanel.js';
import { createEntity, getEntity, listAttributeDefs, listEntities, listEntityTypes, setEntityAttr, upsertAttributeDef, upsertEntityType } from '../api/masterdata.js';

type LinkOpt = { id: string; label: string };

const REQUIRED_DEFS = [
  { code: 'engine_number', name: 'Номер двигателя', dataType: 'text' },
  { code: 'engine_brand', name: 'Марка двигателя', dataType: 'text' },
  { code: 'engine_brand_id', name: 'Марка двигателя (ссылка)', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'engine_brand' }) },
  { code: 'customer_id', name: 'Заказчик', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'customer' }) },
  { code: 'contract_id', name: 'Контракт', dataType: 'link', metaJson: JSON.stringify({ linkTargetTypeCode: 'contract' }) },
  { code: 'attachments', name: 'Вложения', dataType: 'json' },
];

function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function keyValueTable(rows: Array<[string, string]>) {
  const body = rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value || '—')}</td></tr>`).join('\n');
  return `<table><tbody>${body}</tbody></table>`;
}

function fileListHtml(list: unknown) {
  const items = Array.isArray(list) ? list.filter((x) => x && typeof x === 'object' && typeof (x as any).name === 'string') : [];
  if (items.length === 0) return '<div class="muted">Нет файлов</div>';
  return `<ul>${items.map((f) => `<li>${escapeHtml(String((f as any).name))}</li>`).join('')}</ul>`;
}

function openPrintPreview(args: { title: string; subtitle?: string; sections: { id: string; title: string; html: string }[] }) {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(args.title)}</title>
  <style>
    body { font-family: "Times New Roman", "Liberation Serif", serif; margin: 24px; color: #111827; }
    h1 { margin: 0 0 8px 0; font-size: 18px; }
    h2 { margin: 18px 0 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.3px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #111827; padding: 6px 8px; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f3f4f6; width: 35%; }
    .muted { color: #6b7280; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:12px;">
    <button onclick="window.print()">Печать</button>
  </div>
  <h1>${escapeHtml(args.title)}</h1>
  ${args.subtitle ? `<div class="muted" style="margin-bottom:10px;">${escapeHtml(args.subtitle)}</div>` : ''}
  ${args.sections
    .map((s) => `<h2>${escapeHtml(s.title)}</h2><div>${s.html}</div>`)
    .join('')}
</body>
</html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
}

export function EngineDetailsPage(props: {
  engineId: string;
  onClose: () => void;
  onUpdated: () => Promise<void>;
  canEditEngines: boolean;
  canEditMasterData: boolean;
  canViewOperations: boolean;
  canEditOperations: boolean;
  canExportReports?: boolean;
  canViewFiles: boolean;
  canUploadFiles: boolean;
}) {
  const [engineNumber, setEngineNumber] = useState('');
  const [engineBrand, setEngineBrand] = useState('');
  const [engineBrandId, setEngineBrandId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [contractId, setContractId] = useState('');
  const [attachments, setAttachments] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [linkLists, setLinkLists] = useState<Record<string, LinkOpt[]>>({});
  const typeIdByCode = useRef<Record<string, string>>({});

  const engineBrandOptions =
    (linkLists.engine_brand ?? []).length > 0
      ? (linkLists.engine_brand ?? [])
      : engineBrandId && engineBrand
        ? [{ id: engineBrandId, label: engineBrand }]
        : [];

  async function ensureEngineSchema() {
    const typesRes = await listEntityTypes();
    if (!typesRes?.ok) throw new Error(typesRes?.error ?? 'types load failed');
    const types = typesRes.rows ?? [];
    let engineType = types.find((t: any) => String(t.code) === 'engine') ?? null;
    if (!engineType && props.canEditMasterData) {
      const created = await upsertEntityType({ code: 'engine', name: 'Двигатели' });
      if (!created?.ok) throw new Error(created?.error ?? 'failed to create engine type');
      const reload = await listEntityTypes();
      engineType = reload?.rows?.find((t: any) => String(t.code) === 'engine') ?? null;
    }
    if (!engineType?.id) return;
    const typeId = String(engineType.id);
    const defsRes = await listAttributeDefs(typeId);
    if (!defsRes?.ok) return;
    const defs = defsRes.rows ?? [];
    const byCode = new Set(defs.map((d: any) => String(d.code)));
    if (props.canEditMasterData) {
      for (const def of REQUIRED_DEFS) {
        if (byCode.has(def.code)) continue;
        await upsertAttributeDef({
          entityTypeId: typeId,
          code: def.code,
          name: def.name,
          dataType: def.dataType,
          sortOrder: 100,
          ...(def.metaJson ? { metaJson: def.metaJson } : {}),
        });
      }
    }
  }

  async function loadLinkLists() {
    const types = await listEntityTypes();
    if (!types?.ok) return;
    typeIdByCode.current = Object.fromEntries((types.rows ?? []).map((t: any) => [String(t.code), String(t.id)]));
    async function load(code: string, key: string) {
      const tid = typeIdByCode.current[code];
      if (!tid) return;
      const rows = await listEntities(tid);
      if (!rows?.ok) return;
      const opts = (rows.rows ?? []).map((x: any) => ({ id: String(x.id), label: x.displayName ? `${x.displayName}` : String(x.id) }));
      opts.sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      setLinkLists((p) => ({ ...p, [key]: opts }));
    }
    await load('engine_brand', 'engine_brand');
    await load('customer', 'customer_id');
    await load('contract', 'contract_id');
  }

  async function loadEngine() {
    try {
      setStatus('Загрузка…');
      await ensureEngineSchema();
      const r = await getEntity(props.engineId);
      if (!r?.ok) throw new Error(r?.error ?? 'engine load failed');
      const attrs = r.entity?.attributes ?? {};
      setEngineNumber(String(attrs.engine_number ?? ''));
      setEngineBrand(String(attrs.engine_brand ?? ''));
      setEngineBrandId(String(attrs.engine_brand_id ?? ''));
      setCustomerId(String(attrs.customer_id ?? ''));
      setContractId(String(attrs.contract_id ?? ''));
      setAttachments(attrs.attachments ?? null);
      setStatus('');
    } catch (e) {
      setStatus(`Ошибка: ${String(e)}`);
    }
  }

  useEffect(() => {
    void loadEngine();
    void loadLinkLists();
  }, [props.engineId]);

  async function saveAttr(code: string, value: unknown) {
    if (!props.canEditEngines) return;
    try {
      setStatus('Сохраняю...');
      const r = await setEntityAttr(props.engineId, code, value);
      if (!r.ok) throw new Error(r.error ?? 'save failed');
      await props.onUpdated();
      setStatus('Сохранено');
      setTimeout(() => setStatus(''), 700);
    } catch (e) {
      setStatus(`Ошибка сохранения: ${String(e)}`);
    }
  }

  async function createMasterDataItem(typeCode: string, label: string): Promise<string | null> {
    if (!props.canEditMasterData) return null;
    const typeId = typeIdByCode.current[typeCode];
    if (!typeId) {
      setStatus(`Справочник не найден: ${typeCode}`);
      return null;
    }
    const created = await createEntity(typeId);
    if (!created.ok || !created.id) {
      setStatus(`Ошибка создания: ${typeCode}`);
      return null;
    }
    const attrByType: Record<string, string> = {
      engine_brand: 'name',
      customer: 'name',
      contract: 'number',
    };
    const attr = attrByType[typeCode] ?? 'name';
    await setEntityAttr(created.id, attr, label);
    await loadLinkLists();
    return created.id;
  }

  const headerTitle = engineNumber.trim() ? `Двигатель: ${engineNumber.trim()}` : 'Карточка двигателя';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid #e5e7eb' }}>
        <Button variant="ghost" onClick={props.onClose}>
          Назад к списку
        </Button>
        <div style={{ fontSize: 20, fontWeight: 800 }}>{headerTitle}</div>
        <Button
          variant="ghost"
          onClick={() => {
            openPrintPreview({
              title: 'Карточка двигателя',
              subtitle: engineNumber ? `Номер: ${engineNumber}` : undefined,
              sections: [
                {
                  id: 'main',
                  title: 'Основное',
                  html: keyValueTable([
                    ['Номер двигателя', String(engineNumber ?? '')],
                    ['Марка двигателя', String(engineBrand ?? '')],
                    ['Заказчик', (linkLists.customer_id ?? []).find((o) => o.id === customerId)?.label ?? customerId ?? ''],
                    ['Контракт', (linkLists.contract_id ?? []).find((o) => o.id === contractId)?.label ?? contractId ?? ''],
                  ]),
                },
                { id: 'files', title: 'Файлы', html: fileListHtml(attachments) },
              ],
            });
          }}
        >
          Распечатать
        </Button>
        <div style={{ flex: 1 }} />
        {status && <div style={{ color: status.startsWith('Ошибка') ? '#b91c1c' : '#64748b', fontSize: 12 }}>{status}</div>}
        <Button variant="ghost" onClick={loadEngine}>
          Обновить
        </Button>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', paddingTop: 12 }}>

      <div style={{ marginTop: 12, border: '1px solid #e5e7eb', borderRadius: 12, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 180px) 1fr', gap: 10 }}>
          <div style={{ color: '#6b7280' }}>Номер двигателя</div>
          <Input value={engineNumber} disabled={!props.canEditEngines} onChange={(e) => setEngineNumber(e.target.value)} onBlur={() => void saveAttr('engine_number', engineNumber)} />

          <div style={{ color: '#6b7280' }}>Марка двигателя</div>
          <div style={{ display: 'grid', gap: 6 }}>
            <SearchSelect
              value={engineBrandId || null}
              options={engineBrandOptions}
              disabled={!props.canEditEngines}
              createLabel="Новая марка двигателя"
              onChange={(next) => {
                const nextId = next ?? '';
                const label = next ? engineBrandOptions.find((o) => o.id === next)?.label ?? '' : '';
                setEngineBrandId(nextId);
                setEngineBrand(label);
                void saveAttr('engine_brand_id', next || null);
                void saveAttr('engine_brand', label || null);
              }}
              onCreate={
                props.canEditMasterData
                  ? async (label) => {
                      const id = await createMasterDataItem('engine_brand', label);
                      if (!id) return null;
                      setEngineBrandId(id);
                      setEngineBrand(label);
                      void saveAttr('engine_brand_id', id);
                      void saveAttr('engine_brand', label);
                      return id;
                    }
                  : undefined
              }
            />
            {(linkLists.engine_brand ?? []).length === 0 && <span style={{ color: '#6b7280', fontSize: 12 }}>Справочник марок пуст — выберите или создайте значение.</span>}
          </div>

          <div style={{ color: '#6b7280' }}>Заказчик</div>
          <SearchSelect
            value={customerId || null}
            options={linkLists.customer_id ?? []}
            disabled={!props.canEditEngines}
            createLabel="Новый заказчик"
            onChange={(next) => {
              const v = next ?? '';
              setCustomerId(v);
              void saveAttr('customer_id', next ?? null);
            }}
            onCreate={props.canEditMasterData ? async (label) => createMasterDataItem('customer', label) : undefined}
          />

          <div style={{ color: '#6b7280' }}>Контракт</div>
          <SearchSelect
            value={contractId || null}
            options={linkLists.contract_id ?? []}
            disabled={!props.canEditEngines}
            createLabel="Номер контракта"
            onChange={(next) => {
              const v = next ?? '';
              setContractId(v);
              void saveAttr('contract_id', next ?? null);
            }}
            onCreate={props.canEditMasterData ? async (label) => createMasterDataItem('contract', label) : undefined}
          />
        </div>
      </div>

      <AttachmentsPanel
        title="Вложения к двигателю"
        value={attachments}
        canView={props.canViewFiles}
        canUpload={props.canUploadFiles && props.canEditEngines}
        scope={{ ownerType: 'engine', ownerId: props.engineId, category: 'engine' }}
        onChange={async (next) => {
          await saveAttr('attachments', next);
          setAttachments(next);
          return { ok: true as const };
        }}
      />

      {props.canViewOperations && (
        <RepairChecklistPanel
          engineId={props.engineId}
          stage="defect"
          canEdit={props.canEditOperations}
          canPrint={props.canViewOperations}
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
          stage="completeness"
          canEdit={props.canEditOperations}
          canPrint={props.canViewOperations}
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
          canPrint={props.canViewOperations}
          canExport={props.canExportReports === true}
          engineNumber={engineNumber}
          engineBrand={engineBrand}
          engineBrandId={engineBrandId || undefined}
          defaultCollapsed
          canViewFiles={props.canViewFiles}
          canUploadFiles={props.canUploadFiles}
        />
      )}
      </div>
    </div>
  );
}
