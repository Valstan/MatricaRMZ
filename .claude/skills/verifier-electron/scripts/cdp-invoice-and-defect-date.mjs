// Смоук пп. 2–3 таблицы 05.10.2026 (решения владельца 07.10.2026):
//   [2] номер накладной прихода из карточки печатается в акте комплектности;
//   [3] дата этапа «Разборка/Дефектовка», поставленного ВНЕ акта, подставляется в поле
//       «Дата разборки/дефектовки» листа — и НИЧЕГО не проводит: дата осмотра и версии
//       дефектовки остаются как были (проведение — отдельные действия).
//
// Без Page.reload (на PC79 перезагрузка рендерит заново и роняет прогон — грабля стенда):
// порядок один на сессию — вход → фикстура → карточка → проверки → уборка.
// Вход суперадмином: смоук про печать и подстановку, а не про права (для прав есть
// отдельный смоук cdp-stage-from-card-date).
//
// Запуск: стек поднят с -Cdp, `node .verifier-electron/cdp-invoice-and-defect-date.mjs`.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
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
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000);
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
  const vis = (sel, root) => [...(root ?? document).querySelectorAll(sel)].filter(visible);
  const byText = (label, root) => vis('button', root).find((b) => txt(b).includes(label));
  const byExact = (label, root) => vis('button', root).find((b) => txt(b) === label);
  const call = (p, ms = 15000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  // Поле по точной подписи: строка card-row несёт подпись и контрол внутри себя.
  const fieldByLabel = (labelText, root) => {
    const rootEl = root ?? activePane();
    const label = [...rootEl.querySelectorAll('label, div, span')]
      .filter(visible)
      .find((el) => txt(el) === labelText || txt(el) === labelText + ' *');
    if (!label) return null;
    let box = label;
    for (let i = 0; i < 6 && box; i++) {
      const inp = [...box.querySelectorAll('input, textarea, select')].filter(visible)[0];
      if (inp) return inp;
      box = box.parentElement;
    }
    return null;
  };
  const TEST_ENGINE = 'TEST-001';
  const findEngine = async () => {
    const rows = await call(window.matrica.engines.list());
    const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
    return list.find((e) => String(e.engineNumber) === TEST_ENGINE) ?? list[0] ?? null;
  };
  const stageList = async (engineId) => {
    const r = await call(window.matrica.workSheets.stages.list(String(engineId)));
    return r?.ok ? r.rows : null;
  };
  const printSpy = () => {
    if (window.__printSpyPatched) return;
    window.__printSpyPatched = true;
    window.__printSpyHtml = null;
    window.open = function () {
      return {
        document: {
          open: () => {},
          write: (h) => { window.__printSpyHtml = String(h); },
          close: () => {},
          getElementById: () => null,
        },
        focus: () => {},
        print: () => {},
      };
    };
  };
`;

async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${HELPERS} ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return result.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitVal(ws, expr, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await evaluate(ws, `return ${expr};`);
      if (last) return last;
    } catch {
      /* страница бывает в переходе — короткие повторы со стороны драйвера */
    }
    await sleep(400);
  }
  return last;
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/invdef-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}
async function openSection(ws, group, item) {
  await evaluate(ws, `await dismissModals(); return true;`);
  const r = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const g = [...ov.querySelectorAll('button')].find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith(${JSON.stringify(group)}));
     if (!g) return { ok: false, reason: 'группа не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).endsWith(${JSON.stringify(item)}) && x !== g);
     if (!it) return { ok: false, reason: 'пункт не найден' };
     it.click(); await wait(1500);
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

const INVOICE = 'НК-СМУК-777';
const STAGE_DAY = '2026-10-06';

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `await dismissModals();
     const inputs = vis('input');
     const p = inputs.find((i) => i.type === 'password');
     const u = inputs.find((i) => i.type !== 'password');
     if (p && u) {
       setVal(u, 'valstan'); await wait(300);
       setVal(p, 'valstan-dev'); await wait(300);
       const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
       if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
       click(btn); await wait(4500);
     }
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход (valstan/superadmin)', login);
  if (!login.ok) throw new Error('логин не прошёл');

  const warmed = await waitVal(
    ws,
    `(async () => { const rows = await call(window.matrica.engines.list()); const list = Array.isArray(rows) ? rows : (rows?.rows ?? []); return list.length > 0; })()`,
    'двигатели приехали',
    90000,
  );
  note(warmed === true, 'каталог двигателей загружен', { warmed });
  if (!warmed) throw new Error('каталог не приехал');

  /* ── Фикстура: этап дефектовки есть, поле листа и накладная — пустые ──────────────── */
  const fixture = await evaluate(
    ws,
    `const eng = await findEngine();
     if (!eng) return { ok: false, reason: 'двигателя нет' };
     const rows = (await stageList(String(eng.id))) ?? [];
     for (const row of rows.filter((x) => x.code === 'disassembly_defect')) {
       await call(window.matrica.workSheets.stages.remove(row.id));
     }
     const atMs = new Date(${JSON.stringify(STAGE_DAY)} + 'T00:00:00').getTime();
     const saved = await call(window.matrica.workSheets.stages.save({ id: crypto.randomUUID(), engineId: String(eng.id), code: 'disassembly_defect', atMs }));
     if (saved?.ok === false) return { ok: false, error: saved.error };
     const cur = await call(window.matrica.checklists.engineGet({ engineId: String(eng.id), stage: 'engine_inventory' }));
     if (cur?.payload) {
       const answers = { ...(cur.payload.answers ?? {}) };
       delete answers.defect_start_date;
       await call(window.matrica.checklists.engineSave({ engineId: String(eng.id), stage: 'engine_inventory', templateId: cur.payload.templateId, operationId: cur.operationId, answers }));
     }
     await call(window.matrica.engines.card.save({ id: String(eng.id), fields: { arrival_invoice: null } }).catch(() => null));
     const ver = await call(window.matrica.warehouse.defectVersions(String(eng.id)));
     const active = ver?.ok ? (ver.versions ?? []).filter((v) => v.status === 'active').length : 0;
     const after = await call(window.matrica.checklists.engineGet({ engineId: String(eng.id), stage: 'engine_inventory' }));
     return { ok: true, engineId: String(eng.id), activeVersions: active, inspectionBefore: after?.payload?.answers?.completeness_inspection_date?.value ?? null };`,
  );
  note(fixture.ok, 'фикстура: этап поставлен, поле листа и накладная очищены', fixture.ok ? fixture : fixture);
  if (!fixture.ok) throw new Error('фикстура не прошла');

  /* ── Открываем карточку (вкладка «Основное») ─────────────────────────────────────── */
  await openSection(ws, 'Производство', 'Двигатели');
  await waitVal(ws, `vis('tbody tr').length > 0`, 'список двигателей');
  const opened = await evaluate(
    ws,
    `const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     const s = vis('input').find((i) => /поиск/i.test(i.placeholder || ''));
     if (s) { set.call(s, 'TEST-001'); s.dispatchEvent(new Event('input', { bubbles: true })); await wait(1400); }
     const tr = [...vis('tbody tr')].find((r) => txt(r).includes('TEST-001')) ?? vis('tbody tr').find((r) => r.querySelectorAll('td').length > 1);
     if (!tr) return { ok: false, reason: 'строки нет' };
     click(tr); await wait(3000);
     const tab = byExact('Основное');
     if (tab) { click(tab); await wait(900); }
     return { ok: true };`,
  );
  note(opened.ok, 'карточка двигателя открыта («Основное»)', opened.ok ? undefined : opened);
  if (!opened.ok) throw new Error('карточка не открылась');
  await evaluate(ws, `printSpy(); return true;`);

  /* ── [2] Накладная: вводим, сохраняем, печатаем акт комплектности ────────────────── */
  const savedInvoice = await evaluate(
    ws,
    `const inp = fieldByLabel('Номер накладной (приход)');
     if (!inp) return { ok: false, reason: 'поля накладной нет' };
     setVal(inp, ${JSON.stringify(INVOICE)}); await wait(500);
     const btn = byExact('Сохранить') ?? byText('Сохранить');
     if (!btn) return { ok: false, reason: 'кнопки сохранения нет' };
     click(btn); await wait(3200);
     const card = await call(window.matrica.engines.card.get(${JSON.stringify(fixture.engineId)}));
     return { ok: card?.row?.arrival_invoice === ${JSON.stringify(INVOICE)}, value: card?.row?.arrival_invoice ?? null };`,
  );
  note(savedInvoice.ok, 'накладная прихода сохранена в карточке', savedInvoice);
  if (!savedInvoice.ok) throw new Error('накладная не сохранилась');

  const printAction = await evaluate(
    ws,
    `const tab = byExact('Акт комплектности');
     if (!tab) return { ok: false, reason: 'вкладки «Акт комплектности» нет' };
     click(tab); await wait(1800);
     const printBtn = byText('Печать акта комплектности');
     if (!printBtn) return { ok: false, reason: 'кнопки печати нет' };
     click(printBtn); await wait(2800);
     return { ok: true, hasHtml: Boolean(window.__printSpyHtml) };`,
  );
  note(printAction.ok && printAction.hasHtml, 'печать акта комплектности вызвана, HTML получен', printAction);
  const printed = await evaluate(
    ws,
    `return window.__printSpyHtml ? { hasLabel: window.__printSpyHtml.includes('Номер накладной (приход)'), hasValue: window.__printSpyHtml.includes(${JSON.stringify(INVOICE)}) } : null;`,
  );
  note(printed?.hasLabel === true && printed?.hasValue === true, 'в печатном акте есть «Номер накладной (приход)» с номером', printed);
  await shot(ws, '1-act-printed');

  /* ── [3] Дата этапа дефектовки доезжает до поля листа (вкладка дефектовки) ────────── */
  const defectTab = await evaluate(
    ws,
    `const tab = byExact('Акт разборки/дефектовки');
     if (!tab) return { ok: false, reason: 'вкладки дефектовки нет' };
     click(tab); await wait(1800);
     return { ok: true };`,
  );
  note(defectTab.ok, 'вкладка «Акт разборки/дефектовки» открыта', defectTab.ok ? undefined : defectTab);
  // Дата дефектовки лежит в блоке «Оформление», а он свёрнут по умолчанию (D1):
  // раскрываем по якорю секции перед поиском поля.
  await evaluate(
    ws,
    `const sec = vis('[data-act-section="Оформление"]')[0];
     if (sec) {
       const btn = sec.querySelector('button');
       if (btn && btn.getAttribute('aria-expanded') === 'false') { click(btn); await wait(1000); }
     }
     return true;`,
  );
  const dateField = await waitVal(
    ws,
    `(async () => {
       const inp = fieldByLabel('Дата разборки/дефектовки');
       return inp && inp.value ? { value: inp.value } : null;
     })()`,
    'поле даты дефектовки заполнено',
    25000,
  );
  note(Boolean(dateField), 'поле «Дата разборки/дефектовки» заполнено подстановкой', dateField);
  // Поле отдаёт дату в экранном формате (ДД.ММ.ГГГГ), эталон — ISO: нормализуем обе стороны.
  const normDay = (v) => {
    const s = String(v ?? '').trim();
    const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
  };
  note(normDay(dateField?.value) === STAGE_DAY, 'дата этапа подставлена в поле листа', { field: dateField?.value ?? null, expected: STAGE_DAY });
  await shot(ws, '2-defect-date-field');

  /* ── [3] Ничего не проведено ─────────────────────────────────────────────────────── */
  const after = await evaluate(
    ws,
    `const cur = await call(window.matrica.checklists.engineGet({ engineId: ${JSON.stringify(fixture.engineId)}, stage: 'engine_inventory' }));
     const ver = await call(window.matrica.warehouse.defectVersions(${JSON.stringify(fixture.engineId)}));
     const active = ver?.ok ? (ver.versions ?? []).filter((v) => v.status === 'active').length : -1;
     return { inspection: cur?.payload?.answers?.completeness_inspection_date?.value ?? null, activeVersions: active };`,
  );
  note(
    (after?.inspection ?? null) === (fixture.inspectionBefore ?? null),
    'дата осмотра не изменилась — подстановка акт не проводит',
    { before: fixture.inspectionBefore, after: after?.inspection },
  );
  note(
    (after?.activeVersions ?? -1) === (fixture.activeVersions ?? 0),
    'версий дефектовки не прибавилось — проведение не состоялось',
    { before: fixture.activeVersions, after: after?.activeVersions },
  );

  /* ── Уборка: этап, поле листа, накладная ─────────────────────────────────────────── */
  const cleanup = await evaluate(
    ws,
    `const rows = (await stageList(${JSON.stringify(fixture.engineId)})) ?? [];
     const removed = [];
     for (const row of rows.filter((x) => x.code === 'disassembly_defect')) {
       const del = await call(window.matrica.workSheets.stages.remove(row.id));
       removed.push(del?.ok !== false);
     }
     const cur = await call(window.matrica.checklists.engineGet({ engineId: ${JSON.stringify(fixture.engineId)}, stage: 'engine_inventory' }));
     if (cur?.payload) {
       const answers = { ...(cur.payload.answers ?? {}) };
       delete answers.defect_start_date;
       await call(window.matrica.checklists.engineSave({ engineId: ${JSON.stringify(fixture.engineId)}, stage: 'engine_inventory', templateId: cur.payload.templateId, operationId: cur.operationId, answers }));
     }
     await call(window.matrica.engines.card.save({ id: ${JSON.stringify(fixture.engineId)}, fields: { arrival_invoice: null } }).catch(() => null));
     return { removed };`,
  );
  note((cleanup.removed ?? []).every(Boolean) !== false, 'уборка: этап снят, поле и накладная очищены', cleanup);

  const failed = steps.filter((s) => !s.ok);
  const report = { ok: failed.length === 0, steps };
  writeFileSync(`${OUT_DIR}/cdp-invoice-and-defect-date-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n${failed.length === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} — ${steps.length - failed.length}/${steps.length}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('DRIVER ERROR:', String(e?.message ?? e));
  writeFileSync(`${OUT_DIR}/cdp-invoice-and-defect-date-report.json`, JSON.stringify({ ok: false, error: String(e?.message ?? e), steps }, null, 2));
  process.exit(2);
});
