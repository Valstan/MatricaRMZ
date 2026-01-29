import { and, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { BrowserWindow } from 'electron';

import { attributeDefs, attributeValues, entities, operations } from '../database/schema.js';

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };

type DefectSupplyReportRow = {
  contractId: string;
  contractLabel: string;
  partName: string;
  partNumber: string;
  scrapQty: number;
  missingQty: number;
};

type DefectSupplyReportResult = {
  rows: DefectSupplyReportRow[];
  totals: { scrapQty: number; missingQty: number };
  totalsByContract: Array<{ contractLabel: string; scrapQty: number; missingQty: number }>;
};

function csvEscape(s: string) {
  const needs = /[,"\n\r;]/.test(s);
  const v = s.replace(/"/g, '""');
  return needs ? `"${v}"` : v;
}

function htmlEscape(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function safeJsonParse(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function normalizeText(value: unknown, fallback = ''): string {
  const s = typeof value === 'string' ? value : value == null ? '' : String(value);
  const t = s.trim();
  return t ? t : fallback;
}

async function renderHtmlWindow(html: string) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      offscreen: true,
    },
  });
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  await win.loadURL(url);
  return win;
}

function buildDefectSupplyHtml(data: DefectSupplyReportResult & { startMs?: number; endMs: number; contractLabels: string[] }) {
  const title = 'Статистика по дефектовке и комплектности';
  const startLabel = data.startMs ? new Date(data.startMs).toLocaleDateString('ru-RU') : '—';
  const periodLabel = `${startLabel} — ${new Date(data.endMs).toLocaleDateString('ru-RU')}`;
  const contractsLabel = data.contractLabels.length ? data.contractLabels.join(', ') : 'Все контракты';
  const contractSummary = data.totalsByContract
    .map(
      (t) =>
        `<li>${htmlEscape(t.contractLabel)}: утиль ${t.scrapQty}, недокомплект ${t.missingQty}</li>`,
    )
    .join('');
  const totalsByContract = new Map(data.totalsByContract.map((t) => [t.contractLabel, t]));
  const rowsHtml = (() => {
    let out = '';
    let currentContract = '';
    for (const r of data.rows) {
      if (currentContract && currentContract !== r.contractLabel) {
        const subtotal = totalsByContract.get(currentContract);
        if (subtotal) {
          out += `<tr style="background:#f8fafc;font-weight:700">
            <td colspan="3">Итого по контракту: ${htmlEscape(currentContract)}</td>
            <td style="text-align:right">${subtotal.scrapQty}</td>
            <td style="text-align:right">${subtotal.missingQty}</td>
          </tr>`;
        }
      }
      currentContract = r.contractLabel;
      out += `
      <tr>
        <td>${htmlEscape(r.contractLabel)}</td>
        <td>${htmlEscape(r.partName)}</td>
        <td>${htmlEscape(r.partNumber)}</td>
        <td style="text-align:right">${r.scrapQty}</td>
        <td style="text-align:right">${r.missingQty}</td>
      </tr>`;
    }
    if (currentContract) {
      const subtotal = totalsByContract.get(currentContract);
      if (subtotal) {
        out += `<tr style="background:#f8fafc;font-weight:700">
          <td colspan="3">Итого по контракту: ${htmlEscape(currentContract)}</td>
          <td style="text-align:right">${subtotal.scrapQty}</td>
          <td style="text-align:right">${subtotal.missingQty}</td>
        </tr>`;
      }
    }
    return out;
  })();
  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;padding:16px;color:#0b1220}
  h1{font-size:16px;margin:0 0 8px 0}
  .meta{color:#475569;margin-bottom:12px}
  table{border-collapse:collapse;width:100%}
  th,td{border:1px solid #e5e7eb;padding:6px;text-align:left}
  th{background:#f1f5f9}
  .totals{margin-top:10px;font-weight:700}
  .contract-summary{margin:10px 0 14px 0}
  .contract-summary ul{margin:6px 0 0 18px}
</style>
</head><body>
  <h1>${title}</h1>
  <div class="meta">Период: ${periodLabel}</div>
  <div class="meta">Контракты: ${contractsLabel}</div>
  <div class="contract-summary">
    <div><b>Итого по контрактам:</b></div>
    <ul>${contractSummary || '<li>Нет данных</li>'}</ul>
  </div>
  <table>
    <thead>
      <tr>
        <th>Контракт</th>
        <th>Деталь</th>
        <th>№ детали</th>
        <th>Утиль</th>
        <th>Недокомплект</th>
      </tr>
    </thead>
    <tbody>${rowsHtml || '<tr><td colspan="5">Нет данных</td></tr>'}</tbody>
  </table>
  <div class="totals">Итого: утиль ${data.totals.scrapQty}, недокомплект ${data.totals.missingQty}</div>
</body></html>`;
}

export async function buildDefectSupplyReport(
  db: BetterSQLite3Database,
  args: { startMs?: number; endMs: number; contractIds?: string[] },
): Promise<Ok<DefectSupplyReportResult> | Err> {
  try {
    const endMs = Number(args.endMs);
    if (!Number.isFinite(endMs) || endMs <= 0) return { ok: false, error: 'Некорректная дата endMs' };
    const startMs = args.startMs != null ? Number(args.startMs) : null;
    const contractFilter = Array.isArray(args.contractIds) ? args.contractIds.map(String).filter(Boolean) : [];

    const defs = await db.select().from(attributeDefs).where(isNull(attributeDefs.deletedAt)).limit(50_000);
    const defByCode = new Map<string, { id: string; code: string }>();
    for (const d of defs as any[]) defByCode.set(String(d.code), { id: String(d.id), code: String(d.code) });
    const contractDefId = defByCode.get('contract_id')?.id ?? '';

    const values = await db.select().from(attributeValues).where(isNull(attributeValues.deletedAt)).limit(200_000);
    const engineContractId = new Map<string, string>();
    const contractIds = new Set<string>();
    if (contractDefId) {
      for (const v of values as any[]) {
        if (String(v.attributeDefId) !== contractDefId) continue;
        const raw = safeJsonParse(String(v.valueJson ?? ''));
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const engineId = String(v.entityId);
        const contractId = raw.trim();
        engineContractId.set(engineId, contractId);
        contractIds.add(contractId);
      }
    }

    const labelCodes = ['number', 'name', 'contract_number'];
    const labelDefIds = labelCodes.map((c) => defByCode.get(c)?.id).filter(Boolean) as string[];
    const contractLabel = new Map<string, string>();
    if (labelDefIds.length && contractIds.size > 0) {
      for (const v of values as any[]) {
        if (!labelDefIds.includes(String(v.attributeDefId))) continue;
        const entId = String(v.entityId);
        if (!contractIds.has(entId)) continue;
        const raw = safeJsonParse(String(v.valueJson ?? ''));
        if (raw == null || raw === '') continue;
        if (!contractLabel.has(entId)) contractLabel.set(entId, String(raw));
      }
    }

    const opWhere = [isNull(operations.deletedAt), inArray(operations.operationType, ['defect', 'completeness'])];
    if (startMs != null && Number.isFinite(startMs)) {
      opWhere.push(gte(operations.createdAt, startMs));
    }
    opWhere.push(lte(operations.createdAt, endMs));

    const ops = await db.select().from(operations).where(and(...opWhere)).limit(200_000);
    const rowsMap = new Map<string, DefectSupplyReportRow>();
    let totalScrap = 0;
    let totalMissing = 0;

  const contractTotals = new Map<string, { scrapQty: number; missingQty: number }>();
  for (const op of ops as any[]) {
      const ts = Number(op.performedAt ?? op.createdAt ?? 0);
      if (startMs != null && Number.isFinite(startMs) && ts < startMs) continue;
      if (ts > endMs) continue;
      const engineId = String(op.engineEntityId ?? '');
      const contractId = engineContractId.get(engineId) ?? '';
      if (contractFilter.length > 0 && (!contractId || !contractFilter.includes(contractId))) continue;
      const contractLabelText = contractId ? contractLabel.get(contractId) ?? contractId : '(не указан)';
      const payload = safeJsonParse(String(op.metaJson ?? '')) as any;
      if (!payload || payload.kind !== 'repair_checklist' || !payload.answers) continue;
      const answers = payload.answers ?? {};
      if (op.operationType === 'defect') {
        const defect = answers.defect_items;
        const rows = defect?.kind === 'table' ? defect.rows : [];
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          const partName = normalizeText((r as any)?.part_name, '(не указано)');
          const partNumber = normalizeText((r as any)?.part_number, '');
          const scrapQty = Math.max(0, toNumber((r as any)?.scrap_qty));
          if (scrapQty <= 0) continue;
          const key = `${contractLabelText}||${partName}||${partNumber}`;
          const existing =
            rowsMap.get(key) ??
            ({
              contractId: contractId || '',
              contractLabel: contractLabelText,
              partName,
              partNumber,
              scrapQty: 0,
              missingQty: 0,
            } as DefectSupplyReportRow);
          existing.scrapQty += scrapQty;
          totalScrap += scrapQty;
          rowsMap.set(key, existing);
          const contractKey = contractLabelText;
          const ct = contractTotals.get(contractKey) ?? { scrapQty: 0, missingQty: 0 };
          ct.scrapQty += scrapQty;
          contractTotals.set(contractKey, ct);
        }
      }
      if (op.operationType === 'completeness') {
        const comp = answers.completeness_items;
        const rows = comp?.kind === 'table' ? comp.rows : [];
        if (!Array.isArray(rows)) continue;
        for (const r of rows) {
          const present = Boolean((r as any)?.present);
          if (present) continue;
          const partName = normalizeText((r as any)?.part_name, '(не указано)');
          const partNumber = normalizeText((r as any)?.assembly_unit_number, '');
          const key = `${contractLabelText}||${partName}||${partNumber}`;
          const existing =
            rowsMap.get(key) ??
            ({
              contractId: contractId || '',
              contractLabel: contractLabelText,
              partName,
              partNumber,
              scrapQty: 0,
              missingQty: 0,
            } as DefectSupplyReportRow);
          existing.missingQty += 1;
          totalMissing += 1;
          rowsMap.set(key, existing);
          const contractKey = contractLabelText;
          const ct = contractTotals.get(contractKey) ?? { scrapQty: 0, missingQty: 0 };
          ct.missingQty += 1;
          contractTotals.set(contractKey, ct);
        }
      }
    }

    const rows = Array.from(rowsMap.values()).sort((a, b) => {
      const c = a.contractLabel.localeCompare(b.contractLabel, 'ru');
      if (c !== 0) return c;
      const p = a.partName.localeCompare(b.partName, 'ru');
      if (p !== 0) return p;
      return a.partNumber.localeCompare(b.partNumber, 'ru');
    });

    const totalsByContract = Array.from(contractTotals.entries())
      .map(([contractLabel, totals]) => ({ contractLabel, ...totals }))
      .sort((a, b) => a.contractLabel.localeCompare(b.contractLabel, 'ru'));
    return { ok: true, rows, totals: { scrapQty: totalScrap, missingQty: totalMissing }, totalsByContract };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function exportDefectSupplyReportPdf(
  db: BetterSQLite3Database,
  args: { startMs?: number; endMs: number; contractIds?: string[]; contractLabels: string[] },
): Promise<Ok<{ contentBase64: string; fileName: string; mime: string }> | Err> {
  const base = await buildDefectSupplyReport(db, args);
  if (!base.ok) return base;
  const html = buildDefectSupplyHtml({ ...base, startMs: args.startMs, endMs: args.endMs, contractLabels: args.contractLabels });
  const win = await renderHtmlWindow(html);
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    return {
      ok: true,
      contentBase64: Buffer.from(pdf).toString('base64'),
      fileName: `defect_supply_${new Date().toISOString().slice(0, 10)}.pdf`,
      mime: 'application/pdf',
    };
  } finally {
    win.destroy();
  }
}

export async function printDefectSupplyReport(
  db: BetterSQLite3Database,
  args: { startMs?: number; endMs: number; contractIds?: string[]; contractLabels: string[] },
): Promise<Ok<{}> | Err> {
  const base = await buildDefectSupplyReport(db, args);
  if (!base.ok) return base;
  const html = buildDefectSupplyHtml({ ...base, startMs: args.startMs, endMs: args.endMs, contractLabels: args.contractLabels });
  const win = await renderHtmlWindow(html);
  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ printBackground: true }, (ok, errorType) => {
        if (!ok) return reject(new Error(errorType ?? 'print failed'));
        resolve();
      });
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    win.destroy();
  }
}
export async function buildPeriodStagesCsv(
  db: BetterSQLite3Database,
  args: { startMs?: number; endMs: number },
): Promise<Ok<{ csv: string }> | Err> {
  try {
    const endMs = args.endMs;
    if (!Number.isFinite(endMs) || endMs <= 0) return { ok: false, error: 'Некорректная дата endMs' };

    // Берём все операции по всем двигателям до endMs и выбираем “последнюю” по performedAt/createdAt.
    const rows = await db
      .select()
      .from(operations)
      .where(and(isNull(operations.deletedAt), lte(operations.createdAt, endMs)))
      .limit(200_000);

    const latestByEngine = new Map<string, { type: string; ts: number }>();
    for (const r of rows as any[]) {
      const engineId: string = r.engineEntityId;
      const ts: number = (r.performedAt ?? r.createdAt) as number;
      const prev = latestByEngine.get(engineId);
      if (!prev || ts > prev.ts) latestByEngine.set(engineId, { type: String(r.operationType), ts });
    }

    // Фильтр по startMs (если задан): считаем только те движки, у которых последняя стадия в окне.
    const startMs = args.startMs;
    const counts = new Map<string, number>();
    for (const v of latestByEngine.values()) {
      if (typeof startMs === 'number' && Number.isFinite(startMs) && v.ts < startMs) continue;
      counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
    }

    const header = ['stage', 'count'];
    const lines: string[] = [header.join(';')];
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [stage, count] of sorted) {
      lines.push([csvEscape(stage), String(count)].join(';'));
    }
    lines.push(['TOTAL', String([...counts.values()].reduce((a, b) => a + b, 0))].join(';'));

    return { ok: true, csv: lines.join('\n') + '\n' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function buildPeriodStagesCsvByLink(
  db: BetterSQLite3Database,
  args: { startMs?: number; endMs: number; linkAttrCode: string },
): Promise<Ok<{ csv: string }> | Err> {
  try {
    const endMs = args.endMs;
    if (!Number.isFinite(endMs) || endMs <= 0) return { ok: false, error: 'Некорректная дата endMs' };
    const linkAttrCode = String(args.linkAttrCode || '').trim();
    if (!linkAttrCode) return { ok: false, error: 'Некорректный linkAttrCode' };

    // 1) последняя операция по каждому engine
    const opsRows = await db
      .select()
      .from(operations)
      .where(and(isNull(operations.deletedAt), lte(operations.createdAt, endMs)))
      .limit(200_000);

    const latestByEngine = new Map<string, { type: string; ts: number }>();
    for (const r of opsRows as any[]) {
      const engineId: string = r.engineEntityId;
      const ts: number = (r.performedAt ?? r.createdAt) as number;
      const prev = latestByEngine.get(engineId);
      if (!prev || ts > prev.ts) latestByEngine.set(engineId, { type: String(r.operationType), ts });
    }

    const startMs = args.startMs;

    // 2) находим attribute_def_id для linkAttrCode для типа engine
    // (быстро и достаточно надёжно: берём def по code, затем применяем к attribute_values)
    const def = await db.select().from(attributeDefs).where(and(isNull(attributeDefs.deletedAt), lte(attributeDefs.createdAt, endMs))).limit(5000);
    const defRow = (def as any[]).find((d) => String(d.code) === linkAttrCode) as any | undefined;
    if (!defRow?.id) return { ok: false, error: `Не найден attribute_def: ${linkAttrCode}` };
    const defId = String(defRow.id);

    // 3) map engineId -> groupId (из attribute_values)
    const values = await db.select().from(attributeValues).where(and(isNull(attributeValues.deletedAt), lte(attributeValues.createdAt, endMs))).limit(200_000);
    const groupByEngine = new Map<string, string>();
    for (const v of values as any[]) {
      if (String(v.attributeDefId) !== defId) continue;
      const engineId = String(v.entityId);
      if (!latestByEngine.has(engineId)) continue;
      const raw = v.valueJson ? safeJsonParse(String(v.valueJson)) : null;
      if (typeof raw === 'string' && raw) groupByEngine.set(engineId, raw);
    }

    // 4) resolve group labels (optional): group entity displayName = best-effort
    const entityRows = await db.select().from(entities).where(isNull(entities.deletedAt)).limit(50_000);
    const entityById = new Map((entityRows as any[]).map((e) => [String(e.id), e] as const));

    // best-effort label attribute on the group entity
    const labelKeys = ['name', 'number', 'full_name'];
    const labelDefCandidates = (def as any[]).filter((d) => labelKeys.includes(String(d.code))).map((d) => String(d.id));
    const labelByEntity = new Map<string, string>();
    for (const v of values as any[]) {
      if (!labelDefCandidates.includes(String(v.attributeDefId))) continue;
      const entId = String(v.entityId);
      if (!entityById.has(entId)) continue;
      const raw = v.valueJson ? safeJsonParse(String(v.valueJson)) : null;
      if (raw != null && raw !== '') labelByEntity.set(entId, String(raw));
    }

    const counts = new Map<string, number>();
    for (const [engineId, stage] of latestByEngine.entries()) {
      if (typeof startMs === 'number' && Number.isFinite(startMs) && stage.ts < startMs) continue;
      const groupId = groupByEngine.get(engineId) ?? '';
      const label = groupId ? labelByEntity.get(groupId) ?? groupId : '(не указано)';
      const key = `${label}||${stage.type}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const header = ['group', 'stage', 'count'];
    const lines: string[] = [header.join(';')];
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [key, count] of sorted) {
      const [group, stage] = key.split('||');
      lines.push([csvEscape(group), csvEscape(stage), String(count)].join(';'));
    }
    return { ok: true, csv: lines.join('\n') + '\n' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

