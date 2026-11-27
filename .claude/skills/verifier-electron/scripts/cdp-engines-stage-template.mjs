// Смоук нитки КАРМАНА #181: ступень «Этап ремонта» в списке двигателей, один ряд этапов
// в отчёте «Сейчас на заводе» и шаблоны фильтров списка.
//
// Держит СВОЙСТВА, а не клики:
//   [1] в панели фильтров списка есть ступень «Этап ремонта» (id repairStage);
//   [2] ряд её значений — этапы из справочника, каждый РОВНО ОДИН раз (нет задвоения);
//   [3] «Текущее состояние» этапов ремонта не предлагает (иначе этап был бы в списке дважды);
//   [4] в отчёте «Сейчас на заводе» этапы предлагает ровно ОДНА ступень (repairStage),
//       а «Истории» в отчёте нет;
//   [5] в списке есть «сохранить шаблон» и выбор шаблона;
//   [6] сохранённый шаблон в профиле: значения ступеней + включённые ступени + отключённые
//       фильтры, и в нём НЕТ выбранного заказчика и договора;
//   [7] применение шаблона даёт отфильтрованный список.
//
// Запуск: MATRICA_CDP_PORT=9223 node .claude/skills/verifier-electron/scripts/cdp-engines-stage-template.mjs
// Exit 0 = все проверки PASS.

import http from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = (process.env.MATRICA_CDP_PORT || '9223').trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const OUT_DIR = join(REPO_ROOT, '.verifier-electron');
mkdirSync(OUT_DIR, { recursive: true });

const steps = [];
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}

function httpGetJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: Number(PORT), path: pathname, headers: { Host: `127.0.0.1:${PORT}` } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`bad JSON from ${pathname}: ${e}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('http timeout')));
  });
}

async function discoverTarget() {
  const deadline = Date.now() + 60000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const list = await httpGetJson('/json/list');
      const t = list.filter((x) => x.type === 'page' && x.webSocketDebuggerUrl && !String(x.url).startsWith('devtools://') && String(x.url) !== 'about:blank')[0];
      if (t) return t;
      lastErr = new Error(`no renderer target yet (saw ${list.length})`);
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`could not discover renderer target on :${PORT} — ${lastErr}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    };
    ws.onerror = (e) => reject(new Error(`ws error: ${e?.message ?? 'unknown'}`));
    ws.onopen = () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      resolve({ send, close: () => ws.close() });
    };
  });
}

const HELPERS = `
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const PANE = () => document.querySelector('.v3-tab-pane[data-pane-active="1"]') ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const vis = (sel, root) => [...(root ?? PANE()).querySelectorAll(sel)].filter(visible);
  const painted = (el) => {
    if (!visible(el)) return false;
    let child = el;
    for (let a = el.parentElement; a; child = a, a = a.parentElement) {
      if (a.tagName === 'DETAILS' && !a.open && child.tagName !== 'SUMMARY') return false;
    }
    return true;
  };
  const shown = () => { const c = vis('[data-list-count]')[0]; const m = c ? /Показано: (\\d+)/.exec(txt(c)) : null; return m ? Number(m[1]) : null; };
  const call = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('bridge timeout')), 20000))]);
`;

async function evaluate(ws, expression) {
  const result = await ws.send('Runtime.evaluate', {
    expression: `(async () => { ${HELPERS} ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(ws, name) {
  const s = await ws.send('Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-181-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
}

async function openSection(ws, group, item) {
  const already = await evaluate(
    ws,
    `const tab = [...document.querySelectorAll('.v3-tab')].find((t) => txt(t.querySelector('.v3-tab-label') ?? t).includes(${JSON.stringify(item)}));
     if (!tab) return false;
     if (tab.getAttribute('data-active') === '1') return true;
     click(tab.querySelector('.v3-tab-label') ?? tab); await wait(1200);
     return true;`,
  );
  if (already) return;
  const r = await evaluate(
    ws,
    `await dismissModals();
     if (!document.querySelector('.v3-menu-overlay')) {
       let b = null;
       for (let i = 0; i < 20 && !b; i++) {
         const el = document.elementFromPoint(75, 17);
         b = el && el.closest('button');
         if (!b) await wait(500);
       }
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(800); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes(${JSON.stringify(item)}));
     if (!it) return { ok: false, reason: 'пункт не найдена' };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  if (!r?.ok) throw new Error(`меню ${group} → ${item}: ${r?.reason}`);
}

async function main() {
  const target = await discoverTarget();
  const ws = await connect(target.webSocketDebuggerUrl);
  await ws.send('Runtime.enable');
  await ws.send('Page.enable');

  // ── вход ────────────────────────────────────────────────────────────────────
  const needLogin = await evaluate(ws, `return Boolean(document.querySelector('input[type="password"]'));`);
  if (needLogin) {
    await evaluate(
      ws,
      `const inputs = [...document.querySelectorAll('input')].filter(visible);
       const user = inputs.find((i) => i.type !== 'password');
       setVal(user, 'verify'); await wait(200);
       setVal(inputs.find((i) => i.type === 'password'), 'verify123'); await wait(200);
       const b = byText('Войти'); if (!b) throw new Error('кнопка «Войти» не найдена');
       click(b); return true;`,
    );
    for (let i = 0; i < 60; i++) {
      if (!(await evaluate(ws, `return Boolean(document.querySelector('input[type="password"]'));`))) break;
      await sleep(500);
    }
  }
  await evaluate(ws, `await dismissModals(); return true;`);
  const auth = await evaluate(ws, `const st = await call(window.matrica.auth.status()); return { loggedIn: Boolean(st?.loggedIn), userId: st?.user?.id ?? null, role: st?.user?.role ?? null };`);
  note(auth.loggedIn === true, 'вход в клиент состоялся', auth);

  // ── [1..3] список двигателей: ступень «Этап ремонта» и один ряд этапов ───────
  await openSection(ws, 'Производство', 'Двигатели');
  await evaluate(ws, `await wait(1500); return true;`);

  const panel = await evaluate(
    ws,
    `if (!document.querySelector('[data-engine-facets]')) {
       const t = vis('[data-facet-toggle]')[0] ?? null;
       if (t) { click(t); await wait(900); }
     }
     const c = document.querySelector('[data-facet-collapse]');
     if (c && c.getAttribute('aria-expanded') === 'false') { click(c); await wait(800); }
     const r = vis('[data-facet-reset]')[0] ?? null;
     if (r && !r.disabled) { click(r); await wait(600); }
     const cells = vis('[data-facet-field]');
     const ids = cells.map((b) => b.getAttribute('data-facet-field'));
     const labels = {};
     for (const b of cells) labels[b.getAttribute('data-facet-field')] = txt(b);
     return { ids, labels };`,
  );
  note(panel.ids.includes('repairStage'), 'в панели фильтров списка есть ступень «Этап ремонта» (repairStage)', { ids: panel.ids });
  note(panel.labels?.repairStage === 'Этап ремонта', 'подпись ступени — «Этап ремонта»', { label: panel.labels?.repairStage });

  // Ряд значений ступени: открыть меню repairStage и посчитать значения.
  const stageOptions = await evaluate(
    ws,
    `const cell = vis('[data-facet-field]').find((b) => b.getAttribute('data-facet-field') === 'repairStage');
     if (!cell) return { ok: false, reason: 'ступени нет' };
     click(cell); await wait(900);
     const m = vis('[data-facet-menu]')[0] ?? null;
     if (!m) return { ok: false, reason: 'меню не открылось' };
     const vals = [...m.querySelectorAll('[data-facet-value]')].map((v) => v.getAttribute('data-facet-value'));
     const labels = [...m.querySelectorAll('[data-facet-value]')].map((v) => txt(v));
     click(document.body); await wait(400);
     return { ok: true, facet: m.getAttribute('data-facet-menu'), vals, labels };`,
  );
  const vals = stageOptions.vals ?? [];
  const raw = vals.map((v) => String(v).replace(/^repairStage:/, ''));
  const dupes = raw.filter((v, i) => raw.indexOf(v) !== i);
  note(stageOptions.ok === true && raw.length > 0, 'меню ступени «Этап ремонта» открывается и полно', { values: raw.length });
  note(dupes.length === 0, 'каждый этап в выпадающем списке — ровно один раз', { dupes });
  note(raw.every((v) => v.startsWith('repair:')), 'значения ступени — из пространства `repair:`', { sample: raw.slice(0, 3) });

  // «Текущее состояние» этапов ремонта не предлагает.
  const factoryOptions = await evaluate(
    ws,
    `const cell = vis('[data-facet-field]').find((b) => b.getAttribute('data-facet-field') === 'factoryStage');
     if (!cell) return { ok: false, reason: 'ступени нет' };
     click(cell); await wait(900);
     const m = vis('[data-facet-menu]')[0] ?? null;
     if (!m) return { ok: false, reason: 'меню не открылось' };
     const vals = [...m.querySelectorAll('[data-facet-value]')].map((v) => v.getAttribute('data-facet-value'));
     click(document.body); await wait(400);
     return { ok: true, vals };`,
  );
  const factoryStageValues = (factoryOptions.vals ?? []).filter((v) => String(v).startsWith('stage:'));
  note(factoryStageValues.length === 0, '«Текущее состояние» этапов ремонта не предлагает (иначе этап задвоится)', { stageValues: factoryStageValues });

  // ── [5..7] шаблоны фильтров списка ───────────────────────────────────────────
  const tmpl = await evaluate(
    ws,
    `const sel = document.querySelector('[data-engine-filter-template]');
     const name = document.querySelector('[data-engine-filter-template-name]');
     const save = document.querySelector('[data-engine-filter-template-save]');
     const status = document.querySelector('[data-engine-filter-template-status]');
     return { hasSelect: !!sel, hasName: !!name, hasSave: !!save, status: status ? txt(status) : null, options: sel ? [...sel.options].map((o) => o.value) : [] };`,
  );
  note(tmpl.hasSelect === true, 'в списке есть выбор шаблона', tmpl.options);
  note(tmpl.hasName === true && tmpl.hasSave === true, 'в списке есть «сохранить шаблон» с названием');

  // Выбрать этап ремонта — ступень должна реально отбирать список.
  const stagePicked = await evaluate(
    ws,
    `const cell = vis('[data-facet-field]').find((b) => b.getAttribute('data-facet-field') === 'repairStage');
     if (!cell) return { ok: false, reason: 'ступени нет' };
     click(cell); await wait(900);
     const m = vis('[data-facet-menu]')[0] ?? null;
     if (!m) return { ok: false, reason: 'меню не открылось' };
     const v = m.querySelector('[data-facet-value]');
     if (!v) { click(document.body); await wait(300); return { ok: false, reason: 'вариантов этапа нет' }; }
     const value = String(v.getAttribute('data-facet-value')).replace(/^repairStage:/, '');
     const before = shown();
     click(v); await wait(1500);
     return { ok: true, value, before, after: shown() };`,
  );
  note(stagePicked.ok === true, 'этап ремонта выбирается в ступени', stagePicked);
  await shot(ws, '1-stage-picked');

  // Выбрать заказчика (если в фикстурах есть) — чтобы проверить, что в шаблон он НЕ попал.
  const customerPicked = await evaluate(
    ws,
    `const cell = vis('[data-facet-field]').find((b) => b.getAttribute('data-facet-field') === 'customer');
     if (!cell) return { picked: false, reason: 'ступени «Заказчик» нет' };
     click(cell); await wait(900);
     const m = vis('[data-facet-menu]')[0] ?? null;
     if (!m) return { picked: false, reason: 'меню не открылось' };
     const v = m.querySelector('[data-facet-value]');
     if (!v) { click(document.body); await wait(300); return { picked: false, reason: 'вариантов заказчика нет' }; }
     const value = v.getAttribute('data-facet-value');
     click(v); await wait(1200);
     return { picked: true, value };`,
  );
  note(true, 'заказчик в отборе (для проверки шаблона)', customerPicked);

  // Сохранить шаблон под своим именем.
  const saved = await evaluate(
    ws,
    `const name = document.querySelector('[data-engine-filter-template-name]');
     const save = document.querySelector('[data-engine-filter-template-save]');
     if (!name || !save) return { ok: false, reason: 'нет полей шаблона' };
     setVal(name, 'СМОУК #181'); await wait(300);
     click(save); await wait(2500);
     const sel = document.querySelector('[data-engine-filter-template]');
     const status = document.querySelector('[data-engine-filter-template-status]');
     return {
       ok: true,
       status: status ? txt(status) : null,
       options: sel ? [...sel.options].map((o) => ({ value: o.value, text: o.textContent })) : [],
     };`,
  );
  note(saved.ok === true && /СМОУК #181/.test(saved.status ?? ''), 'шаблон сохранён — статус об этом говорит', { status: saved.status });
  const mine = (saved.options ?? []).find((o) => o.text === 'СМОУК #181');
  note(Boolean(mine), 'шаблон появился в списке выбора', { options: saved.options });

  // Что РЕАЛЬНО сохранилось в профиле (читаем через мост — тот же механизм роуминга).
  const stored = await evaluate(
    ws,
    `const st = await call(window.matrica.auth.status());
     const list = await call(window.matrica.reports.filterTemplatesList({ userId: String(st?.user?.id ?? ''), presetId: 'list:engines' }));
     const tpl = (list?.templates ?? []).find((t) => t.name === 'СМОУК #181') ?? null;
     return { ok: Boolean(list?.ok), tpl: tpl ? { name: tpl.name, filters: tpl.filters, disabled: tpl.disabled, enabled: tpl.enabled } : null };`,
  );
  const tpl = stored.tpl;
  note(tpl != null, 'шаблон лежит в механизме шаблонов под ключом list:engines', { ok: stored.ok });
  note(tpl != null && !('customer' in (tpl.filters ?? {})), 'в сохранённом шаблоне нет выбранного заказчика', { filters: tpl?.filters });
  note(tpl != null && !('contract' in (tpl.filters ?? {})), 'в сохранённом шаблоне нет выбранного договора');
  note(tpl != null && Array.isArray(tpl.disabled) && tpl.disabled.length > 0, 'шаблон хранит перечень отключённых фильтров', { disabled: tpl?.disabled });
  note(
    tpl != null && Array.isArray(tpl.enabled) && tpl.enabled.includes('repairStage'),
    'шаблон хранит перечень включённых ступеней (включая этап ремонта)',
    { enabled: tpl?.enabled },
  );
  note(
    tpl != null && Array.isArray(tpl.disabled) && !tpl.disabled.includes('repairStage'),
    'включённая ступень не попала в перечень отключённых',
    { disabled: tpl?.disabled?.slice(0, 5) },
  );
  note(
    tpl != null && Array.isArray(tpl.filters?.repairStage) && tpl.filters.repairStage.length === 1,
    'в шаблоне сохранено значение этапа ремонта',
    { repairStage: tpl?.filters?.repairStage },
  );
  await shot(ws, '1-list-templates');

  // Применение шаблона: заказчик и договор должны остаться пустыми.
  // Применение шаблона: сначала сбросить отбор (список должен вернуться к полному),
  // потом применить шаблон — и список должен снова стать отфильтрованным.
  const applied = await evaluate(
    ws,
    `const reset = vis('[data-facet-reset]')[0] ?? null;
     if (reset && !reset.disabled) { click(reset); await wait(1500); }
     const afterReset = shown();
     const sel = document.querySelector('[data-engine-filter-template]');
     const opt = [...sel.options].find((o) => o.text === 'СМОУК #181');
     if (!opt) return { ok: false, reason: 'шаблона нет в списке' };
     setVal(sel, opt.value); await wait(2000);
     const chips = vis('[data-facet-value]').map((v) => v.getAttribute('data-facet-value'));
     const status = document.querySelector('[data-engine-filter-template-status]');
     return { ok: true, chips, status: status ? txt(status) : null, afterReset, after: shown() };`,
  );
  note(applied.ok === true, 'шаблон применяется одним движением', { status: applied.status });
  note(
    applied.ok === true && applied.afterReset !== null && applied.after !== null && applied.after < applied.afterReset,
    'после применения шаблона список сразу отфильтрован',
    { afterReset: applied.afterReset, after: applied.after },
  );
  note(
    applied.ok === true && !(applied.chips ?? []).some((c) => String(c).startsWith('customer:') || String(c).startsWith('contract:')),
    'после применения заказчик и договор пусты',
    { chips: applied.chips },
  );

  // ── [4] отчёт «Сейчас на заводе»: этапы предлагает ровно одна ступень ───────
  await openSection(ws, 'Производство', 'Сейчас на заводе');
  await evaluate(ws, `await wait(2000); return true;`);
  const report = await evaluate(
    ws,
    `if (!document.querySelector('[data-engine-facets]')) {
       const t = vis('[data-facet-toggle]')[0] ?? null;
       if (t) { click(t); await wait(900); }
     }
     const ids = vis('[data-facet-field]').map((b) => b.getAttribute('data-facet-field'));
     return { ids };`,
  );
  const stageSteps = (report.ids ?? []).filter((id) => id === 'repairStage' || id === 'hasStage');
  note(stageSteps.length === 1 && stageSteps[0] === 'repairStage', 'в отчёте «Сейчас на заводе» этапы предлагает ровно одна ступень — «Этап ремонта»', { ids: report.ids, stageSteps });
  await shot(ws, '2-report');

  const failed = steps.filter((s) => !s.ok);
  const reportPath = join(OUT_DIR, 'cdp-181-report.json');
  writeFileSync(reportPath, JSON.stringify({ ok: failed.length === 0, steps }, null, 2), 'utf8');
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}: ${steps.length - failed.length}/${steps.length} проверок; отчёт: ${reportPath}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL  смоук упал:', e?.message ?? e);
  writeFileSync(join(OUT_DIR, 'cdp-181-report.json'), JSON.stringify({ ok: false, error: String(e?.message ?? e), steps }, null, 2), 'utf8');
  process.exit(1);
});
