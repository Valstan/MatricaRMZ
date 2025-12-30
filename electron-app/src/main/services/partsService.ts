import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import { httpAuthed } from './httpClient.js';

function formatHttpError(r: { status: number; json?: any; text?: string }): string {
  const jsonErr = r?.json && typeof r.json === 'object' ? (r.json.error ?? r.json.message ?? null) : null;
  const msg =
    typeof jsonErr === 'string'
      ? jsonErr
      : jsonErr != null
        ? JSON.stringify(jsonErr)
        : typeof r.text === 'string' && r.text.trim()
          ? r.text.trim()
          : '';
  return `HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
}

export async function partsList(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { q?: string; limit?: number },
): Promise<
  | {
      ok: true;
      parts: Array<{
        id: string;
        name?: string;
        article?: string;
        updatedAt: number;
        createdAt: number;
      }>;
    }
  | { ok: false; error: string }
> {
  try {
    const queryParams = new URLSearchParams();
    if (args?.q) queryParams.set('q', args.q);
    if (args?.limit) queryParams.set('limit', String(args.limit));

    // Важно: используем /parts/ (со слэшем), чтобы избежать 301 /parts -> /parts/ (301 превращает POST в GET).
    const url = `/parts/${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
    const r = await httpAuthed(db, apiBaseUrl, url, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `list ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad list response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsGet(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string },
): Promise<
  | {
      ok: true;
      part: {
        id: string;
        createdAt: number;
        updatedAt: number;
        attributes: Array<{
          id: string;
          code: string;
          name: string;
          dataType: string;
          value: unknown;
          isRequired: boolean;
          sortOrder: number;
          metaJson?: unknown;
        }>;
      };
    }
  | { ok: false; error: string }
> {
  try {
    const partId = String(args.partId || '');
    if (!partId) return { ok: false, error: 'partId is empty' };

    const r = await httpAuthed(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}`, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `get ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad get response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsCreate(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args?: { attributes?: Record<string, unknown> },
): Promise<
  | {
      ok: true;
      part: { id: string; createdAt: number; updatedAt: number };
    }
  | { ok: false; error: string }
> {
  try {
    const body = JSON.stringify({ attributes: args?.attributes });
    console.log('[partsService] partsCreate: sending POST to', `${apiBaseUrl}/parts`, 'body:', body);
    // Важно: используем /parts/ (со слэшем), чтобы избежать 301 /parts -> /parts/ (301 превращает POST в GET).
    const r = await httpAuthed(db, apiBaseUrl, '/parts/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    console.log('[partsService] partsCreate: response status=', r.status, 'json=', r.json);
    if (!r.ok) return { ok: false, error: `create ${formatHttpError(r)}` };
    if (!r.json) return { ok: false, error: `create response missing json: ${r.text ?? ''}`.trim() };
    if (!r.json.ok) return { ok: false, error: r.json.error ?? 'bad create response' };
    // Проверяем, что это ответ от POST, а не от GET (который возвращает parts вместо part)
    if (r.json.parts !== undefined) {
      return { ok: false, error: `wrong endpoint: got list response instead of create. status=${r.status}, response=${JSON.stringify(r.json)}` };
    }
    if (!r.json.part || !r.json.part.id) {
      return { ok: false, error: `create response missing part.id: ${JSON.stringify(r.json)}` };
    }
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsUpdateAttribute(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string; attributeCode: string; value: unknown },
): Promise<{ ok: true; queued?: boolean; changeRequestId?: string } | { ok: false; error: string }> {
  try {
    const partId = String(args.partId || '');
    const attrCode = String(args.attributeCode || '');
    if (!partId || !attrCode) return { ok: false, error: 'partId or attributeCode is empty' };

    const r = await httpAuthed(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}/attributes/${encodeURIComponent(attrCode)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: args.value }),
    });
    if (!r.ok) return { ok: false, error: `update ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad update response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsDelete(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const partId = String(args.partId || '');
    if (!partId) return { ok: false, error: 'partId is empty' };

    const r = await httpAuthed(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}`, { method: 'DELETE' });
    if (!r.ok) return { ok: false, error: `delete ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad delete response' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsGetFiles(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: { partId: string },
): Promise<
  | {
      ok: true;
      files: unknown[];
    }
  | { ok: false; error: string }
> {
  try {
    const partId = String(args.partId || '');
    if (!partId) return { ok: false, error: 'partId is empty' };

    const r = await httpAuthed(db, apiBaseUrl, `/parts/${encodeURIComponent(partId)}/files`, { method: 'GET' });
    if (!r.ok) return { ok: false, error: `getFiles ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: 'bad getFiles response' };
    return r.json as any;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function partsCreateAttributeDef(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: {
    code: string;
    name: string;
    dataType: 'text' | 'number' | 'boolean' | 'date' | 'json' | 'link';
    isRequired?: boolean;
    sortOrder?: number;
    metaJson?: string | null;
  },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  try {
    const code = String(args.code ?? '').trim();
    const name = String(args.name ?? '').trim();
    if (!code) return { ok: false, error: 'code is empty' };
    if (!name) return { ok: false, error: 'name is empty' };

    const payload: any = {
      code,
      name,
      dataType: args.dataType,
    };
    if (args.isRequired !== undefined) payload.isRequired = args.isRequired;
    if (args.sortOrder !== undefined) payload.sortOrder = args.sortOrder;
    if (args.metaJson !== undefined) payload.metaJson = args.metaJson;

    const r = await httpAuthed(db, apiBaseUrl, '/parts/attribute-defs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) return { ok: false, error: `attributeDefCreate ${formatHttpError(r)}` };
    if (!r.json?.ok) return { ok: false, error: r.json?.error ? String(r.json.error) : 'bad attributeDefCreate response' };
    const id = String(r.json?.id ?? '');
    if (!id) return { ok: false, error: 'attributeDefCreate response missing id' };
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
