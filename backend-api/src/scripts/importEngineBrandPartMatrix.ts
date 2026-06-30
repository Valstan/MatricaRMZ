import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { and, eq, isNull } from 'drizzle-orm';
import { AttributeDataType, EntityTypeCode } from '@matricarmz/shared';
import type { PartSpecBrandLink } from '@matricarmz/shared';

import { db } from '../database/db.js';
import { attributeValues, entities } from '../database/schema.js';
import type { AuthUser } from '../auth/jwt.js';
import { createEntity, setEntityAttribute, upsertAttributeDef, upsertEntityType } from '../services/adminMasterdataService.js';
import { getSuperadminUserId } from '../services/employeeAuthService.js';
import {
  createDirectoryPart,
  getWarehouseNomenclaturePartSpec,
  listWarehouseNomenclaturePartSpecs,
  upsertWarehouseNomenclaturePartSpec,
} from '../services/warehouseService.js';

type BrandAssemblyPair = { brandKeys: string[]; assemblyUnitNumber: string };
type ParsedPart = { name: string; sourceLabel: string; linksByBrandKey: Map<string, { assemblyUnitNumber: string }> };

const SOURCE_FILES = [
  '/home/valstan/111.txt',
  '/home/valstan/222.txt',
  '/home/valstan/333.txt',
  '/home/valstan/Сводная ведомость актов комплектности.csv',
  '/home/valstan/Сводная ведомость актов комплектности2.csv',
  '/home/valstan/Сводная ведомость актов комплектности 2.csv',
  '/home/valstan/Сводная ведомость актов комплектности 3.csv',
  '/home/valstan/Сводная ведомость актов комплектности.xlsx',
] as const;

const clean = (v: unknown) =>
  String(v ?? '')
    .replaceAll('\ufeff', '')
    .replaceAll('\u00a0', ' ')
    .replaceAll('\r', '')
    .replaceAll('\n', ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
const nTok = (v: string) => clean(v).toLowerCase().replaceAll('ё', 'е').replaceAll(/["'«»]/g, '').replaceAll(/[^a-z0-9а-я]+/gi, '');
const nHeader = (v: string) => clean(v).toLowerCase().replaceAll('ё', 'е').replaceAll(/["'«»]/g, '').replaceAll(/\s+/g, ' ');
const nAssembly = (v: string) => clean(v).replace(/^сб\.?\s*/i, '').trim();
const stripQty = (v: string) => clean(v).replace(/,\s*\d+\s*шт\.?\s*$/i, '').replace(/\(\s*100\s*%?\s*зам[^)]*\)\s*$/i, '').trim();
const partKey = (name: string) => nTok(name);
const nBrand = (v: string) => {
  const base = clean(v).toUpperCase().replaceAll('Ё', 'Е').replaceAll(/["'«»]/g, '').replaceAll(/[^0-9A-ZА-Я]+/g, '');
  if (base === 'В59У') return 'В59УМС';
  if (base === 'В462С1') return 'В462С1';
  return base;
};

function detectDelimiter(line: string): ';' | '\t' {
  return ((line.match(/;/g) ?? []).length >= (line.match(/\t/g) ?? []).length ? ';' : '\t') as ';' | '\t';
}
function parseDelimitedLine(line: string, delimiter: ';' | '\t'): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else q = !q;
      continue;
    }
    if (ch === delimiter && !q) {
      out.push(clean(cur));
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(clean(cur));
  return out;
}
function readCsvText(path: string): string {
  const bytes = readFileSync(path);
  try {
    return new TextDecoder('windows-1251').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}
function isServiceHeader(h: string): boolean {
  const x = nHeader(h);
  if (!x) return true;
  return ['дата прихода', 'дата отгрузки', 'поставщик', 'марка дв', 'договор', 'номер двигателя', 'изменения от'].some((s) => x.startsWith(s));
}
function isPresence(v: string): boolean {
  const x = clean(v);
  if (!x) return false;
  if (/^\d+(?:[.,]\d+)?$/.test(x)) return Number(x.replace(',', '.')) > 0;
  return /^(да|yes|y|\+)$/i.test(x);
}
function brandName(raw: string, key: string): string {
  const known: Record<string, string> = { В59УМС: 'В-59 УМС', В84: 'В-84', В84АМС: 'В-84 АМС', В84ДТ: 'В-84 ДТ', В465С: 'В-46-5С', В462С1: 'В-46-2С1', В461: 'В-46-1', В46: 'В-46' };
  return known[key] ?? clean(raw).toUpperCase();
}

function parsePairs(rawHeader: string): BrandAssemblyPair[] {
  const source = clean(rawHeader).replace(/,\s*\d+\s*шт\.?\s*$/gi, ' ').replace(/\(\s*100\s*%?\s*зам[^)]*\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!source) return [];
  const byAsm = new Map<string, Set<string>>();
  const add = (asmRaw: string, label: string) => {
    const asm = nAssembly(asmRaw);
    if (!asm) return;
    const keys = new Set<string>();
    for (const chunk of label.split(',').map((v) => clean(v)).filter(Boolean)) {
      const m = chunk.match(/\b(В[-\s]?\d{1,3}(?:[-\s]?[А-ЯA-ZА-Яа-я0-9]+)*)\s*$/u);
      if (!m?.[0]) continue;
      const k = nBrand(m[0]);
      if (k) keys.add(k);
    }
    const set = byAsm.get(asm) ?? new Set<string>();
    for (const k of keys) set.add(k);
    byAsm.set(asm, set);
  };
  for (const seg of source.split(';').map((v) => clean(v)).filter(Boolean)) {
    const m = seg.match(/^(.*)\(\s*сб\.?\s*([^)]+)\s*\)\s*$/i);
    if (m?.[1] && m?.[2]) add(m[2], m[1]);
  }
  if (!byAsm.size) {
    const lead = source.match(/^((?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,60})\s+([А-ЯA-ZЁ].+)$/i);
    if (lead?.[1] && lead?.[2]) add(lead[1], lead[2]);
  }
  const out: BrandAssemblyPair[] = [];
  for (const [assemblyUnitNumber, keys] of byAsm.entries()) out.push({ brandKeys: [...keys].sort((a, b) => a.localeCompare(b)), assemblyUnitNumber });
  return out;
}
function resolveAsm(pairs: BrandAssemblyPair[], brandKeyRaw: string): string {
  const key = nBrand(brandKeyRaw);
  if (!key) return clean(pairs[0]?.assemblyUnitNumber ?? '');
  for (const p of pairs) if (p.brandKeys.includes(key)) return clean(p.assemblyUnitNumber);
  return clean(pairs[0]?.assemblyUnitNumber ?? '');
}
function parsePartDescriptor(rawHeader: string): { name: string; brandAssemblyPairs: BrandAssemblyPair[]; sourceLabel: string } | null {
  const sourceLabel = clean(rawHeader).replace(/\s*;\s*/g, '; ');
  const brandAssemblyPairs = parsePairs(sourceLabel);
  if (!sourceLabel || !brandAssemblyPairs.length) return null;
  let name = '';
  for (const seg of sourceLabel.split(';').map((v) => clean(v)).filter(Boolean)) {
    const label = seg.replace(/\(\s*сб\.?\s*[^)]+\s*\)\s*/gi, ' ').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const i = label.search(/\bВ[-\s]?\d{1,3}/u);
    name = i > 0 ? clean(label.slice(0, i)) : label;
    break;
  }
  if (!name) {
    const lead = sourceLabel.match(/^((?:Сб\.?\s*)?[0-9][0-9A-Za-zА-Яа-я./,\- ]{3,60})\s+([А-ЯA-ZЁ].+)$/i);
    if (lead?.[2]) name = clean(lead[2]);
  }
  name = stripQty(name);
  if (!name) return null;
  return { name, brandAssemblyPairs, sourceLabel };
}

async function actor(): Promise<AuthUser> {
  const id = await getSuperadminUserId();
  if (!id) throw new Error('Пользователь superadmin не найден');
  return { id, username: 'superadmin', role: 'superadmin' };
}
async function ensureBrandInfra(a: AuthUser) {
  const t = await upsertEntityType(a, { code: EntityTypeCode.EngineBrand, name: 'Марка двигателя' });
  if (!t.ok || !t.id) throw new Error('Не удалось подготовить тип марки двигателя');
  const d = await upsertAttributeDef(a, { entityTypeId: t.id, code: 'name', name: 'Название', dataType: AttributeDataType.Text, sortOrder: 10 });
  if (!d.ok || !d.id) throw new Error('Не удалось подготовить атрибут name для типа марки двигателя');
  return { brandTypeId: t.id, brandNameDefId: d.id };
}
async function loadBrandIdsByKey(brandTypeId: string, brandNameDefId: string) {
  const rows = await db.select({ entityId: entities.id, valueJson: attributeValues.valueJson }).from(entities).innerJoin(attributeValues, eq(attributeValues.entityId, entities.id)).where(and(eq(entities.typeId, brandTypeId as any), isNull(entities.deletedAt), eq(attributeValues.attributeDefId, brandNameDefId as any), isNull(attributeValues.deletedAt))).limit(200000);
  const out = new Map<string, string>();
  for (const row of rows) {
    const raw = row.valueJson == null ? '' : String(row.valueJson);
    let name = '';
    try { const parsed = JSON.parse(raw); name = typeof parsed === 'string' ? parsed : String(parsed ?? ''); } catch { name = raw; }
    const key = nBrand(name);
    if (key && !out.has(key)) out.set(key, String(row.entityId));
  }
  return out;
}
// Phase 3.7 WS2: directory-native. Parts are directory_parts rows; index by name.
async function loadPartIdsByName() {
  const out = new Map<string, string>();
  const listed = await listWarehouseNomenclaturePartSpecs();
  if (!listed.ok) throw new Error(`Не удалось загрузить детали: ${listed.error}`);
  for (const row of listed.rows) {
    const key = partKey(row.name);
    if (key && !out.has(key)) out.set(key, row.id);
  }
  return out;
}

async function main() {
  const startedAt = Date.now();
  const a = await actor();
  const brandNameByKey = new Map<string, string>();
  const partsByKey = new Map<string, ParsedPart>();

  for (const filePath of SOURCE_FILES) {
    if (!existsSync(filePath) || filePath.toLowerCase().endsWith('.xlsx')) continue;
    const lines = readCsvText(filePath).split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => nHeader(line).includes('марка дв') && nHeader(line).includes('номер двигателя'));
    if (headerIndex < 0) continue;
    const headers = parseDelimitedLine(lines[headerIndex] ?? '', detectDelimiter(lines[headerIndex] ?? ''));
    const delimiter = detectDelimiter(lines[headerIndex] ?? '');
    const brandCol = headers.findIndex((h) => nHeader(h).includes('марка дв'));
    const engineCol = headers.findIndex((h) => nHeader(h).includes('номер двигателя'));
    if (brandCol < 0) continue;
    const partCols: number[] = [];
    for (let i = (engineCol >= 0 ? engineCol + 1 : brandCol + 1); i < headers.length; i += 1) if (!isServiceHeader(headers[i] ?? '')) partCols.push(i);
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      const row = parseDelimitedLine(lines[i] ?? '', delimiter);
      if (!row.length || row.every((v) => !v)) continue;
      const bRaw = clean(row[brandCol] ?? '');
      const bKey = nBrand(bRaw);
      if (!bKey) continue;
      if (!brandNameByKey.has(bKey)) brandNameByKey.set(bKey, brandName(bRaw, bKey));
      for (const col of partCols) {
        if (!isPresence(clean(row[col] ?? ''))) continue;
        const parsed = parsePartDescriptor(clean(headers[col] ?? ''));
        if (!parsed) continue;
        const key = partKey(parsed.name);
        const asm = resolveAsm(parsed.brandAssemblyPairs, bKey);
        const rec = partsByKey.get(key) ?? { name: parsed.name, sourceLabel: parsed.sourceLabel, linksByBrandKey: new Map<string, { assemblyUnitNumber: string }>() };
        const prev = rec.linksByBrandKey.get(bKey);
        if (!prev || (!prev.assemblyUnitNumber && asm)) rec.linksByBrandKey.set(bKey, { assemblyUnitNumber: asm });
        partsByKey.set(key, rec);
      }
    }
  }

  if (!brandNameByKey.size || !partsByKey.size) throw new Error('Не удалось извлечь данные из матрицы');

  const { brandTypeId, brandNameDefId } = await ensureBrandInfra(a);
  const brandIdByKey = await loadBrandIdsByKey(brandTypeId, brandNameDefId);
  let createdBrands = 0;
  for (const [k, name] of brandNameByKey.entries()) {
    if (brandIdByKey.has(k)) continue;
    const created = await createEntity(a, brandTypeId);
    if (!created.ok || !created.id) throw new Error(`Не удалось создать марку ${name}`);
    const set = await setEntityAttribute(a, created.id, 'name', name);
    if (!set.ok) throw new Error(`Не удалось сохранить марку ${name}: ${set.error ?? 'неизвестная ошибка'}`);
    brandIdByKey.set(k, created.id);
    createdBrands += 1;
  }

  const partIdByName = await loadPartIdsByName();
  // brandId -> brand-link; directory brand-links live in directory_parts.brand_links_json.
  const linksCache = new Map<string, Map<string, PartSpecBrandLink>>();
  let createdParts = 0;
  let upsertedLinks = 0;

  for (const [nameKey, part] of partsByKey.entries()) {
    let partId = partIdByName.get(nameKey) ?? '';
    if (!partId) {
      const created = await createDirectoryPart({ name: part.name });
      if (created.ok) partId = created.part.id;
      else {
        const dup = String(created.error || '').match(/duplicate part exists:\s*([0-9a-f-]{36})/i);
        if (dup?.[1]) partId = dup[1];
        else continue;
      }
      partIdByName.set(nameKey, partId);
      createdParts += 1;
    }
    let currentLinks = linksCache.get(partId);
    if (!currentLinks) {
      const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: partId });
      currentLinks = new Map();
      if (cur.ok && cur.spec) for (const link of cur.spec.brandLinks) currentLinks.set(String(link.engineBrandId), link);
      linksCache.set(partId, currentLinks);
    }
    let dirty = false;
    for (const [brandKey, linkData] of part.linksByBrandKey.entries()) {
      const brandId = brandIdByKey.get(brandKey);
      if (!brandId) continue;
      const existing = currentLinks.get(brandId);
      const asm = clean(linkData.assemblyUnitNumber || existing?.assemblyUnitNumber || 'не указан');
      const qty = Number(existing?.quantity) || 0;
      if (existing && clean(existing.assemblyUnitNumber ?? '') === asm && qty === existing.quantity) continue;
      currentLinks.set(brandId, { id: existing?.id ?? randomUUID(), engineBrandId: brandId, assemblyUnitNumber: asm, quantity: qty });
      dirty = true;
      upsertedLinks += 1;
    }
    if (dirty) {
      const cur = await getWarehouseNomenclaturePartSpec({ nomenclatureId: partId });
      const base = cur.ok && cur.spec ? cur.spec : { code: null, templateId: null, dimensions: [], brandLinks: [] };
      const up = await upsertWarehouseNomenclaturePartSpec({
        nomenclatureId: partId,
        spec: { ...base, brandLinks: [...currentLinks.values()] },
      });
      if (!up.ok) throw new Error(`upsertWarehouseNomenclaturePartSpec(${partId}): ${up.error}`);
    }
  }

  console.log('[import] выполнено');
  console.log(JSON.stringify({ parsed: { brands: brandNameByKey.size, parts: partsByKey.size }, dbChanges: { createdBrands, createdParts, upsertedLinks }, elapsedMs: Date.now() - startedAt }, null, 2));
}

void main().catch((e) => {
  console.error('[import] ошибка', e);
  process.exit(1);
});

