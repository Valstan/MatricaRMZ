// Смоук Кладовщика (СИЗ), фаза 2 + шов сотрудников (PR-6).
//
// Что держит — свойства, а не клики:
//
//  [1] фикстуры-позиции заводит сам через мост: ботинки с размерным рядом (44/46)
//      и перчатки без ряда. Строгая дверь создания спрашивает источник, группу,
//      единицу и шаблон — группа/единица/шаблон берутся у живой позиции справочника,
//      поэтому прогон самодостаточен и не привязан к именам прод-данных;
//  [2] импорт ЗУП через страницу: файл в настоящий `<input type=file>`, «Проверить
//      файл» → план без конфликтов; строка «размер 42 у позиции без размерного
//      ряда» обещана предупреждением и БЕЗ конфликта (preview и apply обязаны
//      говорить одно — общее правило resolveIssueNomenclature); «Применить» →
//      подтверждение → итог: сотрудники заведены, выдачи созданы;
//  [3] ГЛАВНОЕ: сотрудники импорта видны в реплике (`ppe.employees.list`) — их нет
//      в EAV, только в `erp_employee_cards`; раньше пикеры брали EAV, и модуль падал
//      «Сотрудник не найден» на первой выдаче;
//  [4] пикер страницы «Карточки СИЗ» показывает импортированного (читает реплику);
//      карточка на него открывается штатным путём страницы;
//  [5] склад: приход на выбранные позиции (иначе выдача не проведётся — проводка
//      блокирует уход в минус), затем карточка: норма назначена, отпуск добавлен,
//      выдача проведена — сотрудник проходит строгую проверку на каждом шаге;
//  [6] группа: состав из реплики принимается строгой дверью; нормы группы видны
//      через `employees.normSets` (транзитивная видимость);
//  [7] коллективная: открытие и распределение на импортированного сотрудника;
//  [8] отчёты: «Сводная ведомость СИЗ» рисует ФИО из реплики (тот же источник,
//      что у пикеров); реплика догоняет пинком импорта и тиком ≤60 с — ждём.
//  [9] негативный случай: файл с конфликтом (пустое ФИО) — применение НЕ отклоняется
//      целиком: диалог честно называет строки, которые будут пропущены, а итог
//      называет их число («Строк с проблемами не импортировано: N»). Молчаливая
//      пропажа строк и отказ на весь файл — обе крайности, которых быть не должно.
//
// Синтетика: табельные 90991–90993, имена «СМОК …» — реальных людей в фикстурах
// нет. Повторный прогон безопасен: сотрудники обновятся, выдачи признаются
// дублями, группа/нормы/коллективная переиспользуются, приход добавит остаток.
//
// Запуск: стек поднят с -Cdp, `node .claude/skills/verifier-electron/scripts/cdp-ppe-phase2.mjs`
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

function extLib(name, cwd) {
  try {
    return require(name);
  } catch {
    const { execSync } = require('node:child_process');
    const file = execSync(`node -e "console.log(require.resolve('${name}'))"`, { cwd, encoding: 'utf8' }).trim();
    return require(file);
  }
}
const ExcelJS = extLib('exceljs', 'backend-api');

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
  return new Promise((resolve2, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve2(ws));
    ws.on('error', reject);
  });
}
let msgId = 0;
function send(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve2, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 120000);
    function onMessage(raw) {
      const msg = JSON.parse(raw.toString());
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve2(msg.result);
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
  const call = (p, ms = 20000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('мост не ответил')), ms))]);
  const activePane = () => vis('.v3-tab-pane[data-pane-active="1"]')[0] ?? document;
  // Та же нормализация, что normalizeLookupCompact в shared: по ней ищется размер
  // среди вариантов и склеиваются артикулы при сопоставлении импорта.
  const compact = (v) => String(v || '').toLowerCase().replace(/ё/g, 'е').replace(/["'\`.,;:!?()[\\]{}<>/\\\\|+-]+/g, ' ').replace(/\\s+/g, '');
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = byText('За работу!') ?? byText('Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
  const pickOption = async (input, needle) => {
    if (!input) return { ok: false, reason: 'нет инпута пикера' };
    for (let i = 0; i < 2 && !vis('[data-entity-lookup-popup]')[0]; i++) { click(input); await wait(600); }
    let popup = vis('[data-entity-lookup-popup]')[0];
    if (!popup || !txt(popup).includes(needle)) { setVal(input, needle); await wait(800); popup = vis('[data-entity-lookup-popup]')[0]; }
    if (!popup) return { ok: false, reason: 'попап пикера не открылся' };
    const hit = vis('[data-idx]', popup).find((el) => txt(el).includes(needle));
    if (!hit) return { ok: false, reason: 'нет строки с текстом', popup: txt(popup).slice(0, 200) };
    click(hit); await wait(700);
    return { ok: true, picked: txt(hit).slice(0, 80) };
  };
  const acceptConfirm = async (label) => {
    for (let i = 0; i < 20; i++) {
      const dlg = vis('[role=alertdialog]')[0];
      if (dlg) {
        const b = vis('button', dlg).find((x) => txt(x) === label);
        if (b) { click(b); await wait(400); return { ok: true }; }
        return { ok: false, reason: 'в диалоге нет кнопки', buttons: vis('button', dlg).map(txt) };
      }
      await wait(250);
    }
    return { ok: false, reason: 'диалог подтверждения не появился' };
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
      // страница бывает в переходе — короткие повторы со стороны драйвера
    }
    await sleep(400);
  }
  return last;
}
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/ppe-phase2-${name}.png`;
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
     const cands = [...ov.querySelectorAll('button')].filter((x) => x !== g);
     const want = ${JSON.stringify(item)};
     const it = cands.find((x) => txt(x) === want) ?? cands.find((x) => txt(x).endsWith(want));
     if (!it) return { ok: false, reason: 'пункт не найден' };
     it.click();
     for (let i = 0; i < 40 && document.querySelector('.v3-menu-overlay'); i++) await wait(250);
     if (document.querySelector('.v3-menu-overlay')) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await wait(500); }
     return { ok: true };`,
  );
  note(r.ok, `меню: ${group} → ${item}`, r.ok ? undefined : r);
  if (!r.ok) throw new Error(`навигация: ${r.reason}`);
}

// ── Фикстуры (синтетика) ─────────────────────────────────────────────────────
const EMP = [
  { no: '90991', fio: 'СМОК Тестов Один', pos: 'Слесарь' },
  { no: '90992', fio: 'СМОК Тестов Два', pos: 'Слесарь' },
  { no: '90993', fio: 'СМОК Тестов Три', pos: 'Кладовщик' },
];
const NORM_NAME = 'СМОК Нормы летние (смоук)';
const GROUP_NAME = 'СМОК Бригада (смоук)';
const COLLECTIVE_ID = '9a1e2c3d-4b5f-4a67-8c9d-0e1f2a3b4c5d';
const DEFAULT_WH = '00000000-0000-0000-0000-000000000001';
const EMP_HEADER = ['Табельный номер', 'ФИО', 'Должность', 'Подразделение', 'Пол', 'Дата рождения', 'Дата приёма', 'Дата увольнения', 'Отпуск с', 'Отпуск по'];
const ISS_HEADER = ['Таб. №', 'Номенклатура', 'Артикул', 'Размер', 'Кол-во', 'Дата'];

async function buildFixture(deptName, picks, broken = false) {
  const wb = new ExcelJS.Workbook();
  const k = wb.addWorksheet('Кадры');
  k.addRow(EMP_HEADER);
  k.addRow([EMP[0].no, EMP[0].fio, EMP[0].pos, deptName, 'М', '01.02.1990', '10.01.2020', '', '', '']);
  // Негативный случай: пустое ФИО — строка с конфликтом (применение обязано отказать целиком).
  k.addRow([EMP[1].no, broken ? '' : EMP[1].fio, EMP[1].pos, deptName, 'Ж', '02.03.1991', '11.02.2021', '', '01.07.2026', '15.07.2026']);
  k.addRow([EMP[2].no, EMP[2].fio, EMP[2].pos, deptName, 'М', '03.04.1992', '12.03.2022', '', '', '']);
  const v = wb.addWorksheet('Выдачи');
  v.addRow(ISS_HEADER);
  v.addRow([EMP[0].no, picks.seriesParent.name, picks.seriesParent.code, picks.seriesSize, 1, '10.03.2026']);
  // Размер указан, а размерного ряда у позиции нет (один размер на всех):
  // preview и apply обязаны сойтись — строка создаётся с базовой позицией.
  v.addRow([EMP[0].no, picks.plain.name, picks.plain.code, '42', 1, '11.03.2026']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const path = resolve(OUT_DIR, broken ? 'ppe-phase2-broken.xlsx' : 'ppe-phase2-fixture.xlsx');
  writeFileSync(path, buf);
  return path;
}

async function setFileInput(ws, absPath) {
  await send(ws, 'DOM.enable');
  const { root } = await send(ws, 'DOM.getDocument', { depth: -1 });
  let nodeId = 0;
  const pane = await send(ws, 'DOM.querySelector', { nodeId: root.nodeId, selector: '.v3-tab-pane[data-pane-active="1"]' });
  if (pane.nodeId) {
    const inner = await send(ws, 'DOM.querySelector', { nodeId: pane.nodeId, selector: 'input[type=file]' });
    nodeId = inner.nodeId;
  }
  if (!nodeId) {
    const any = await send(ws, 'DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    nodeId = any.nodeId;
  }
  if (!nodeId) return { ok: false, reason: 'input[type=file] не найден' };
  await send(ws, 'DOM.setFileInputFiles', { files: [absPath], nodeId });
  // Часть сборок не будит React-оверлоуд от CDP — дожимаем change сами (повторный
  // onPick идемпотентен: тот же файл кладётся в состояние ещё раз).
  await evaluate(
    ws,
    `const inp = document.querySelector('.v3-tab-pane[data-pane-active="1"] input[type=file]') ?? document.querySelector('input[type=file]');
     if (inp) inp.dispatchEvent(new Event('change', { bubbles: true }));
     return true;`,
  );
  await sleep(600);
  return { ok: true };
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  const login = await evaluate(
    ws,
    `const inputs = vis('input');
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan'); await wait(300);
     setVal(pwd, 'valstan-dev'); await wait(300);
     const btn = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn); await wait(4000);
     const st = await call(window.matrica.auth.status());
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await evaluate(ws, `await dismissModals(); return true;`);

  // ── [1] Фикстуры: выбор позиций номенклатуры + набор норм ──────────────────
  const fix = await evaluate(
    ws,
    `const list = await call(window.matrica.warehouse.nomenclatureList({ limit: 5000 }), 40000);
     if (!list?.ok) throw new Error('номенклатура не прочиталась: ' + String(list?.error ?? list));
     const rows = (list.rows ?? []).filter((r) => String(r.code ?? '').trim());
     const byCode = new Map(rows.map((r) => [String(r.code).trim(), r]));
     // Донор — живая позиция с группой и единицей: строгая дверь создания спрашивает
     // их обязательно, а фикстуре нужны формы, не смысл. На пустом стенде донора нет —
     // заводим его сами (группа СИЗ + единица из справочника), иначе смоук падал бы
     // на голой базе, где проверять модуль как раз и нужно.
     let donor = rows.find((r) => String(r.groupId ?? '').trim() && String(r.unitId ?? '').trim()) ?? null;
     let donorCreated = false;
     if (!donor) {
       const types = await call(window.matrica.admin.entityTypes.list(), 40000);
       let groupType = (types ?? []).find((t) => String(t.code ?? '') === 'nomenclature_group');
       if (!groupType) {
         // На голом стенде тип групп ещё не заведён (bootstrap его не создаёт) —
         // заводим вместе с атрибутом имени, иначе донора для СИЗ не построить.
         const made = await call(
           window.matrica.admin.entityTypes.upsert({ code: 'nomenclature_group', name: 'Группы номенклатуры' }),
           40000,
         );
         if (!made?.ok) throw new Error('тип nomenclature_group: ' + JSON.stringify(made));
         groupType = { id: String(made.id) };
         const defs = await call(window.matrica.admin.attributeDefs.listByEntityType(String(made.id)), 40000);
         if (!(defs ?? []).some((d) => String(d.code ?? '') === 'name')) {
           await call(
             window.matrica.admin.attributeDefs.upsert({
               entityTypeId: String(made.id),
               code: 'name',
               name: 'Наименование',
               dataType: 'text',
               isRequired: false,
               sortOrder: 0,
               metaJson: null,
             }),
             40000,
           );
         }
       }
       const groups = await call(window.matrica.admin.entities.listByEntityTypeWithAttrs(String(groupType.id)), 40000);
       let groupId = (groups ?? []).find((g) => String(g.attributes?.name ?? '').trim() === 'СИЗ (смоук)')?.id ?? null;
       if (!groupId) {
         const made = await call(window.matrica.admin.entities.create(String(groupType.id)), 40000);
         if (!made?.ok) throw new Error('группа номенклатуры: ' + JSON.stringify(made));
         groupId = String(made.id);
         await call(window.matrica.admin.entities.setAttr(groupId, 'name', 'СИЗ (смоук)'), 40000);
       }
       // Группа живёт в EAV: пока она не уехала на сервер, строгая дверь номенклатуры
       // отвергнет group_id по внешнему ключу. Толкаем синк до создания донора.
       const pushed = await call(window.matrica.sync.run(), 90000).catch((e) => ({ ok: false, error: String(e) }));
       if (!pushed?.ok) throw new Error('sync перед донором: ' + JSON.stringify(pushed));
       const lookups = await call(window.matrica.warehouse.lookupsGet(), 40000);
       const units = lookups?.lookups?.units ?? lookups?.units ?? [];
       const unit = units.find((u) => /^шт/i.test(String(u.label ?? ''))) ?? units[0];
       if (!unit) throw new Error('в справочнике нет ни одной единицы измерения');
       const templates0 = await call(window.matrica.warehouse.nomenclatureTemplatesList());
       const tpl0 = (templates0?.ok ? templates0.rows : []).find((t) => String(t.code ?? '').trim() === 'default_component');
       if (!tpl0) throw new Error('нет шаблона default_component');
       const madeDonor = await call(
         window.matrica.warehouse.nomenclatureUpsert({
           code: 'SMK-DONOR-01',
           name: 'SMK Донор СИЗ (смоук)',
           itemType: 'component',
           directoryKind: 'component',
           category: 'workwear',
           groupId: String(groupId),
           unitId: String(unit.id),
           specJson: JSON.stringify({ templateId: String(tpl0.id), propertyValues: {} }),
         }),
         40000,
       );
       if (!madeDonor?.ok) throw new Error('донор номенклатуры: ' + JSON.stringify(madeDonor?.error ?? madeDonor));
       donor = { id: String(madeDonor.id), groupId: String(groupId), unitId: String(unit.id) };
       donorCreated = true;
     }
     // Шаблон обязан совпадать с типом номенклатуры (серверная проверка), поэтому
     // берём дефолтный шаблон для типа component — он не требует источника-карточки.
     const templates = await call(window.matrica.warehouse.nomenclatureTemplatesList());
     const tpl = (templates?.ok ? templates.rows : []).find((t) => String(t.code ?? '').trim() === 'default_component');
     if (!tpl) throw new Error('нет шаблона default_component');
     const common = {
       itemType: 'component', directoryKind: 'component', category: 'workwear',
       groupId: String(donor.groupId), unitId: String(donor.unitId),
       specJson: JSON.stringify({ templateId: String(tpl.id), propertyValues: {} }),
     };
     const ensureNom = async (args) => {
       const found = byCode.get(args.code);
       if (found) return { id: String(found.id), created: false };
       const res = await call(window.matrica.warehouse.nomenclatureUpsert(args), 40000);
       if (!res?.ok) throw new Error('номенклатура ' + args.code + ': ' + JSON.stringify(res?.error ?? res));
       return { id: String(res.id), created: true };
     };
     const boot = await ensureNom({ code: 'SMK-BT-01', name: 'SMK Ботинки рабочие (смоук)', ...common });
     const sz44 = await ensureNom({ code: 'SMK-BT-01-44', name: 'SMK Ботинки рабочие 44 (смоук)', parentNomenclatureId: boot.id, ...common });
     const sz46 = await ensureNom({ code: 'SMK-BT-01-46', name: 'SMK Ботинки рабочие 46 (смоук)', parentNomenclatureId: boot.id, ...common });
     const gloves = await ensureNom({ code: 'SMK-PR-01', name: 'SMK Перчатки хлопчатобумажные (смоук)', ...common });
     const deps = await call(window.matrica.employees.departmentsList());
     const dept = (Array.isArray(deps) ? deps : []).find((d) => String(d.displayName ?? '').trim()) ?? null;
     if (!dept) throw new Error('нет ни одного подразделения — фикстура не построится');
     const norms = await call(window.matrica.ppe.norms.list());
     let norm = (norms?.ok ? norms.rows : []).find((r) => String(r.name ?? '') === ${JSON.stringify(NORM_NAME)}) ?? null;
     let normCreated = false;
     if (!norm) {
       const made = await call(window.matrica.ppe.norms.upsert({ name: ${JSON.stringify(NORM_NAME)}, lines: [
         { nomenclatureId: sz44.id, qty: 2, wearMonths: 12 },
         { nomenclatureId: gloves.id, qty: 2, wearMonths: 12 },
       ] }));
       if (!made?.ok) throw new Error('нормы: ' + String(made?.error ?? made));
       normCreated = true;
       norm = { id: String(made.id) };
     }
     return {
       подразделение: String(dept.displayName ?? '').trim(),
       deptId: String(dept.id),
       seriesParent: { id: boot.id, name: 'SMK Ботинки рабочие (смоук)', code: 'SMK-BT-01' },
       seriesChild: { id: sz44.id, name: 'SMK Ботинки рабочие 44 (смоук)', code: 'SMK-BT-01-44' },
       seriesSize: '44',
       seriesChild2: { id: sz46.id, name: 'SMK Ботинки рабочие 46 (смоук)', code: 'SMK-BT-01-46' },
       plain: { id: gloves.id, name: 'SMK Перчатки хлопчатобумажные (смоук)', code: 'SMK-PR-01' },
       plain2: { id: gloves.id, name: 'SMK Перчатки хлопчатобумажные (смоук)', code: 'SMK-PR-01' },
       normId: String(norm.id),
       нормы: normCreated ? 'создан' : 'переиспользован',
       номенклатура: [boot.created, sz44.created, sz46.created, gloves.created].filter(Boolean).length ? 'создана' : 'переиспользована',
     };
  `,
  );
  note(Boolean(fix?.normId && fix?.seriesChild?.id), 'фикстуры: позиции СИЗ (ряд 44/46 и без ряда) и набор норм готовы', {
    ряд: `${fix.seriesParent.name} → размер ${fix.seriesSize} (${fix.seriesChild.name})`,
    безряда: fix.plain.name,
    подразделение: fix.подразделение,
    нормы: fix.нормы,
    номенклатура: fix.номенклатура,
  });
  if (!fix?.normId) throw new Error('фикстуры не построились');

  // ── [1b] EAV-карточка сотрудника с размерами (подсказка при выдаче) ─────────
  // Карточка СИЗ знает строгого сотрудника (erp_employee_cards), а размеры живут в
  // EAV-карточке employee; общий ключ — табельный номер. Страница карточек читает
  // размеры на монтировании, поэтому карточку заводим ДО её первого открытия.
  const sizesFixture = await evaluate(
    ws,
    `const types = await call(window.matrica.admin.entityTypes.list());
     const empType = (types ?? []).find((t) => String(t.code ?? '') === 'employee');
     if (!empType) return { ok: false, reason: 'нет типа employee' };
     for (const f of [
       { code: 'ppe_size_clothes', name: 'Размер одежды', sortOrder: 106 },
       { code: 'ppe_size_shoes', name: 'Размер обуви', sortOrder: 107 },
     ]) {
       await call(window.matrica.admin.attributeDefs.upsert({
         entityTypeId: String(empType.id), code: f.code, name: f.name, dataType: 'text',
         isRequired: false, sortOrder: f.sortOrder, metaJson: null,
       }));
     }
     const created = await call(window.matrica.admin.entities.create(String(empType.id)));
     if (!created?.ok || !created?.id) return { ok: false, reason: 'EAV-сотрудник не создан: ' + String(created?.error ?? created) };
     const entityId = String(created.id);
     const set = async (code, value) => {
       const r = await call(window.matrica.admin.entities.setAttr(entityId, code, value));
       if (!r?.ok) throw new Error('setAttr ' + code + ': ' + String(r?.error ?? r));
     };
     await set('full_name', ${JSON.stringify(EMP[0].fio)});
     await set('personnel_number', '90991');
     await set('ppe_size_shoes', '44');
     const read = await call(window.matrica.admin.entities.listByEntityTypeWithAttrs(String(empType.id)));
     const mine = (read ?? []).filter((e) => String(e.attributes?.personnel_number ?? '') === '90991');
     return { ok: mine.length >= 1, entityId, sizes: (mine.find((e) => e.attributes?.ppe_size_shoes) ?? mine[0])?.attributes ?? null };`,
  );
  note(
    sizesFixture?.ok === true,
    'фикстура: EAV-карточка сотрудника 90991 с размером обуви 44 (источник подсказки при выдаче)',
    sizesFixture?.ok ? { entityId: sizesFixture.entityId } : sizesFixture,
  );

  // ── [2] Импорт ЗУП через страницу ──────────────────────────────────────────
  const fixturePath = await buildFixture(fix.подразделение, fix);
  await openSection(ws, 'Кладовщик', 'Импорт СИЗ');
  const onImport = await waitVal(ws, `Boolean(vis('input[type=file]')[0])`, 'страница импорта');
  note(Boolean(onImport), 'страница «Импорт СИЗ» открыта');
  if (!onImport) throw new Error('страница импорта не открылась');

  const fileSet = await setFileInput(ws, fixturePath);
  const filePicked = await waitVal(ws, `/(ppe-phase2-fixture\\.xlsx)/.test(txt(activePane()))`, 'файл принят страницей');
  note(Boolean(fileSet.ok && filePicked), 'файл выгрузки отдан странице (настоящий input[type=file])', fileSet);

  const previewRes = await evaluate(
    ws,
    `const btn = vis('button').find((b) => txt(b) === 'Проверить файл');
     if (!btn) return { ok: false, reason: 'нет кнопки «Проверить файл»' };
     click(btn);
     for (let i = 0; i < 80; i++) {
       await wait(400);
       const pane = txt(activePane());
       if (pane.includes('План импорта') || /Ошибка:/.test(pane)) break;
     }
     const pane = txt(activePane());
     const emp = pane.match(/Сотрудники: создать (\\d+), обновить (\\d+), совпало (\\d+), конфликтов (\\d+)/);
     const iss = pane.match(/Выдачи: \\+(\\d+), пропуск (\\d+), конфликтов (\\d+)/);
     const rows = [...activePane().querySelectorAll('tbody tr')].map((tr) => txt(tr));
     const warnRow = rows.find((r) => r.includes(${JSON.stringify(fix.plain.name)})) ?? '';
     const seriesRow = rows.find((r) => r.includes(${JSON.stringify(fix.seriesChild.name)})) ?? '';
     return {
       ok: Boolean(emp) && Boolean(iss),
       status: (pane.match(/Ошибка:[^|]{0,160}/) ?? [''])[0],
       emp: emp ? { create: +emp[1], update: +emp[2], match: +emp[3], conflict: +emp[4] } : null,
       iss: iss ? { create: +iss[1], skip: +iss[2], conflict: +iss[3] } : null,
       warnRow, seriesRow,
     };`,
  );
  note(Boolean(previewRes.ok), 'проверка файла: план построен', previewRes.emp ? { сотрудники: previewRes.emp, выдачи: previewRes.iss } : previewRes);
  const pEmp = previewRes.emp ?? { create: 0, update: 0, conflict: 0 };
  note(pEmp.create + pEmp.update + pEmp.match >= 3 && pEmp.conflict === 0, 'план: три сотрудника, конфликтов нет', pEmp);
  note(/нет размерного ряда/.test(previewRes.warnRow ?? ''), 'строка «размер 42 без ряда» обещана предупреждением (не конфликт)', {
    строка: (previewRes.warnRow ?? '').slice(0, 140),
  });
  note(/создастся|обновится|уже есть|совпало/.test(previewRes.warnRow ?? ''), 'у строки «размер без ряда» действие — не конфликт', {
    строка: (previewRes.warnRow ?? '').slice(0, 140),
  });
  note(/создастся|обновится|уже есть|совпало/.test(previewRes.seriesRow ?? ''), 'размер 44 разрешился в вариант (строка ссылается на «44», а не на общую позицию)', {
    строка: (previewRes.seriesRow ?? '').slice(0, 140),
  });
  await shot(ws, '2-preview');

  const applyRes = await evaluate(
    ws,
    `const btn = vis('button').find((b) => txt(b) === 'Применить');
     if (!btn) return { ok: false, reason: 'нет кнопки «Применить» (план не подтверждён?)' };
     click(btn);
     const acc = await acceptConfirm('Применить');
     if (!acc.ok) return acc;
     for (let i = 0; i < 120; i++) {
       await wait(500);
       const pane = txt(activePane());
       if (pane.includes('Импорт применён') || /Ошибка:/.test(pane)) break;
     }
     const pane = txt(activePane());
     const created = pane.match(/создано (\\d+), обновлено (\\d+), совпало (\\d+)/);
     const entries = pane.match(/выдачи — \\+(\\d+), пропущено (\\d+)/);
     return {
       ok: pane.includes('Импорт применён'),
       status: (pane.match(/Ошибка:[^|]{0,220}/) ?? [''])[0],
       created: created ? { create: +created[1], update: +created[2], match: +created[3] } : null,
       entries: entries ? { create: +entries[1], skip: +entries[2] } : null,
       итог: (pane.match(/Итог:[^|]{0,260}/) ?? [''])[0],
     };`,
  );
  note(applyRes.ok === true, 'применение прошло: «Импорт применён»', applyRes.ok ? applyRes.итог : applyRes);
  const aEmp = applyRes.created ?? { create: 0, update: 0 };
  note(aEmp.create + aEmp.update + aEmp.match >= 3, 'итог: три сотрудника заведены/обновлены/совпали', aEmp);
  const aEnt = applyRes.entries ?? { create: 0, skip: 0 };
  note(aEnt.create + aEnt.skip >= 2, 'итог: обе строки выдач обработаны (созданы или уже есть)', aEnt);
  await shot(ws, '3-applied');

  // ── [3] Реплика сотрудников (главный фикс шва) ─────────────────────────────
  const replica = await waitVal(
    ws,
    `(async () => {
       const res = await call(window.matrica.ppe.employees.list().catch(() => null));
       const rows = res?.ok ? res.employees : [];
       const mine = rows.filter((r) => ${JSON.stringify(EMP.map((e) => e.no))}.includes(String(r.personnelNo ?? '')));
       return mine.length >= 3 ? { ok: true, total: rows.length, mine: mine.map((r) => ({ no: r.personnelNo, fio: r.fullName, active: r.isActive })) } : null;
     })()`,
    'сотрудники в реплике',
    60000,
  );
  note(Boolean(replica?.ok), 'сотрудники импорта видны в реплике `erp_employee_cards` (пикеры и отчёты — один источник)', replica);
  note(
    (replica?.mine ?? []).every((m) => m.active === true || m.active === 1),
    'импортированные сотрудники активны',
    replica?.mine,
  );

  // ── [4] Пикер карточек СИЗ читает реплику ──────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Карточки СИЗ');
  const onCards = await waitVal(ws, `Boolean(vis('input[placeholder="Поиск сотрудника"]')[0])`, 'страница карточек');
  note(Boolean(onCards), 'страница «Карточки СИЗ» открыта');
  if (!onCards) throw new Error('страница карточек не открылась');

  const picker = await evaluate(
    ws,
    `const s = vis('input[placeholder="Поиск сотрудника"]')[0];
     setVal(s, 'Тестов'); await wait(700);
     const sel = vis('input[data-input-assist="component-suggestions"]')[0];
     const r = await pickOption(sel, ${JSON.stringify(EMP[0].fio)});
     if (!r.ok) return r;
     const openBtn = byExact('Открыть карточку');
     if (!openBtn) return { ok: false, reason: 'нет кнопки открытия карточки' };
     click(openBtn);
     for (let i = 0; i < 60; i++) {
       await wait(400);
       if (/Карточка: |Карточки нет/.test(txt(activePane()))) break;
     }
     const pane = txt(activePane());
     return { ok: pane.includes(${JSON.stringify(EMP[0].fio)}), picked: r.picked, pane: pane.slice(0, 220) };`,
  );
  note(picker.ok === true, 'пикер: импортированный сотрудник найден, карточка открыта', picker.ok ? { picked: picker.picked } : picker);
  if (picker.ok) await shot(ws, '4-card-opened');

  // ── [5] Складской приход под будущую выдачу ────────────────────────────────
  const receipt = await evaluate(
    ws,
    `const docNo = 'SMK-PPE-RCPT-' + Date.now();
     const created = await call(window.matrica.warehouse.documentCreate({
       docType: 'purchase_receipt',
       status: 'planned',
       docNo,
       header: { warehouseId: ${JSON.stringify(DEFAULT_WH)} },
       lines: [
         { nomenclatureId: ${JSON.stringify(fix.seriesChild.id)}, qty: 5, warehouseId: ${JSON.stringify(DEFAULT_WH)} },
         { nomenclatureId: ${JSON.stringify(fix.plain2.id)}, qty: 5, warehouseId: ${JSON.stringify(DEFAULT_WH)} },
       ],
     }), 40000);
     if (!created?.ok) return { ok: false, reason: 'приход не создан: ' + String(created?.error ?? created) };
     const posted = await call(window.matrica.warehouse.documentPost(String(created.id)), 40000);
     return { ok: Boolean(posted?.ok), documentId: String(created.id), docNo, error: posted?.ok ? null : String(posted?.error ?? posted) };`,
  );
  note(receipt?.ok === true, 'склад: приход проведён (выдача не упрётся в минус)', receipt?.ok ? { docNo: receipt.docNo } : receipt);

  // ── [6] Карточка: норма, отпуск, выдача (строгая дверь) ────────────────────
  const cardWork = await evaluate(
    ws,
    `const res = await call(window.matrica.ppe.employees.list());
     const emp = (res?.ok ? res.employees : []).find((r) => String(r.personnelNo ?? '') === '90991');
     if (!emp) return { ok: false, reason: 'нет сотрудника 90991 в реплике' };
     const existing = await call(window.matrica.ppe.cards.byEmployee(emp.id).catch(() => null));
     let cardId = existing?.ok ? String(existing.card.id) : null;
     if (!cardId) {
       const made = await call(window.matrica.ppe.cards.open({ employeeId: emp.id }));
       if (!made?.ok) return { ok: false, reason: 'карточка не открылась: ' + String(made?.error ?? made) };
       cardId = String(made.id);
     }
     const assign = await call(window.matrica.ppe.cards.assignNorms({ cardId, normSetIds: [${JSON.stringify(fix.normId)}] }));
     if (!assign?.ok) return { ok: false, reason: 'норма не назначена: ' + String(assign?.error ?? assign) };
     const from = Date.UTC(2026, 10, 1), to = Date.UTC(2026, 10, 10);
     const vac = await call(window.matrica.ppe.absences.create({ employeeId: emp.id, fromMs: from, toMs: to }));
     const vacOk = vac?.ok === true || /уже|дубл/.test(String(vac?.error ?? ''));
     const issue = await call(window.matrica.ppe.cards.issue({ cardId, warehouseId: ${JSON.stringify(DEFAULT_WH)}, lines: [{ nomenclatureId: ${JSON.stringify(fix.seriesChild.id)}, qty: 1 }] }), 40000);
     const card = await call(window.matrica.ppe.cards.get(cardId));
     return {
       ok: Boolean(card?.ok) && issue?.ok === true,
       employeeId: emp.id, cardId, vac: vacOk,
       norms: card?.ok ? card.card.norms.length : -1,
       entries: card?.ok ? card.card.entries.length : -1,
       issueError: issue?.ok ? null : String(issue?.error ?? issue),
     };`,
  );
  note(cardWork?.norms >= 1, 'карточка: норма назначена (строгая дверь приняла импортированного)', { нормы: cardWork?.norms });
  note(cardWork?.vac === true, 'карточка: отпуск добавлен', cardWork?.vac);
  note(
    cardWork?.ok === true,
    'карточка: выдача проведена (складской документ создан)',
    cardWork?.ok ? { выдач: cardWork.entries } : { ошибка: cardWork?.issueError ?? cardWork?.reason },
  );
  if (cardWork?.ok) await shot(ws, '5-issued');

  // ── [7] Группа: состав из реплики ──────────────────────────────────────────
  const groupWork = await evaluate(
    ws,
    `const res = await call(window.matrica.ppe.employees.list());
     const rows = res?.ok ? res.employees : [];
     const byNo = (no) => rows.find((r) => String(r.personnelNo ?? '') === no);
     const e1 = byNo('90991'), e2 = byNo('90992');
     if (!e1 || !e2) return { ok: false, reason: 'нет сотрудников в реплике' };
     const list = await call(window.matrica.ppe.groups.list());
     let g = (list?.ok ? list.rows : []).find((r) => String(r.name ?? '') === ${JSON.stringify(GROUP_NAME)}) ?? null;
     if (!g) {
       const made = await call(window.matrica.ppe.groups.create({ name: ${JSON.stringify(GROUP_NAME)} }));
       if (!made?.ok) return { ok: false, reason: 'группа не создана: ' + String(made?.error ?? made) };
       g = { id: String(made.id) };
     }
     const members = await call(window.matrica.ppe.groups.members.set({ groupId: String(g.id), employeeIds: [e1.id, e2.id] }));
     if (!members?.ok) return { ok: false, reason: 'состав не принят: ' + String(members?.error ?? members) };
     const norms = await call(window.matrica.ppe.groups.norms.set({ groupId: String(g.id), normSetIds: [${JSON.stringify(fix.normId)}] }));
     if (!norms?.ok) return { ok: false, reason: 'нормы группы не приняты: ' + String(norms?.error ?? norms) };
     const got = await call(window.matrica.ppe.groups.members.get(String(g.id)));
     const visibleNorms = await call(window.matrica.ppe.employees.normSets(e1.id));
     return { ok: true, groupId: String(g.id), members: got?.ok ? got.employeeIds.length : -1, groupNormsForE1: (visibleNorms?.ok ? visibleNorms.group : []).length };`,
  );
  note(groupWork?.ok === true, 'группа: состав и нормы приняты строгой дверью (id из реплики)', groupWork?.ok ? { состав: groupWork.members } : groupWork);
  note(groupWork?.groupNormsForE1 >= 1, 'нормы группы видны сотруднику (транзитивная видимость)', { групповых: groupWork?.groupNormsForE1 });

  // ── [8] Коллективная выдача: открытие и распределение ──────────────────────
  const colWork = await evaluate(
    ws,
    `const res = await call(window.matrica.ppe.employees.list());
     const e1 = (res?.ok ? res.employees : []).find((r) => String(r.personnelNo ?? '') === '90991');
     if (!e1) return { ok: false, reason: 'нет сотрудника 90991' };
     const open = await call(window.matrica.ppe.collectives.open({
       id: ${JSON.stringify(COLLECTIVE_ID)},
       departmentId: ${JSON.stringify(fix.deptId)},
       warehouseId: ${JSON.stringify(DEFAULT_WH)},
       lines: [{ employeeId: e1.id, nomenclatureId: ${JSON.stringify(fix.plain2.id)}, qty: 2 }],
     }), 40000);
     let mode = 'открыта';
     if (!open?.ok) {
       const prev = await call(window.matrica.ppe.collectives.get(${JSON.stringify(COLLECTIVE_ID)}).catch(() => null));
       if (prev?.ok) mode = 'уже открыта (повторный прогон)';
       else return { ok: false, reason: 'коллективная не открыта: ' + String(open?.error ?? open) };
     }
     const dist = await call(window.matrica.ppe.collectives.distribute({ collectiveId: ${JSON.stringify(COLLECTIVE_ID)} }), 40000);
     if (!dist?.ok) return { ok: false, reason: 'распределение не прошло: ' + String(dist?.error ?? dist) };
     const got = await call(window.matrica.ppe.collectives.get(${JSON.stringify(COLLECTIVE_ID)}));
     return { ok: true, mode, alreadyDistributed: dist.alreadyDistributed === true, documentId: got?.ok ? got.collective.documentId : null, lines: got?.ok ? got.collective.lines.length : -1 };`,
  );
  note(colWork?.ok === true, 'коллективная: открыта и распределена (документ проведён)', colWork);
  if (colWork?.ok) await shot(ws, '6-collective');

  // ── [9] Отчёты: ФИО из реплики ─────────────────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Отчёты СИЗ');
  const onReports = await waitVal(ws, `Boolean(byText('Сводная ведомость СИЗ'))`, 'страница отчётов');
  note(Boolean(onReports), 'страница «Отчёты СИЗ» открыта');
  if (onReports) {
    const clicked = await evaluate(
      ws,
      `const b = byText('Сводная ведомость СИЗ');
       if (!b) return { ok: false, reason: 'нет плитки отчёта' };
       click(b);
       return { ok: true };`,
    );
    // Отчёт не строится сам — нужно нажать «Сформировать отчёт». Карточки и факты
    // выдачи догоняют тиком публикатора ≤60 с, поэтому жмём и перестраиваем раз в
    // 10 с, пока в результате не появится ФИО импортированных.
    const reportReady = await (async () => {
      const deadline = Date.now() + 150000;
      while (Date.now() < deadline) {
        await evaluate(ws, `const b = byText('Сформировать отчёт'); if (b) click(b); return true;`);
        await sleep(8000);
        const t = await evaluate(ws, `return txt(document);`);
        if (typeof t === 'string' && t.includes('СМОК Тестов Один')) return { ok: true };
      }
      return null;
    })();
    const report = await evaluate(
      ws,
      `const prefilled = document.querySelector('[data-report-prefilled]');
       const rows = [...document.querySelectorAll('tbody tr')].map((tr) => txt(tr));
       return {
         preset: prefilled ? prefilled.getAttribute('data-report-prefilled') : null,
         rowsWithNames: rows.filter((r) => r.includes('СМОК Тестов')).length,
         строки: rows.filter((r) => r.includes('СМОК Тестов')).slice(0, 3).map((r) => r.slice(0, 160)),
       };`,
    );
    note(Boolean(clicked.ok) && report.rowsWithNames >= 1, 'отчёт «Сводная ведомость СИЗ»: ФИО импортированных — из реплики', {
      preset: report.preset,
      строк: report.rowsWithNames,
      образец: report.строки,
    });
    await shot(ws, '7-report');
  } else {
    note(false, 'страница отчётов не открылась — шаг пропущен');
  }

  // ── [10] Конфликтная строка файл не отменяет ───────────────────────────────
  const brokenPath = await buildFixture(fix.подразделение, fix, true);
  await openSection(ws, 'Кладовщик', 'Импорт СИЗ');
  await waitVal(ws, `Boolean(vis('input[type=file]')[0])`, 'страница импорта (2)');
  await setFileInput(ws, brokenPath);
  const broken = await evaluate(
    ws,
    `const btn = vis('button').find((b) => txt(b) === 'Проверить файл');
     if (!btn) return { ok: false, reason: 'нет кнопки проверки' };
     click(btn);
     for (let i = 0; i < 80; i++) {
       await wait(400);
       const pane = txt(activePane());
       if (pane.includes('План импорта') || /Ошибка:/.test(pane)) break;
     }
     const before = txt(activePane());
     const apply = vis('button').find((b) => txt(b) === 'Применить');
     if (!apply) return { ok: false, reason: 'нет кнопки «Применить»' };
     click(apply);
     await wait(1200);
     const dialog = vis('[role=alertdialog]')[0];
     const dialogText = dialog ? txt(dialog) : '';
     if (!dialog) return { ok: false, reason: 'диалог подтверждения не открылся', previewHasConflict: /конфликт/.test(before) };
     // Диалог обязан предупредить ДО применения: какие строки выпадут и почему это не отказ.
     const warned = /Строки с проблемами \\(\\d+/.test(dialogText) && /не будут импортированы/.test(dialogText);
     const acc = await acceptConfirm('Применить');
     if (!acc.ok) return { ...acc, warned, dialogText: dialogText.slice(0, 200) };
     for (let i = 0; i < 120; i++) {
       await wait(500);
       const pane = txt(activePane());
       if (pane.includes('Импорт применён') || /Ошибка:/.test(pane)) break;
     }
     const pane = txt(activePane());
     const reported = (pane.match(/Строк с проблемами не импортировано: (\\d+)/) ?? ['', '0'])[1];
     return {
       ok: warned && Number(reported) >= 1 && !/Ошибка:/.test(pane),
       warned,
       reportedConflicts: Number(reported),
       dialogText: dialogText.slice(0, 200),
       previewHasConflict: /конфликт/.test(before),
     };`,
  );
  note(broken.ok === true, 'конфликтная строка: файл применён, строка пропущена и названа в итоге', broken);

  // ── [11] Подсказка размера при выдаче ──────────────────────────────────────
  await openSection(ws, 'Кладовщик', 'Карточки СИЗ');
  const hint = await evaluate(
    ws,
    `const openBtn = byExact('Открыть карточку');
     if (openBtn) { click(openBtn); await wait(1500); }
     const issueBtn = byText('Выдать СИЗ');
     if (!issueBtn) return { ok: false, reason: 'нет кнопки «Выдать СИЗ»' };
     click(issueBtn); await wait(900);
     const pane = activePane();
     const sizesLine = (txt(pane).match(/Размер сотрудника:[^|]{0,80}/) ?? [''])[0].trim();
     const posInput = vis('input[placeholder="Позиция из норм"]', pane)[0];
     if (!posInput) return { ok: false, reason: 'нет поля позиции', sizesLine };
     click(posInput); await wait(900);
     const popup = vis('[data-entity-lookup-popup]')[0];
     if (!popup) return { ok: false, reason: 'список позиций не открылся', sizesLine };
     const rows = vis('[data-idx]', popup).map((el) => txt(el));
     return { ok: true, sizesLine, rows };`,
  );
  const rowWithHint = (hint?.rows ?? []).find((r) => r.includes('размер сотрудника'));
  note(
    hint?.ok === true && /обувь 44/.test(hint?.sizesLine ?? ''),
    'выдача: показаны размеры сотрудника (обувь 44) — из EAV-карточки по табельному',
    hint?.ok ? { строка: hint.sizesLine } : hint,
  );
  note(
    Boolean(rowWithHint && rowWithHint.includes('SMK Ботинки рабочие 44')),
    'выдача: позиция «Ботинки 44» помечена «размер сотрудника» (подсветка совпала)',
    rowWithHint ? { строка: rowWithHint.slice(0, 140) } : hint,
  );
  note(
    !(hint?.rows ?? []).some((r) => r.includes('Перчатки') && r.includes('размер сотрудника')),
    'выдача: у позиции без своего размера (перчатки) пометки нет',
    (hint?.rows ?? []).filter((r) => r.includes('Перчатки')).map((r) => r.slice(0, 140)),
  );
  await shot(ws, '8-size-hint');
  await evaluate(ws, `const c = vis('button').find((b) => txt(b) === 'Отмена'); if (c) { click(c); await wait(400); } return true;`);

  const failed = steps.filter((s) => !s.ok);
  const report = {
    ok: failed.length === 0,
    steps,
    fixtures: {
      ряд: `${fix.seriesParent.name} → ${fix.seriesSize}`,
      безРяда: fix.plain.name,
      коллективная: fix.plain2.name,
      нормы: NORM_NAME,
      группа: GROUP_NAME,
      коллективнаяId: COLLECTIVE_ID,
    },
  };
  writeFileSync(`${OUT_DIR}/cdp-ppe-phase2-report.json`, JSON.stringify(report, null, 2));
  console.log(`\n${failed.length === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} — ${steps.length - failed.length}/${steps.length}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('DRIVER ERROR:', String(e?.message ?? e));
  writeFileSync(`${OUT_DIR}/cdp-ppe-phase2-report.json`, JSON.stringify({ ok: false, error: String(e?.message ?? e), steps }, null, 2));
  process.exit(2);
});
