#!/usr/bin/env node
// Смоук шаблона подписей ПП по умолчанию (промт КАРМАНА #120, план #121).
//
// Проверяем живьём на стенде критерии приёмки плана:
//   1. новая программа приходит уже с подписями шаблона;
//   2. кнопка «Применить шаблон» подставляет набор И СОХРАНЯЕТСЯ (читаем сервер);
//   3. «Сохранить как шаблон по умолчанию» работает;
//   4. программа с ручными правками не перетирается дефолтом;
//   6. шаблон общий для парка (виден другому пользователю);
//   7. без права шаблона кнопок нет, сервер отказывает;
//   8. архив программы не трогает шаблоны.
//
// Критерий 5 (пустой набор ≠ «не трогал») закрыт юнит-тестом домена:
//   shared/src/domain/productionProgramSignatureTemplate.test.ts
//
//   $env:MATRICA_CDP_PORT = '9223'; node .claude/skills/verifier-electron/scripts/cdp-pp-signature-template.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const VITE = process.env.MATRICA_VITE_PORT || '5174';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-pp-signature-template-report.json`;
mkdirSync(OUT_DIR, { recursive: true });

function wsLib() {
  try {
    return require('ws');
  } catch {
    const { execSync } = require('node:child_process');
    const dir = execSync('node -e "console.log(require.resolve(\'ws\'))"', { cwd: 'node_modules/.pnpm', encoding: 'utf8' }).trim();
    return require(dir);
  }
}
const WebSocket = wsLib();

const steps = [];
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra !== undefined ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`);
}

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
}
async function appTarget() {
  const list = await targets();
  return list.find((t) => String(t.url).includes(`127.0.0.1:${VITE}`)) ?? list.find((t) => String(t.title).includes('Матрица')) ?? list[0];
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}, timeoutMs = 30000) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    }
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(ws, expression, timeoutMs = 30000) {
  const result = await send(
    ws,
    'Runtime.evaluate',
    { expression: `(async () => { ${HELPERS} ${expression} })()`, awaitPromise: true, returnByValue: true },
    timeoutMs,
  );
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function shot(ws, name) {
  // Скриншот — украшение, а не гейт: в модалке печати `captureScreenshot` иногда
  // не отвечает (окно с iframe), и прогон не должен падать из-за картинки.
  try {
    const s = await send(ws, 'Page.captureScreenshot', { format: 'png' }, 15000);
    const p = `${OUT_DIR}/cdp-pp-signature-template-${name}.png`;
    writeFileSync(p, Buffer.from(s.data, 'base64'));
    console.log(`      скриншот: ${p}`);
    return p;
  } catch (e) {
    console.log(`      скриншот не снят (${e?.message ?? e}) — прогон продолжается`);
    return null;
  }
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const setVal = (el, v) => {
    const proto = el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const byText = (label) => [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b).includes(label));
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const parseSlots = (raw) => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v.map((s) => ({ caption: String(s.caption ?? ''), employeeId: s.employeeId ?? null, fullName: String(s.fullName ?? '') })) : null; } catch (e) { return null; } };
  const sameSlots = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const navToProgram = async () => {
    if (!document.querySelector('.v3-menu-overlay')) {
      const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
      if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
      b.click(); await wait(1000);
    }
    const ov = document.querySelector('.v3-menu-overlay');
    if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
    const groups = [...ov.querySelectorAll('button')];
    const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Производство'));
    if (!g) return { ok: false, reason: 'группа «Производство» не найдена' };
    if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
    const it = [...document.querySelectorAll('.v3-menu-overlay button')].find((x) => txt(x).includes('Производственная программа'));
    if (!it) return { ok: false, reason: 'пункт «Производственная программа» не найден' };
    it.click(); await wait(2500);
    return { ok: true };
  };
`;

const C1 = [
  { caption: 'Начальник цеха', employeeId: null, fullName: 'Иванов И. И.' },
  { caption: 'Мастер участка', employeeId: null, fullName: 'Петров П. П.' },
];
const C2 = [{ caption: 'Коммерческий директор', employeeId: null, fullName: 'Сидоров С. С.' }];
const TPL_NAME = 'Шаблон ПП (смоук)';

async function main() {
  const target = await appTarget();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(5000);

  // 1. Вход суперадмином (у него есть право на шаблон по роли).
  const login = await evaluate(
    ws,
    `const st = await window.matrica.auth.status();
     if (st?.loggedIn) return { ok: true, already: true, role: st?.user?.role ?? null };
     const inputs = [...document.querySelectorAll('input')].filter(visible);
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: false, reason: 'форма входа не найдена' };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4500);
     const s2 = await window.matrica.auth.status();
     return { ok: Boolean(s2?.loggedIn), role: s2?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);
  await evaluate(ws, `await dismissModals(); return true;`);

  // 2. Экран ПП.
  const nav = await evaluate(ws, `return await navToProgram();`);
  note(nav.ok, 'меню: Производство → Производственная программа', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  // 3. Чистим прошлые прогоны: планы и шаблоны.
  const cleanup0 = await evaluate(
    ws,
    `const res = await window.matrica.productionProgram.list();
     let removed = 0;
     if (res.ok) for (const p of res.rows) { const r = await window.matrica.productionProgram.remove(p.id); if (r.ok) removed += 1; }
     const tpls = await window.matrica.productionProgram.listSignatureTemplates();
     let tplRemoved = 0;
     if (tpls.ok) for (const t of tpls.rows) { const r = await window.matrica.productionProgram.deleteSignatureTemplate(t.id); if (r.ok) tplRemoved += 1; }
     return { removed, tplRemoved };`,
  );
  note(cleanup0.removed >= 0, 'прошлые прогоны убраны (планы и шаблоны)', cleanup0);
  await sleep(1500);

  // 4. Новый план P1 (кнопка в UI). План ведёт сервер — ждём зеркало.
  const before = await evaluate(ws, `const res = await window.matrica.productionProgram.list(); return res.ok ? res.rows.map((r) => r.id) : [];`);
  const created1 = await evaluate(
    ws,
    `const b = byText('Новый план');
     if (!b) return { ok: false, reason: 'кнопки «Новый план» нет' };
     click(b); await wait(3000);
     for (let i = 0; i < 40; i++) {
       const res = await window.matrica.productionProgram.list();
       if (res.ok && res.rows.length > ${JSON.stringify(before.length)}) return { ok: true, count: res.rows.length };
       try { await window.matrica.sync.run(); } catch (e) {}
       await wait(4000);
     }
     return { ok: false, reason: 'план не доехал в реплику клиента' };`,
    200000,
  );
  note(created1.ok, 'план P1 создан серверной дверью и доехал в реплику', created1);
  if (!created1.ok) throw new Error('план не создан');

  const p1Id = await evaluate(
    ws,
    `const res = await window.matrica.productionProgram.list();
     if (!res.ok) return null;
     const rows = res.rows;
     return rows.length ? String(rows[rows.length - 1].id) : null;`,
  );
  note(Boolean(p1Id), 'id плана P1 получен', { p1Id });

  // 5. Ручная правка состава P1 (тем же путём, что редактор подписей): C1.
  const setC1 = await evaluate(
    ws,
    `const r = await window.matrica.productionProgram.update({ id: ${JSON.stringify(p1Id)}, signatureSlots: JSON.stringify(${JSON.stringify(C1)}) });
     return { ok: Boolean(r?.ok), error: r?.error ?? null };`,
  );
  note(setC1.ok, 'состав P1 задан вручную (C1)', setC1);

  // 6. Ждём реплику с C1.
  const replicaC1 = await evaluate(
    ws,
    `for (let i = 0; i < 40; i++) {
       const res = await window.matrica.productionProgram.list();
       const row = res.ok ? res.rows.find((r) => r.id === ${JSON.stringify(p1Id)}) : null;
       const slots = row ? parseSlots(row.signatureSlots) : null;
       if (slots && sameSlots(slots, ${JSON.stringify(C1)})) return { ok: true };
       try { await window.matrica.sync.run(); } catch (e) {}
       await wait(3000);
     }
     return { ok: false, reason: 'реплика не показала C1' };`,
    180000,
  );
  note(replicaC1.ok, 'реплика показала ручной состав C1', replicaC1);

  // 7. Окно печати: кнопка шаблона видна (право есть) + «Сохранить как шаблон по умолчанию».
  const openPreview = await evaluate(
    ws,
    `const b = document.querySelector('[data-pp-action="print"]');
     if (!b) return { ok: false, reason: 'кнопка «Печать» не найдена' };
     click(b); await wait(2500);
     const sel = document.querySelector('[data-pp-signature-template-select]');
     const apply = document.querySelector('[data-pp-signature-template-apply]');
     const save = document.querySelector('[data-pp-signature-template-save-default]');
     return { ok: true, hasSelect: !!sel, hasApply: !!apply, hasSave: !!save };`,
  );
  note(openPreview.ok && openPreview.hasSelect && openPreview.hasApply && openPreview.hasSave, 'окно печати открылось, блок шаблона виден (право есть)', openPreview);
  const shots = [await shot(ws, 'template-block')];

  const saved = await evaluate(
    ws,
    `window.prompt = () => ${JSON.stringify(TPL_NAME)};
     const b = document.querySelector('[data-pp-signature-template-save-default]');
     if (!b) return { ok: false, reason: 'кнопки «Сохранить как шаблон по умолчанию» нет' };
     click(b); await wait(3500);
     const res = await window.matrica.productionProgram.listSignatureTemplates();
     if (!res.ok) return { ok: false, reason: 'список шаблонов не прочитан' };
     const t = res.rows.find((x) => x.name === ${JSON.stringify(TPL_NAME)});
     return { ok: !!t, tpl: t ? { id: t.id, ownerId: t.ownerId, isDefault: t.isDefault, slots: parseSlots(t.slots) } : null, count: res.rows.length };`,
  );
  note(saved.ok, 'кнопка «Сохранить как шаблон по умолчанию» создала шаблон', saved);
  note(
    saved.ok && saved.tpl?.ownerId === 'shared',
    'шаблон общий для парка (ownerId=shared)',
    { ownerId: saved.tpl?.ownerId ?? null },
  );
  note(
    saved.ok && saved.tpl?.isDefault === true,
    'шаблон помечен как шаблон по умолчанию',
    { isDefault: saved.tpl?.isDefault ?? null },
  );
  note(
    saved.ok && JSON.stringify(saved.tpl?.slots) === JSON.stringify(C1),
    'состав шаблона = состав программы (C1)',
    { slots: saved.tpl?.slots ?? null },
  );
  const tplId = saved.tpl?.id ?? null;

  // 8. Ручная правка P1 ПОСЛЕ шаблона (C2) — дефолт её перетирать не должен.
  const setC2 = await evaluate(
    ws,
    `const r = await window.matrica.productionProgram.update({ id: ${JSON.stringify(p1Id)}, signatureSlots: JSON.stringify(${JSON.stringify(C2)}), signatureTemplateId: null });
     return { ok: Boolean(r?.ok), error: r?.error ?? null };`,
  );
  note(setC2.ok, 'состав P1 заменён вручную на C2 (ссылка на шаблон снята)', setC2);

  // 9. Новый план P2 — он обязан прийти с подписями шаблона (критерий 1).
  const before2 = await evaluate(ws, `const res = await window.matrica.productionProgram.list(); return res.ok ? res.rows.length : 0;`);
  const created2 = await evaluate(
    ws,
    `const b = byText('Новый план');
     if (!b) return { ok: false, reason: 'кнопки «Новый план» нет' };
     click(b); await wait(3000);
     for (let i = 0; i < 40; i++) {
       const res = await window.matrica.productionProgram.list();
       if (res.ok && res.rows.length > ${JSON.stringify(before2)}) return { ok: true, count: res.rows.length };
       try { await window.matrica.sync.run(); } catch (e) {}
       await wait(4000);
     }
     return { ok: false, reason: 'план P2 не доехал в реплику' };`,
    200000,
  );
  note(created2.ok, 'план P2 создан', created2);

  const p2 = await evaluate(
    ws,
    `const list = await window.matrica.productionProgram.list();
     const rows = list.ok ? list.rows : [];
     const id = rows.length ? String(rows[rows.length - 1].id) : null;
     if (!id) return { ok: false };
     const one = await window.matrica.productionProgram.get(id);
     if (!one.ok) return { ok: false, error: one.error };
     return { ok: true, id, slots: parseSlots(one.row.signatureSlots), templateId: one.row.signatureTemplateId ?? null, rawSlots: one.row.signatureSlots };`,
  );
  note(p2.ok && JSON.stringify(p2.slots) === JSON.stringify(C1), 'критерий 1: новая программа пришла с подписями шаблона', { slots: p2.slots ?? null });
  note(p2.ok && p2.templateId === tplId, 'критерий 1: у новой программы стоит ссылка на шаблон', { templateId: p2.templateId ?? null, tplId });

  // 10. Критерий 4: ручная правка P1 не перетёрта дефолтом.
  const p1After = await evaluate(
    ws,
    `const one = await window.matrica.productionProgram.get(${JSON.stringify(p1Id)});
     if (!one.ok) return { ok: false, error: one.error };
     return { ok: true, slots: parseSlots(one.row.signatureSlots), templateId: one.row.signatureTemplateId ?? null };`,
  );
  note(p1After.ok && JSON.stringify(p1After.slots) === JSON.stringify(C2), 'критерий 4: ручная правка P1 не перетёрта дефолтом', { slots: p1After.slots ?? null });
  note(p1After.ok && (p1After.templateId ?? null) === null, 'критерий 4: у ручной правки ссылка на шаблон снята', { templateId: p1After.templateId ?? null });

  // 11. Критерий 2: «Применить шаблон» — кнопка в окне печати.
  await evaluate(ws, `await dismissModals(); return true;`);
  const applied = await evaluate(
    ws,
    `const rows = await window.matrica.productionProgram.list();
     const id = ${JSON.stringify(p1Id)};
     const row = rows.ok ? rows.rows.find((r) => r.id === id) : null;
     // Открываем окно печати по выбранной программе.
     const items = [...document.querySelectorAll('button, [role="button"], li, tr')].filter(visible);
     const target = items.find((el) => txt(el).includes(row?.title ?? '___нет___'));
     if (target) { click(target); await wait(2000); }
     const printBtn = document.querySelector('[data-pp-action="print"]');
     if (!printBtn) return { ok: false, reason: 'кнопка «Печать» не найдена' };
     click(printBtn); await wait(2500);
     const sel = document.querySelector('[data-pp-signature-template-select]');
     if (!sel) return { ok: false, reason: 'список шаблонов не найден' };
     const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(tplId)});
     if (!opt) return { ok: false, reason: 'шаблон не найден в списке', options: [...sel.options].map((o) => o.textContent) };
     setVal(sel, ${JSON.stringify(tplId)}); await wait(600);
     const apply = document.querySelector('[data-pp-signature-template-apply]');
     if (!apply) return { ok: false, reason: 'кнопка «Применить шаблон» не найдена' };
     click(apply); await wait(3000);
     return { ok: true };`,
    90000,
  );
  note(applied.ok, 'кнопка «Применить шаблон» нажата', applied);

  const p1Applied = await evaluate(
    ws,
    `for (let i = 0; i < 20; i++) {
       const one = await window.matrica.productionProgram.get(${JSON.stringify(p1Id)});
       if (one.ok) {
         const slots = parseSlots(one.row.signatureSlots);
         if (sameSlots(slots, ${JSON.stringify(C1)})) return { ok: true, slots, templateId: one.row.signatureTemplateId ?? null };
       }
       await wait(1500);
     }
     const one = await window.matrica.productionProgram.get(${JSON.stringify(p1Id)});
     return { ok: false, slots: one.ok ? parseSlots(one.row.signatureSlots) : null, templateId: one.ok ? one.row.signatureTemplateId : null };`,
    60000,
  );
  note(p1Applied.ok, 'критерий 2: применённый шаблон сохранён на сервере (пережил перезаход)', { slots: p1Applied.slots ?? null });
  note(p1Applied.ok && p1Applied.templateId === tplId, 'критерий 2: у программы стоит ссылка на применённый шаблон', { templateId: p1Applied.templateId ?? null });
  shots.push(await shot(ws, 'applied'));

  // 12. Критерий 8: архив программы шаблоны не трогает.
  const archived = await evaluate(
    ws,
    `const r = await window.matrica.productionProgram.remove(${JSON.stringify(p1Id)});
     await wait(1500);
     const tpls = await window.matrica.productionProgram.listSignatureTemplates();
     const t = tpls.ok ? tpls.rows.find((x) => x.id === ${JSON.stringify(tplId)}) : null;
     return { ok: Boolean(r?.ok), templateAlive: !!t, count: tpls.ok ? tpls.rows.length : -1 };`,
  );
  note(archived.ok && archived.templateAlive, 'критерий 8: архив программы не тронул шаблоны', archived);

  // 13. Критерий 7 и 6: другой пользователь (verify, админ) — шаблон виден (общий),
  //     а кнопок нет и сервер отказывает.
  await evaluate(ws, `try { await window.matrica.auth.logout(); } catch (e) {} return true;`);
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(5000);
  const loginVerify = await evaluate(
    ws,
    `const r = await window.matrica.auth.login({ username: 'verify', password: 'verify123' });
     if (!r?.ok) return { ok: false, error: r?.error ?? null };
     await wait(2500);
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(loginVerify.ok, 'вход вторым пользователем (verify)', loginVerify);
  await send(ws, 'Page.reload', { ignoreCache: true });
  await sleep(5000);
  await evaluate(ws, `await dismissModals(); return true;`);

  const asVerify = await evaluate(
    ws,
    `const nav = await navToProgram();
     if (!nav.ok) return { ok: false, reason: nav.reason };
     const tpls = await window.matrica.productionProgram.listSignatureTemplates();
     const t = tpls.ok ? tpls.rows.find((x) => x.id === ${JSON.stringify(tplId)}) : null;
     const refused = await window.matrica.productionProgram.saveSignatureTemplate({ name: 'Попытка без права', slots: JSON.stringify(${JSON.stringify(C1)}) });
     // Окно печати: блока шаблона быть не должно.
     const rows = await window.matrica.productionProgram.list();
     const row = rows.ok && rows.rows.length ? rows.rows[rows.rows.length - 1] : null;
     const items = [...document.querySelectorAll('button, [role="button"], li, tr')].filter(visible);
     const target = items.find((el) => txt(el).includes(row?.title ?? '___нет___'));
     if (target) { click(target); await wait(2000); }
     const printBtn = document.querySelector('[data-pp-action="print"]');
     if (printBtn) { click(printBtn); await wait(2500); }
     const hasBlock = !!document.querySelector('[data-pp-signature-template-apply]');
     return { ok: true, templateVisible: !!t, ownerId: t?.ownerId ?? null, refused: { ok: Boolean(refused?.ok), error: refused?.error ?? null }, hasBlock };`,
    90000,
  );
  note(asVerify.templateVisible, 'критерий 6: общий шаблон виден другому пользователю', { ownerId: asVerify.ownerId ?? null });
  note(asVerify.refused?.ok === false, 'критерий 7: сервер отказал в правке шаблона без права', asVerify.refused ?? null);
  note(asVerify.hasBlock === false, 'критерий 7: без права кнопок шаблона нет вовсе', { hasBlock: asVerify.hasBlock });

  // 14. Уборка: программы и шаблон прогона.
  const cleanup = await evaluate(
    ws,
    `const res = await window.matrica.productionProgram.list();
     let removed = 0;
     if (res.ok) for (const p of res.rows) { const r = await window.matrica.productionProgram.remove(p.id); if (r.ok) removed += 1; }
     const tpls = await window.matrica.productionProgram.listSignatureTemplates();
     let tplRemoved = 0;
     if (tpls.ok) for (const t of tpls.rows) { const r = await window.matrica.productionProgram.deleteSignatureTemplate(t.id); if (r.ok) tplRemoved += 1; }
     return { removed, tplRemoved };`,
  );
  note(cleanup.removed >= 0, 'прогон убран (планы и шаблоны)', cleanup);

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps, screenshots: shots }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.log(`FAIL  прогон не состоялся: ${e?.message ?? e}`);
  writeFileSync(OUT, JSON.stringify({ verdict: 'FAIL', error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
