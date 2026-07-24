#!/usr/bin/env node
// Batch-2 verification driver: артикул-колонка в номенклатуре/документах + плитка
// «Табель» в «Мой круг». CDP, computer-use-independent.
//   MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-batch2-verify.mjs
import http from 'node:http';
import { writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');
const log = (...a) => console.log('[cdp2]', ...a);

async function loadWebSocket() {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  let candidates = [];
  try { candidates = readdirSync(pnpmDir).filter((d) => d.startsWith('ws@')); } catch { /* ignore */ }
  for (const c of candidates) {
    const entry = join(pnpmDir, c, 'node_modules', 'ws', 'wrapper.mjs');
    if (existsSync(entry)) { const mod = await import(pathToFileURL(entry).href); return mod.default ?? mod.WebSocket ?? mod; }
  }
  throw new Error('ws package not found');
}
function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: Number(PORT), path: pathname, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      let data = ''; res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
  });
}
function pickRendererTarget(list) {
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url || '').startsWith('devtools://') && String(t.url || '') !== 'about:blank' && String(t.url || '') !== '');
  return pages.find((t) => /^https?:\/\//.test(t.url) || /^file:/.test(t.url)) || pages[0] || null;
}
async function discoverTarget() {
  const deadline = Date.now() + 60_000; let lastErr = null;
  while (Date.now() < deadline) {
    try { const list = await httpGetJson('/json/list'); const t = pickRendererTarget(list); if (t) return t; lastErr = new Error('no target yet'); }
    catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`could not discover renderer target — ${lastErr}`);
}
class CDP {
  constructor(WebSocket, wsUrl) { this.WebSocket = WebSocket; this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new this.WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', resolve); this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) { const { resolve: res, reject: rej } = this.pending.get(msg.id); this.pending.delete(msg.id); if (msg.error) rej(new Error(`${msg.error.message}`)); else res(msg.result); }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 120_000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    return r.result?.value;
  }
  async screenshot(name) { const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const f = join(STATE_DIR, name); writeFileSync(f, Buffer.from(r.data, 'base64')); log('screenshot →', f); return f; }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function pageHelpers() {
  const V = {};
  V.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  V.visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  V.text = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();
  V.setNativeValue = function (el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  V.waitFor = async function (fn, opts) {
    opts = opts || {}; const timeout = opts.timeout || 15000; const interval = opts.interval || 150; const t0 = Date.now();
    while (Date.now() - t0 < timeout) { let r; try { r = await fn(); } catch { r = null; } if (r) return r; await V.sleep(interval); }
    return null;
  };
  V.buttons = () => Array.prototype.slice.call(document.querySelectorAll('button'));
  V.inputs = () => Array.prototype.slice.call(document.querySelectorAll('input'));
  V.findButtonByText = (sub) => V.buttons().find((b) => V.visible(b) && V.text(b).includes(sub)) || null;
  V.findTabByLabel = (label) => V.buttons().find((b) => V.visible(b) && V.text(b).endsWith(label)) || null;
  V.findInputByPlaceholder = (ph) => V.inputs().find((i) => V.visible(i) && (i.getAttribute('placeholder') || '') === ph) || null;
  V.groupSection = (name) => Array.prototype.slice.call(document.querySelectorAll('section')).find((s) => { const b = s.querySelector('button'); return b && V.text(b).includes(name); }) || null;
  V.authStatus = async () => { try { return await window.matrica.auth.status(); } catch (e) { return { error: String(e) }; } };

  V.login = async (username, password) => {
    const st0 = await V.authStatus();
    if (st0 && st0.loggedIn) return { already: true, user: st0.user };
    const loginInput = await V.waitFor(() => V.findInputByPlaceholder('логин'), { timeout: 25000 });
    if (!loginInput) return { error: 'login input not found' };
    V.setNativeValue(loginInput, username);
    const pw = V.findInputByPlaceholder('пароль'); if (!pw) return { error: 'pw not found' };
    V.setNativeValue(pw, password); await V.sleep(150);
    const btn = V.findButtonByText('Войти'); if (!btn) return { error: 'Войти not found' };
    btn.click();
    const ok = await V.waitFor(async () => { const s = await V.authStatus(); return s && s.loggedIn ? s : null; }, { timeout: 25000, interval: 300 });
    return ok ? { loggedIn: true, user: ok.user } : { error: 'login failed', status: await V.authStatus() };
  };

  // --- #1: артикул in nomenclature list ---
  V.gotoNomenclature = async () => {
    const dept = await V.waitFor(() => V.findButtonByText('Склад'), { timeout: 25000 });
    if (!dept) return { error: 'Склад not found' };
    dept.click(); await V.sleep(500);
    const sec = await V.waitFor(() => V.findButtonByText('Номенклатура'), { timeout: 20000 });
    if (sec) { sec.click(); await V.sleep(600); }
    return { ok: true };
  };
  // Expand the first group section that has a row count, read its table head + first row cells.
  V.nomenclatureArtikul = async () => {
    // find any group section button and click to expand
    const secs = Array.prototype.slice.call(document.querySelectorAll('section')).filter((s) => s.querySelector('button'));
    let opened = null;
    for (const s of secs) {
      const btn = s.querySelector('button');
      if (!btn || !V.visible(btn)) continue;
      btn.click();
      const rows = await V.waitFor(() => { const t = s.querySelector('table'); return t && t.querySelectorAll('tbody tr').length > 0 ? t : null; }, { timeout: 8000, interval: 200 });
      if (rows) { opened = { section: s, table: rows }; break; }
      btn.click(); // collapse, try next
    }
    if (!opened) return { error: 'no expandable group with rows found' };
    const headers = Array.prototype.slice.call(opened.table.querySelectorAll('thead th')).map((t) => V.text(t).replace(/\s*[↑↓]\s*$/, ''));
    const firstRow = opened.table.querySelector('tbody tr');
    const cells = firstRow ? Array.prototype.slice.call(firstRow.querySelectorAll('td')).map((td) => V.text(td)) : [];
    const artikulIdx = headers.findIndex((h) => h === 'Артикул');
    const nameIdx = headers.findIndex((h) => h === 'Наименование');
    return { headers, firstRowCells: cells, hasArtikulHeader: artikulIdx >= 0, artikulIdx, nameIdx, artikulAfterName: artikulIdx === nameIdx + 1, sampleArtikul: artikulIdx >= 0 ? cells[artikulIdx] : null };
  };

  // --- #1: артикул in stock document lines ---
  V.gotoDocuments = async () => {
    let sec = V.findTabByLabel('Документы');
    if (!sec) { const dept = V.findButtonByText('Склад'); if (dept) { dept.click(); await V.sleep(400); } sec = await V.waitFor(() => V.findTabByLabel('Документы'), { timeout: 20000 }); }
    if (!sec) return { error: 'Документы tab not found' };
    sec.click();
    const ready = await V.waitFor(() => (document.querySelector('table') ? true : null), { timeout: 20000 });
    return { ok: !!ready };
  };
  V.openFirstDocumentWithLines = async () => {
    // The documents list is a table; click rows until a details view with a line table shows.
    const listTable = await V.waitFor(() => document.querySelector('table'), { timeout: 15000 });
    if (!listTable) return { error: 'documents list table not found' };
    const rows = Array.prototype.slice.call(listTable.querySelectorAll('tbody tr')).filter((r) => V.visible(r));
    let result = null;
    for (let i = 0; i < Math.min(rows.length, 8); i++) {
      const r = rows[i];
      r.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      r.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      // wait for a details line-table whose header includes «Номенклатура»
      const det = await V.waitFor(() => {
        const tables = Array.prototype.slice.call(document.querySelectorAll('table'));
        for (const t of tables) {
          const ths = Array.prototype.slice.call(t.querySelectorAll('thead th')).map((x) => V.text(x));
          if (ths.includes('Номенклатура')) return { t, ths };
        }
        return null;
      }, { timeout: 6000, interval: 200 });
      if (det) {
        const lineRow = det.t.querySelector('tbody tr');
        const cells = lineRow ? Array.prototype.slice.call(lineRow.querySelectorAll('td')).map((td) => V.text(td)) : [];
        const nomIdx = det.ths.findIndex((h) => h === 'Номенклатура');
        const artIdx = det.ths.findIndex((h) => h === 'Артикул');
        result = { headers: det.ths, hasArtikul: artIdx >= 0, nomIdx, artIdx, artikulAfterNom: artIdx === nomIdx + 1, hasLines: !!lineRow, sampleArtikul: artIdx >= 0 && cells.length > artIdx ? cells[artIdx] : null, firstRowCells: cells };
        if (result.hasLines) break; // prefer a doc that actually has lines
      }
      // go back to list if possible
      const back = V.findButtonByText('Назад') || V.findButtonByText('К списку') || V.findButtonByText('Документы');
      if (back) { back.click(); await V.sleep(400); }
    }
    return result || { error: 'no document opened with a Номенклатура line-table' };
  };

  // --- #1b fallback: create a document, add a line, read the «Артикул» column ---
  V.createDocCheckArtikul = async () => {
    const createBtn = await V.waitFor(() => V.findButtonByText('Создать документ'), { timeout: 8000 });
    if (!createBtn) return { error: 'Создать документ not found' };
    createBtn.click(); await V.sleep(700);
    const findLineTable = () => {
      const tables = Array.prototype.slice.call(document.querySelectorAll('table'));
      for (const t of tables) { const ths = Array.prototype.slice.call(t.querySelectorAll('thead th')).map(V.text); if (ths.includes('Номенклатура')) return { t, ths }; }
      return null;
    };
    let det = await V.waitFor(findLineTable, { timeout: 4000, interval: 200 });
    if (!det) {
      const typeBtns = V.buttons().filter((b) => V.visible(b) && /Приход|Поступл|Расход|Перемещ|Списан|Инвентар/i.test(V.text(b)));
      if (typeBtns[0]) { typeBtns[0].click(); await V.sleep(700); }
      det = await V.waitFor(findLineTable, { timeout: 6000, interval: 200 });
    }
    if (!det) return { error: 'line table with «Номенклатура» not found after create' };
    const nomIdx = det.ths.indexOf('Номенклатура');
    const artIdx = det.ths.indexOf('Артикул');
    const out = { headers: det.ths, hasArtikul: artIdx >= 0, artikulAfterNom: artIdx === nomIdx + 1, nomIdx, artIdx, sampleArtikul: null, addedLine: false };
    // try to add a line and select a nomenclature with a code
    const addBtn = V.findButtonByText('Добавить строку') || V.findButtonByText('Добавить');
    if (addBtn && artIdx >= 0) {
      const before = V.inputs().length;
      addBtn.click(); await V.sleep(500);
      const nomInput = await V.waitFor(() => V.inputs().find((i) => V.visible(i) && (i.getAttribute('placeholder') || '') === 'Номенклатура'), { timeout: 4000 });
      if (nomInput) {
        nomInput.click(); await V.sleep(200);
        V.setNativeValue(nomInput, 'Гильза'); await V.sleep(500);
        const opt = await V.waitFor(() => { const ds = Array.prototype.slice.call(document.querySelectorAll('div[data-idx]')); return ds.find((d) => V.visible(d) && /\(/.test(d.textContent || '')) || null; }, { timeout: 5000 });
        if (opt) {
          opt.click(); await V.sleep(600);
          const d2 = findLineTable();
          if (d2) { const lr = d2.t.querySelector('tbody tr'); const cells = lr ? Array.prototype.slice.call(lr.querySelectorAll('td')).map((td) => V.text(td)) : []; out.sampleArtikul = cells.length > artIdx ? cells[artIdx] : null; out.addedLine = !!lr; out.lineCells = cells; }
        }
      }
    }
    return out;
  };

  // --- #2: Табель tile in Мой круг ---
  V.gotoMyCircle = async () => {
    const btn = await V.waitFor(() => V.buttons().find((b) => V.visible(b) && V.text(b).includes('Мой круг')), { timeout: 20000 });
    if (!btn) return { error: 'Мой круг button not found' };
    btn.click(); await V.sleep(800);
    return { ok: true };
  };
  V.findTimesheetTile = async () => {
    // Wait for the seed (runs on uiProfileGet after login) + render. Look for a clickable
    // element (button/a/div) whose text includes «Табель» within the Мой круг page.
    const tile = await V.waitFor(() => {
      const all = Array.prototype.slice.call(document.querySelectorAll('button, a, [role="button"], div'));
      return all.find((el) => V.visible(el) && /Табель/i.test(V.text(el)) && V.text(el).length < 60) || null;
    }, { timeout: 12000, interval: 300 });
    let pins = null;
    try { const st = await window.matrica.auth.status(); pins = null; } catch { /* ignore */ }
    return { found: !!tile, tileText: tile ? V.text(tile) : null };
  };

  window.__v = V;
  return { ready: true, hasMatrica: typeof window.matrica !== 'undefined' };
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const WebSocket = await loadWebSocket();
  log(`connecting CDP on :${PORT} ...`);
  const target = await discoverTarget();
  log('target:', target.url);
  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  const report = { results: {} }; const fail = [];

  report.results.inject = await cdp.evaluate(`(${pageHelpers.toString()})()`);
  log('inject:', JSON.stringify(report.results.inject));

  const login = await cdp.evaluate(`window.__v.login("verify","verify123")`);
  report.results.login = login; log('login:', JSON.stringify(login));
  if (login.error) fail.push('login:' + login.error);
  await cdp.screenshot('cdp2-01-login.png');

  // #1a nomenclature
  await cdp.evaluate(`window.__v.gotoNomenclature()`);
  const nom = await cdp.evaluate(`window.__v.nomenclatureArtikul()`);
  report.results.nomenclatureArtikul = nom; log('nomenclatureArtikul:', JSON.stringify(nom));
  await cdp.screenshot('cdp2-02-nomenclature.png');
  if (nom.error) fail.push('nomenclature:' + nom.error);
  else { if (!nom.hasArtikulHeader) fail.push('nomenclature: no «Артикул» header'); if (!nom.artikulAfterName) fail.push(`nomenclature: Артикул not right after Наименование (idx art=${nom.artikulIdx} name=${nom.nameIdx})`); }

  // #1b stock document lines
  const navDoc = await cdp.evaluate(`window.__v.gotoDocuments()`);
  report.results.gotoDocuments = navDoc; log('gotoDocuments:', JSON.stringify(navDoc));
  if (navDoc && navDoc.ok) {
    // Snapshot has no documents → create one to exercise the line table «Артикул» column.
    const doc = await cdp.evaluate(`window.__v.createDocCheckArtikul()`);
    report.results.documentArtikul = doc; log('documentArtikul:', JSON.stringify(doc));
    await cdp.screenshot('cdp2-03-document.png');
    if (doc && !doc.error) { if (!doc.hasArtikul) fail.push('document: no «Артикул» header'); else if (!doc.artikulAfterNom) fail.push('document: Артикул not right after Номенклатура'); }
    else fail.push('document: ' + (doc && doc.error));
  } else { report.results.documentArtikul = { skipped: navDoc && navDoc.error }; }

  // #2 Табель tile in Мой круг
  const navMc = await cdp.evaluate(`window.__v.gotoMyCircle()`);
  report.results.gotoMyCircle = navMc; log('gotoMyCircle:', JSON.stringify(navMc));
  const tile = await cdp.evaluate(`window.__v.findTimesheetTile()`);
  report.results.timesheetTile = tile; log('timesheetTile:', JSON.stringify(tile));
  await cdp.screenshot('cdp2-04-mycircle.png');
  if (!navMc || navMc.error) fail.push('myCircle:' + (navMc && navMc.error));
  else if (!tile.found) fail.push('myCircle: «Табель» tile not found');

  report.verdict = fail.length === 0 ? 'PASS' : 'FAIL'; report.failures = fail;
  writeFileSync(join(STATE_DIR, 'cdp2-report.json'), JSON.stringify(report, null, 2));
  cdp.close();
  log('============ VERDICT (batch-2) ============'); log(report.verdict);
  fail.forEach((f) => log('  FAIL:', f));
  process.exit(fail.length === 0 ? 0 : 1);
}
main().catch((e) => { console.error('[cdp2] fatal:', e); process.exit(2); });
