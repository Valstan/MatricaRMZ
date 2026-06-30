import { BrowserWindow } from 'electron';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import type { ReportBuilderExportResult, ReportBuilderPreviewRequest, ReportBuilderPreviewResult } from '@matricarmz/shared';
import { httpAuthed } from './httpClient.js';

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

export async function reportsBuilderMeta(db: BetterSQLite3Database, apiBaseUrl: string) {
  const r = await httpAuthed(db, apiBaseUrl, '/reports/builder/meta', { method: 'GET' });
  if (!r.ok) return { ok: false as const, error: r.text ?? 'meta failed' };
  return r.json as any;
}

export async function reportsBuilderPreview(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: ReportBuilderPreviewRequest,
): Promise<ReportBuilderPreviewResult> {
  const r = await httpAuthed(db, apiBaseUrl, '/reports/builder/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false, error: r.text ?? 'preview failed' };
  return r.json as any;
}

export async function reportsBuilderExport(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: ReportBuilderPreviewRequest & { format: 'html' | 'xlsx' },
): Promise<ReportBuilderExportResult> {
  const r = await httpAuthed(db, apiBaseUrl, '/reports/builder/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) return { ok: false, error: r.text ?? 'export failed' };
  return r.json as any;
}

export async function reportsBuilderExportPdf(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: ReportBuilderPreviewRequest & { htmlTitle?: string | null },
): Promise<ReportBuilderExportResult> {
  const htmlRes = await reportsBuilderExport(db, apiBaseUrl, { ...args, format: 'html' });
  if (!htmlRes.ok) return htmlRes;
  const html = Buffer.from(htmlRes.contentBase64, 'base64').toString('utf8');
  const win = await renderHtmlWindow(html);
  try {
    const pdf = await win.webContents.printToPDF({ printBackground: true });
    const fileName = htmlRes.fileName.replace(/\.html$/i, '.pdf');
    return {
      ok: true,
      warning: htmlRes.warning ?? null,
      fileName,
      mime: 'application/pdf',
      contentBase64: Buffer.from(pdf).toString('base64'),
    };
  } finally {
    win.destroy();
  }
}

export async function reportsBuilderPrint(
  db: BetterSQLite3Database,
  apiBaseUrl: string,
  args: ReportBuilderPreviewRequest & { htmlTitle?: string | null },
) {
  const htmlRes = await reportsBuilderExport(db, apiBaseUrl, { ...args, format: 'html' });
  if (!htmlRes.ok) return { ok: false as const, error: htmlRes.error };
  const html = Buffer.from(htmlRes.contentBase64, 'base64').toString('utf8');
  const win = await renderHtmlWindow(html);
  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.print({ printBackground: true }, (ok, errorType) => {
        if (!ok) return reject(new Error(errorType ?? 'print failed'));
        resolve();
      });
    });
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: String(e) };
  } finally {
    win.destroy();
  }
}
