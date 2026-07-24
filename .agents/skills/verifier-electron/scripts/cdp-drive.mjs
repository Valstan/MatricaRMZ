#!/usr/bin/env node
// Computer-use-independent driver for the verifier-electron Electron client.
//
// Connects to the renderer over the Chrome DevTools Protocol (enabled by the
// MATRICA_CDP_PORT switch in electron-app/src/main/index.ts), drives the UI via
// Runtime.evaluate, and captures PNG evidence via Page.captureScreenshot. No
// computer-use MCP, no visible-window pixel clicking.
//
// Live-verifies PR #126 (NomenclaturePage load-all + full client sort) against
// the seeded fixture, and probes the open Inventory «Факт» focus question.
//
// Usage:  MATRICA_CDP_PORT=9222 node .claude/skills/verifier-electron/scripts/cdp-drive.mjs
// Exit 0 = #126 checks PASS, non-zero = FAIL. Inventory probe is informational.

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9222').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const STATE_DIR = join(REPO_ROOT, '.verifier-electron');

function log(...a) {
  console.log('[cdp]', ...a);
}

// ---------------------------------------------------------------------------
// Resolve the `ws` package (pnpm keeps it under node_modules/.pnpm only).
// ---------------------------------------------------------------------------
async function loadWebSocket() {
  const pnpmDir = join(REPO_ROOT, 'node_modules', '.pnpm');
  let candidates = [];
  try {
    candidates = readdirSync(pnpmDir).filter((d) => d.startsWith('ws@'));
  } catch {
    /* ignore */
  }
  for (const c of candidates) {
    const entry = join(pnpmDir, c, 'node_modules', 'ws', 'wrapper.mjs');
    if (existsSync(entry)) {
      const mod = await import(pathToFileURL(entry).href);
      return mod.default ?? mod.WebSocket ?? mod;
    }
  }
  throw new Error(`ws package not found under ${pnpmDir} (expected ws@*/node_modules/ws/wrapper.mjs)`);
}

// ---------------------------------------------------------------------------
// Target discovery
// ---------------------------------------------------------------------------
function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port: Number(PORT), path: pathname, headers: { Host: `127.0.0.1:${PORT}` } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`bad JSON from ${pathname}: ${e}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
  });
}

function pickRendererTarget(list) {
  const pages = list.filter(
    (t) =>
      t.type === 'page' &&
      t.webSocketDebuggerUrl &&
      !String(t.url || '').startsWith('devtools://') &&
      String(t.url || '') !== 'about:blank' &&
      String(t.url || '') !== '',
  );
  const prefer = pages.find((t) => /^https?:\/\//.test(t.url) || /^file:/.test(t.url));
  return prefer || pages[0] || null;
}

async function discoverTarget() {
  const deadline = Date.now() + 60_000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson('/json/list');
      const t = pickRendererTarget(list);
      if (t) return t;
      lastErr = new Error(`no renderer page target yet (saw ${list.length} targets)`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`could not discover renderer target on :${PORT} — ${lastErr}`);
}

// ---------------------------------------------------------------------------
// Minimal CDP client
// ---------------------------------------------------------------------------
class CDP {
  constructor(WebSocket, wsUrl) {
    this.WebSocket = WebSocket;
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new this.WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
          else res(msg.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 120_000);
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails;
      const txt = ex.exception?.description || ex.exception?.value || ex.text || 'evaluate exception';
      throw new Error(`page eval failed: ${txt}`);
    }
    return r.result?.value;
  }
  async screenshot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = join(STATE_DIR, name);
    writeFileSync(file, Buffer.from(r.data, 'base64'));
    log(`screenshot → ${file}`);
    return file;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Page-side helpers (this function is serialized with .toString() and run in
// the renderer's main world; it must reference ONLY page globals).
// ---------------------------------------------------------------------------
function pageHelpers() {
  const V = {};
  V.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  V.visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  V.text = (el) => (el && el.innerText ? el.innerText : '').replace(/\s+/g, ' ').trim();
  V.lines = (el) =>
    (el && el.innerText ? el.innerText : '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  V.setNativeValue = function (el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  V.waitFor = async function (fn, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 15000;
    const interval = opts.interval || 150;
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let r;
      try {
        r = await fn();
      } catch (e) {
        r = null;
      }
      if (r) return r;
      await V.sleep(interval);
    }
    return null;
  };
  V.buttons = () => Array.prototype.slice.call(document.querySelectorAll('button'));
  V.inputs = () => Array.prototype.slice.call(document.querySelectorAll('input'));
  V.findButtonByText = (sub) => V.buttons().find((b) => V.visible(b) && V.text(b).includes(sub)) || null;
  // Suffix match — needed for tabs whose label is also a substring of the
  // department button subtitle (e.g. «Остатки» appears in «Склад / Остатки,
  // документы и инвентаризация»). The tab text ends with «Остатки» (it may carry
  // an icon prefix), while the dept button ends with «инвентаризация».
  V.findTabByLabel = (label) => V.buttons().find((b) => V.visible(b) && V.text(b).endsWith(label)) || null;
  V.findInputByPlaceholder = (ph) =>
    V.inputs().find((i) => V.visible(i) && (i.getAttribute('placeholder') || '') === ph) || null;
  V.groupSection = (name) =>
    Array.prototype.slice.call(document.querySelectorAll('section')).find((s) => {
      const btn = s.querySelector('button');
      return btn && V.text(btn).includes(name);
    }) || null;
  V.authStatus = async () => {
    try {
      return await window.matrica.auth.status();
    } catch (e) {
      return { error: String(e) };
    }
  };
  V.isMonotonic = (arr, dir) => {
    for (let i = 1; i < arr.length; i++) {
      const cmp = String(arr[i - 1]).localeCompare(String(arr[i]), 'ru');
      if (dir === 'asc' && cmp > 0) return { ok: false, at: i, a: arr[i - 1], b: arr[i] };
      if (dir === 'desc' && cmp < 0) return { ok: false, at: i, a: arr[i - 1], b: arr[i] };
    }
    return { ok: true };
  };
  V.colValues = (section, colIdx) =>
    Array.prototype.slice
      .call(section.querySelectorAll('tbody tr'))
      .map((tr) => {
        const tds = tr.querySelectorAll('td');
        return tds[colIdx] ? tds[colIdx].textContent.trim() : '';
      });

  // --- High-level steps -----------------------------------------------------
  V.login = async (username, password) => {
    const st0 = await V.authStatus();
    if (st0 && st0.loggedIn) return { already: true, user: st0.user };
    const loginInput = await V.waitFor(() => V.findInputByPlaceholder('логин'), { timeout: 25000 });
    if (!loginInput) return { error: 'login input not found' };
    V.setNativeValue(loginInput, username);
    const pwInput = V.findInputByPlaceholder('пароль');
    if (!pwInput) return { error: 'password input not found' };
    V.setNativeValue(pwInput, password);
    await V.sleep(150);
    const btn = V.findButtonByText('Войти');
    if (!btn) return { error: 'Войти button not found' };
    btn.click();
    const ok = await V.waitFor(
      async () => {
        const s = await V.authStatus();
        return s && s.loggedIn ? s : null;
      },
      { timeout: 25000, interval: 300 },
    );
    if (!ok) return { error: 'login did not succeed', status: await V.authStatus() };
    return {
      loggedIn: true,
      user: ok.user,
      canViewMasterData: !!(ok.permissions && ok.permissions['masterdata.view']),
    };
  };

  V.gotoNomenclature = async () => {
    const dept = await V.waitFor(() => V.findButtonByText('Склад'), { timeout: 25000 });
    if (!dept) return { error: 'Склад department button not found' };
    dept.click();
    await V.sleep(500);
    const sec = await V.waitFor(() => V.findButtonByText('Номенклатура'), { timeout: 20000 });
    if (sec) {
      sec.click();
      await V.sleep(500);
    }
    const ready = await V.waitFor(() => (document.querySelector('section button') ? true : null), { timeout: 25000 });
    return { ok: !!ready, sectionClicked: !!sec };
  };

  V.gotoInventory = async () => {
    const sec = await V.waitFor(() => V.findButtonByText('Инвентаризация'), { timeout: 20000 });
    if (!sec) return { error: 'Инвентаризация section button not found' };
    sec.click();
    const ready = await V.waitFor(() => (V.findButtonByText('Загрузить остатки') ? true : null), { timeout: 20000 });
    return { ok: !!ready };
  };

  V.expandGroup = async (groupName, expectedSize) => {
    const headerBtn = await V.waitFor(
      () => {
        const s = V.groupSection(groupName);
        return s ? s.querySelector('button') : null;
      },
      { timeout: 25000 },
    );
    if (!headerBtn) return { error: 'group header not found', groupName };
    const headerText = V.text(headerBtn);
    const nums = headerText.match(/\d+/g);
    const badge = nums ? Number(nums[nums.length - 1]) : null;
    const target = expectedSize || badge;
    headerBtn.click();
    // Rows are set in one shot after all pages load; wait until count reaches target.
    const reached = await V.waitFor(
      () => {
        const s = V.groupSection(groupName);
        if (!s) return null;
        const n = s.querySelectorAll('tbody tr').length;
        return n > 0 && (!target || n >= target) ? n : null;
      },
      { timeout: 40000, interval: 250 },
    );
    const s = V.groupSection(groupName);
    const renderedRows = s ? s.querySelectorAll('tbody tr').length : 0;
    return {
      groupName,
      badge,
      expectedSize: expectedSize || null,
      renderedRows,
      reachedTarget: !!reached,
      exceedsOldPageSize: renderedRows > 50,
    };
  };

  // Reads sort behaviour across the whole expanded group:
  // initial = name asc (default), then click each header.
  V.sortReport = async (groupName) => {
    const out = { groupName, steps: [] };
    const readStep = (label) => {
      const s = V.groupSection(groupName);
      if (!s) return { label, error: 'section gone' };
      const count = s.querySelectorAll('tbody tr').length;
      const ths = Array.prototype.slice.call(s.querySelectorAll('thead th')).map((t) => V.text(t));
      return { label, count, names: V.colValues(s, 0), types: V.colValues(s, 1), groups: V.colValues(s, 2), headers: ths };
    };
    const clickHeader = async (startsWith) => {
      const s = V.groupSection(groupName);
      const th = Array.prototype.slice
        .call(s.querySelectorAll('thead th'))
        .find((t) => V.text(t).replace(/\s*[↑↓]\s*$/, '') === startsWith);
      if (!th) return { error: 'th not found', startsWith };
      th.click();
      await V.sleep(350);
      return { clicked: startsWith };
    };
    out.steps.push({ phase: 'initial(name asc)', ...readStep('initial') });
    await clickHeader('Наименование');
    out.steps.push({ phase: 'name desc', ...readStep('name-desc') });
    await clickHeader('Тип');
    out.steps.push({ phase: 'itemType asc', ...readStep('type-asc') });
    await clickHeader('Ед.');
    out.steps.push({ phase: 'unit asc', ...readStep('unit-asc') });
    await clickHeader('Группа');
    out.steps.push({ phase: 'group asc', ...readStep('group-asc') });
    return out;
  };

  V.expandNoGroup = async () => {
    const headerBtn = await V.waitFor(
      () => {
        const s = V.groupSection('Без группы');
        return s ? s.querySelector('button') : null;
      },
      { timeout: 25000 },
    );
    if (!headerBtn) return { error: '«Без группы» header not found' };
    const headerText = V.text(headerBtn);
    const nums = headerText.match(/\d+/g);
    const badge = nums ? Number(nums[nums.length - 1]) : null;
    headerBtn.click();
    // «Без группы» loads the whole catalog then filters client-side → allow more time.
    const reached = await V.waitFor(
      () => {
        const s = V.groupSection('Без группы');
        if (!s) return null;
        const n = s.querySelectorAll('tbody tr').length;
        return n > 0 ? n : null;
      },
      { timeout: 90000, interval: 400 },
    );
    const s = V.groupSection('Без группы');
    const renderedRows = s ? s.querySelectorAll('tbody tr').length : 0;
    const groupCol = s ? V.colValues(s, 2) : [];
    const allDash = groupCol.length > 0 && groupCol.every((g) => g === '—');
    return {
      badge,
      renderedRows,
      reached: !!reached,
      matchesBadge: badge != null ? renderedRows === badge : null,
      allGroupCellsDash: allDash,
      exceedsOldPageSize: renderedRows > 50,
    };
  };

  V.readInventoryTotal = () => {
    const els = Array.prototype.slice.call(document.querySelectorAll('div'));
    const el = els.find((d) => /^Всего:\s*\d+/.test((d.textContent || '').trim()));
    if (!el) return null;
    const m = (el.textContent || '').match(/Всего:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  };
  V.scrollableAncestor = (el) => {
    let n = el;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && n.scrollHeight > n.clientHeight + 4) return n;
      n = n.parentElement;
    }
    return null;
  };
  V.pickBestWarehouse = async () => {
    let warehouses = [];
    try {
      const lk = await window.matrica.warehouse.lookupsGet();
      warehouses = lk && lk.ok && lk.lookups && lk.lookups.warehouses ? lk.lookups.warehouses : [];
    } catch (e) {
      return { error: 'lookupsGet failed: ' + String(e) };
    }
    // Only warehouses present in the lookup are selectable in the UI, and the
    // lookup keys them by warehouse_locations.code (== id only for the fixture
    // location). Restrict counting to selectable warehouses so we never pick a
    // system location (e.g. 'default') that the picker can't resolve.
    const idSet = new Set(warehouses.map((x) => String(x.id)));
    const counts = {};
    let offset = 0;
    const CH = 1000;
    try {
      while (true) {
        const r = await window.matrica.warehouse.stockList({ limit: CH, offset });
        if (!r || !r.ok) break;
        const rows = r.rows || [];
        for (const row of rows) {
          // listWarehouseStock spreads the raw balance row, so the warehouse key
          // is warehouseLocationId (warehouseId is only set on the page side).
          const w = String(row.warehouseLocationId || row.warehouseId || '');
          if (w && idSet.has(w)) counts[w] = (counts[w] || 0) + 1;
        }
        if (!r.hasMore || rows.length === 0) break;
        offset += CH;
        if (offset > 200000) break;
      }
    } catch (e) {
      return { error: 'stockList failed: ' + String(e) };
    }
    let best = null;
    let bestN = -1;
    for (const w in counts) {
      if (counts[w] > bestN) {
        bestN = counts[w];
        best = w;
      }
    }
    const found = warehouses.find((x) => String(x.id) === String(best));
    return { best, bestN, label: found ? found.label : null, warehouseCount: warehouses.length };
  };

  V.inventoryFocusTest = async () => {
    const wh = await V.pickBestWarehouse();
    if (wh.error) return { error: wh.error };
    if (!wh.best || !wh.label) return { error: 'no warehouse with stock', wh };
    const input = await V.waitFor(() => V.findInputByPlaceholder('Склад'), { timeout: 20000 });
    if (!input) return { error: 'warehouse select input not found', wh };
    input.click();
    await V.sleep(250);
    V.setNativeValue(input, wh.label);
    await V.sleep(400);
    const opt = await V.waitFor(
      () => {
        const ds = Array.prototype.slice.call(document.querySelectorAll('div[data-idx]'));
        return ds.find((d) => V.visible(d) && (d.textContent || '').includes(wh.label)) || null;
      },
      { timeout: 10000 },
    );
    if (!opt) return { error: 'warehouse option not found in dropdown', wh };
    opt.click();
    await V.sleep(400);
    const loadBtn = V.findButtonByText('Загрузить остатки') || V.findButtonByText('Загрузка');
    if (!loadBtn) return { error: 'Загрузить остатки button not found', wh };
    loadBtn.click();
    const total = await V.waitFor(
      () => {
        const n = V.readInventoryTotal();
        return n != null && n > 0 ? n : null;
      },
      { timeout: 60000, interval: 400 },
    );
    if (!total) return { error: 'no inventory rows loaded', wh };
    const firstInput = await V.waitFor(() => document.querySelector('input[type=number]'), { timeout: 10000 });
    if (!firstInput) return { error: 'no «Факт» input found', total, wh };
    const container = V.scrollableAncestor(firstInput) || document.scrollingElement;
    firstInput.setAttribute('data-cdp-focus-marker', '1');
    firstInput.focus();
    const focusedInitially = document.activeElement === firstInput;
    const beforeTop = container.scrollTop;
    container.scrollTop = container.scrollHeight;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await V.sleep(600);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await V.sleep(500);
    const active = document.activeElement;
    return {
      warehouse: wh.label,
      warehouseStockCount: wh.bestN,
      inventoryTotalRows: total,
      enoughToVirtualize: total > 25,
      focusedInitially,
      scrolledFrom: beforeTop,
      scrolledTo: container.scrollTop,
      scrollHeight: container.scrollHeight,
      inputStillConnected: firstInput.isConnected,
      focusKeptAfterScroll: active === firstInput,
      activeElementTag: active ? active.tagName : null,
      activeElementType: active && active.getAttribute ? active.getAttribute('type') : null,
      activeElementIsMarkedFact:
        active && active.getAttribute ? active.getAttribute('data-cdp-focus-marker') === '1' : false,
    };
  };

  // --- #135(c): single global view-mode toggle -----------------------------
  // The bug was 7 duplicate per-page view-mode buttons. The fix leaves exactly
  // one global toggle (ListColumnsToggle, text «Режим: …») whose click flips
  // localStorage matrica:listColumnsMode and fires the custom event that makes
  // open pages re-render. Assert: exactly one toggle, and a click flips it.
  V.viewModeButtons = () => V.buttons().filter((b) => V.visible(b) && /^Режим:/.test(V.text(b)));
  V.viewModeToggleTest = async () => {
    const btns = V.viewModeButtons();
    if (btns.length !== 1) return { error: 'expected exactly one «Режим:» toggle', count: btns.length, labels: btns.map(V.text) };
    const btn = btns[0];
    const labelBefore = V.text(btn);
    let storedBefore = null;
    try { storedBefore = window.localStorage.getItem('matrica:listColumnsMode'); } catch { /* ignore */ }
    let eventFired = false;
    const onEvt = () => { eventFired = true; };
    window.addEventListener('matrica:list-columns-mode-changed', onEvt);
    btn.click();
    await V.sleep(300);
    window.removeEventListener('matrica:list-columns-mode-changed', onEvt);
    const after = V.viewModeButtons();
    const labelAfter = after.length === 1 ? V.text(after[0]) : null;
    let storedAfter = null;
    try { storedAfter = window.localStorage.getItem('matrica:listColumnsMode'); } catch { /* ignore */ }
    return {
      count: 1,
      labelBefore,
      labelAfter,
      labelChanged: labelAfter != null && labelAfter !== labelBefore,
      storedBefore,
      storedAfter,
      storedChanged: storedAfter !== storedBefore,
      eventFired,
      stillSingleAfter: after.length === 1,
    };
  };

  // Force compact (multi) mode via the global toggle so the sticky-header test
  // exercises the renderTable code path that the #135(b) fix touched.
  V.ensureCompactMode = async () => {
    for (let i = 0; i < 3; i++) {
      let stored = null;
      try { stored = window.localStorage.getItem('matrica:listColumnsMode'); } catch { /* ignore */ }
      if (stored === 'multi') return { mode: 'multi' };
      const btns = V.viewModeButtons();
      if (btns.length !== 1) return { error: 'toggle not found', count: btns.length };
      btns[0].click();
      await V.sleep(350);
    }
    let stored = null;
    try { stored = window.localStorage.getItem('matrica:listColumnsMode'); } catch { /* ignore */ }
    return stored === 'multi' ? { mode: 'multi' } : { error: 'could not reach compact mode', stored };
  };

  // Navigate Склад → Остатки (StockBalancesPage — a real VirtualTable list that
  // auto-loads the seeded 62-row warehouse stock). This is one of the renderTable
  // pages the #135(b) sticky fix targets, unlike the grouped Nomenclature view.
  V.gotoStockBalances = async () => {
    // The Склад submenu is already open (we came from Номенклатура), so click the
    // section directly — re-clicking the «Склад» dept would collapse it. Mirror
    // gotoInventory. Only open the dept if «Остатки» isn't visible.
    let sec = V.findTabByLabel('Остатки');
    if (!sec) {
      const dept = V.findButtonByText('Склад');
      if (dept) {
        dept.click();
        await V.sleep(400);
      }
      sec = await V.waitFor(() => V.findTabByLabel('Остатки'), { timeout: 20000 });
    }
    if (!sec) return { error: 'Остатки tab button not found' };
    sec.click();
    const rows = await V.waitFor(
      () => {
        const t = document.querySelector('table.list-table');
        if (!t) return null;
        const n = t.querySelectorAll('tbody tr').length;
        return n > 5 ? n : null;
      },
      { timeout: 40000, interval: 300 },
    );
    return { ok: !!rows, rows: rows || 0 };
  };

  // --- #135(b): sticky table header survives scroll in compact mode ---------
  // Regression: in compact (multi) mode the `.list-table-wrap` had overflow-x:auto,
  // which makes overflow-y compute to `auto` → the wrapper became a scroll
  // container and captured the sticky `<th>`, unpinning it so the header scrolled
  // away. Fix: overflow-x:visible (the page-level list box scrolls instead).
  // Differential test: scroll the real scroll container and assert the thead stays
  // pinned (top ≈ unchanged) instead of sliding up with the body (top ≈ -delta).
  V.stickyHeaderTest = async () => {
    const compact = await V.ensureCompactMode();
    if (compact.error) return { error: 'ensureCompactMode: ' + compact.error };
    await V.sleep(350); // allow the list to re-render in compact mode
    const table = document.querySelector('table.list-table');
    if (!table) return { error: 'list-table not found' };
    // Sticky is on the <th> cells (`table.list-table th { position: sticky }`),
    // not on <thead> (which stays static and scrolls). Measure a th cell.
    const th = table.querySelector('thead th');
    if (!th) return { error: 'thead th not found' };
    const wrap = table.parentElement;
    const wrapOverflowX = wrap ? getComputedStyle(wrap).overflowX : null;
    // Nearest scrolling ancestor (the page-level list box with overflow:auto).
    let container = wrap;
    while (container && container !== document.body) {
      const st = getComputedStyle(container);
      const scrolls = (st.overflowY === 'auto' || st.overflowY === 'scroll') && container.scrollHeight > container.clientHeight + 4;
      if (scrolls) break;
      container = container.parentElement;
    }
    if (!container || container === document.body) container = document.scrollingElement || document.documentElement;
    const headPos = getComputedStyle(th).position;
    const contRectTop = container.getBoundingClientRect ? container.getBoundingClientRect().top : 0;
    const topBefore = th.getBoundingClientRect().top;
    const beforeScroll = container.scrollTop;
    const delta = Math.min(500, Math.max(150, container.scrollHeight - container.clientHeight - 1));
    container.scrollTop = beforeScroll + delta;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await V.sleep(400);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const actualDelta = container.scrollTop - beforeScroll;
    const topAfter = th.getBoundingClientRect().top;
    const drift = Math.abs(topAfter - topBefore);
    // Sticky holds if the header barely moved relative to how far we scrolled.
    const stickyHolds = actualDelta > 30 && drift < actualDelta * 0.4;
    return {
      theadPosition: headPos,
      wrapOverflowX,
      containerScrollHeight: container.scrollHeight,
      containerClientHeight: container.clientHeight,
      scrolledDelta: actualDelta,
      theadTopBefore: Math.round(topBefore),
      theadTopAfter: Math.round(topAfter),
      containerTop: Math.round(contRectTop),
      headerDrift: Math.round(drift),
      stickyHolds,
      scrollable: actualDelta > 30,
    };
  };

  window.__v = V;
  return { ready: true, hasMatrica: typeof window.matrica !== 'undefined' };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
function loadManifest() {
  const file = join(STATE_DIR, 'nomenclature-verify-fixture.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { groupName: 'VERIFY · Load-all (CDP)', groupSize: 62 };
  }
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const manifest = loadManifest();
  log(`fixture group="${manifest.groupName}" size=${manifest.groupSize}`);

  const WebSocket = await loadWebSocket();
  log(`connecting CDP on :${PORT} ...`);
  const target = await discoverTarget();
  log(`renderer target: ${target.title || '(no title)'} — ${target.url}`);

  const cdp = new CDP(WebSocket, target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const report = { port: PORT, target: { url: target.url, title: target.title }, results: {} };
  const fail = [];

  const inject = await cdp.evaluate(`(${pageHelpers.toString()})()`);
  report.results.inject = inject;
  log('helpers injected', JSON.stringify(inject));

  // 1) Login
  const login = await cdp.evaluate(`window.__v.login("verify","verify123")`);
  report.results.login = login;
  log('login:', JSON.stringify(login));
  if (login.error || (!login.loggedIn && !login.already)) fail.push('login');
  await cdp.screenshot('cdp-01-after-login.png');

  // 2) Navigate to Склад → Номенклатура
  const nav = await cdp.evaluate(`window.__v.gotoNomenclature()`);
  report.results.gotoNomenclature = nav;
  log('gotoNomenclature:', JSON.stringify(nav));
  if (nav.error || !nav.ok) fail.push('gotoNomenclature');

  // 3) Expand the seeded large group; assert full row count (load-all)
  const expand = await cdp.evaluate(
    `window.__v.expandGroup(${JSON.stringify(manifest.groupName)}, ${Number(manifest.groupSize) || 'null'})`,
  );
  report.results.expandGroup = expand;
  log('expandGroup:', JSON.stringify(expand));
  await cdp.screenshot('cdp-02-group-expanded.png');
  if (expand.error) fail.push('expandGroup:' + expand.error);
  else {
    if (!expand.reachedTarget) fail.push(`expandGroup:rendered=${expand.renderedRows} expected=${expand.expectedSize ?? expand.badge}`);
    if (!expand.exceedsOldPageSize) fail.push('expandGroup:notExceedsOldPageSize(50)');
  }

  // 4) Sort across the whole set
  const sort = await cdp.evaluate(`window.__v.sortReport(${JSON.stringify(manifest.groupName)})`);
  report.results.sortReport = sort;
  await cdp.screenshot('cdp-03-group-sorted-desc.png');
  // Validate sort steps on the Node side.
  const sortChecks = [];
  if (sort && Array.isArray(sort.steps)) {
    const size = Number(manifest.groupSize) || expand.renderedRows;
    const localeCmp = (a, b) => String(a).localeCompare(String(b), 'ru');
    const mono = (arr, dir) => {
      for (let i = 1; i < arr.length; i++) {
        const c = localeCmp(arr[i - 1], arr[i]);
        if (dir === 'asc' && c > 0) return false;
        if (dir === 'desc' && c < 0) return false;
      }
      return true;
    };
    // The Тип column renders the *label* (e.g. «Материал»), but the page sorts
    // by the raw itemType *code*. So we assert contiguity instead of label
    // alphabetical order: a correct full-set sort groups each type into a single
    // run. If only the first page were sorted (the old bug), the cycled types in
    // rows 51-62 would break contiguity → runs > distinct.
    const runs = (arr) => {
      let r = arr.length ? 1 : 0;
      for (let i = 1; i < arr.length; i++) if (arr[i] !== arr[i - 1]) r++;
      return r;
    };
    for (const st of sort.steps) {
      const checks = { phase: st.phase, count: st.count, fullSet: st.count === size };
      if (st.phase === 'initial(name asc)') checks.namesAsc = mono(st.names, 'asc');
      if (st.phase === 'name desc') checks.namesDesc = mono(st.names, 'desc');
      if (st.phase === 'itemType asc') {
        const distinct = new Set(st.types).size;
        const r = runs(st.types);
        checks.itemTypeDistinct = distinct;
        checks.itemTypeRuns = r;
        checks.itemTypeContiguous = distinct > 1 ? r === distinct : true;
      }
      sortChecks.push(checks);
      if (!checks.fullSet) fail.push(`sort:${st.phase}:count=${st.count}!=${size}`);
      if (checks.namesAsc === false) fail.push('sort:initial name not asc across full set');
      if (checks.namesDesc === false) fail.push('sort:name desc not monotonic across full set');
      if (checks.itemTypeContiguous === false)
        fail.push(`sort:itemType not grouped across full set (runs=${checks.itemTypeRuns} distinct=${checks.itemTypeDistinct})`);
    }
  } else {
    fail.push('sortReport:noSteps');
  }
  report.results.sortChecks = sortChecks;
  log('sortChecks:', JSON.stringify(sortChecks));

  // 5) Expand «Без группы»
  const noGroup = await cdp.evaluate(`window.__v.expandNoGroup()`);
  report.results.expandNoGroup = noGroup;
  log('expandNoGroup:', JSON.stringify(noGroup));
  await cdp.screenshot('cdp-04-no-group-expanded.png');
  if (noGroup.error) fail.push('expandNoGroup:' + noGroup.error);
  else if (!noGroup.reached) fail.push('expandNoGroup:noRows');

  // 5b) #135(b): sticky table header survives scroll in compact mode, on the
  // real StockBalances VirtualTable list (62-row fixture). Gating.
  const navStock = await cdp.evaluate(`window.__v.gotoStockBalances()`);
  report.results.gotoStockBalances = navStock;
  log('gotoStockBalances:', JSON.stringify(navStock));
  if (navStock.error || !navStock.ok) fail.push('gotoStockBalances:' + (navStock.error || 'no rows'));
  const sticky = await cdp.evaluate(`window.__v.stickyHeaderTest()`);
  report.results.stickyHeaderTest = sticky;
  log('stickyHeaderTest:', JSON.stringify(sticky));
  await cdp.screenshot('cdp-06-sticky-compact.png');
  if (sticky.error) fail.push('stickyHeader:' + sticky.error);
  else if (!sticky.scrollable) fail.push('stickyHeader:list not tall enough to scroll (cannot verify pinning)');
  else if (!sticky.stickyHolds) fail.push(`stickyHeader:header drifted ${sticky.headerDrift}px while scrolling ${sticky.scrolledDelta}px (not pinned)`);

  // 5c) #135(c): exactly one global view-mode toggle, click flips it
  const toggle = await cdp.evaluate(`window.__v.viewModeToggleTest()`);
  report.results.viewModeToggleTest = toggle;
  log('viewModeToggleTest:', JSON.stringify(toggle));
  if (toggle.error) fail.push(`viewModeToggle:${toggle.error}(count=${toggle.count})`);
  else {
    if (!toggle.stillSingleAfter) fail.push('viewModeToggle:more than one toggle after click');
    if (!toggle.labelChanged) fail.push('viewModeToggle:label did not change on click');
    if (!toggle.storedChanged) fail.push('viewModeToggle:localStorage mode did not change');
    if (!toggle.eventFired) fail.push('viewModeToggle:custom event not fired');
  }

  // 6) Inventory «Факт» focus question (informational, does not fail the run)
  try {
    const inv = await cdp.evaluate(`window.__v.gotoInventory()`);
    report.results.gotoInventory = inv;
    log('gotoInventory:', JSON.stringify(inv));
    if (inv && inv.ok) {
      const focus = await cdp.evaluate(`window.__v.inventoryFocusTest()`);
      report.results.inventoryFocusTest = focus;
      log('inventoryFocusTest:', JSON.stringify(focus));
      await cdp.screenshot('cdp-05-inventory-after-scroll.png');
      // #135(a): focus must survive a scroll over a virtualizable list.
      if (focus.error) fail.push('inventoryFocus:' + focus.error);
      else if (!focus.enoughToVirtualize) log('  (inventory focus: too few rows to exercise virtualization)');
      else if (!focus.focusKeptAfterScroll) fail.push('inventoryFocus:focus lost after scroll');
    }
  } catch (e) {
    report.results.inventoryFocusTest = { error: String(e) };
    log('inventory probe error (non-fatal):', String(e));
  }

  report.verdict = fail.length === 0 ? 'PASS' : 'FAIL';
  report.failures = fail;
  writeFileSync(join(STATE_DIR, 'cdp-report.json'), JSON.stringify(report, null, 2));
  cdp.close();

  log('============ VERDICT (#126 + #135 a/b/c) ============');
  log(report.verdict);
  if (fail.length) fail.forEach((f) => log('  FAIL:', f));
  log('report → ' + join(STATE_DIR, 'cdp-report.json'));
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[cdp] fatal:', e);
  process.exit(2);
});
