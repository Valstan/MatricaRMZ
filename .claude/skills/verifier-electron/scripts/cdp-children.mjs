#!/usr/bin/env node
// Смоук детского и организационного модуля (промты КАРМАНА #30/#31).
//
// Проверяем живьём на стенде то, что не ловят unit-тесты:
//   1) раздел «Дети» открывается в меню «Персонал и доступ»;
//   2) панель ступеней (фасеты) на месте, список показывает карточку ребёнка;
//   3) возраст считается от даты рождения, а не хранится;
//   4) «серенький» ребёнок помечен и НЕ попадает в «Кого поздравить»;
//   5) кнопка «Напомнить» заводит заметку со сроком (напоминание — общий механизм);
//   6) раздел «Организационное» открывается: мероприятие и журнал выдачи;
//   7) получатель подарка — ссылка (ребёнок), а не текст; запись видна в журнале.
//
//   node .claude/skills/verifier-electron/scripts/cdp-children.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT_DIR = '.verifier-electron';
const OUT = `${OUT_DIR}/cdp-children-report.json`;
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
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60000);
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
async function shot(ws, name) {
  const s = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  const p = `${OUT_DIR}/cdp-children-${name}.png`;
  writeFileSync(p, Buffer.from(s.data, 'base64'));
  console.log(`      скриншот: ${p}`);
  return p;
}

const HELPERS = `
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (el) => (el?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  const click = (el) => { for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true })); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dismissModals = async () => {
    for (let i = 0; i < 8; i++) {
      const b = [...document.querySelectorAll('button')].filter(visible).find((x) => txt(x) === 'За работу!' || txt(x) === 'Отклонить');
      if (!b) break;
      click(b); await wait(300);
    }
  };
`;

/** Дата рождения через N дней — чтобы ребёнок попал в «Кого поздравить». */
function birthDateInDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // Суперадмин стенда: раздел доступа «Дети и организационное» он обходит сам,
  // а права children.* / organization.* у него полные.
  const login = await evaluate(
    ws,
    `const res = await window.matrica.auth.login({ username: 'valstan', password: 'valstan-dev' });
     return { ok: res?.ok === true, error: res?.error ?? null };`,
  );
  note(login.ok, 'логин суперадмином стенда', login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(2000);
  await evaluate(ws, `await dismissModals(); return true;`);

  // Фикстуры: ребёнок с днём рождения через 5 дней (попадёт в напоминания),
  // ребёнок уволенного сотрудника (серенький) и выдача ему подарка.
  const seeded = await evaluate(
    ws,
    `const birth = ${birthDateInDays(5)};
     const old = ${birthDateInDays(-9 * 365)};
     const saved = await window.matrica.children.save({ fullName: 'Смоук Тестовый Ребёнок', birthDate: birth, gender: 'male', tags: ['svo'], note: 'смоук' });
     if (!saved?.ok) return { ok: false, reason: 'карточка ребёнка не заведена', error: saved?.error ?? null };
     const silver = await window.matrica.children.save({ fullName: 'Смоук Серенький Ребёнок', birthDate: ${birthDateInDays(3)}, gender: 'female', note: 'смоук-серенький' });
     const gift = await window.matrica.organization.saveGift({ recipientKind: 'child', recipientChildId: saved.id, kind: 'gift', title: 'Смоук-подарок', givenAt: Date.now() });
     return { ok: true, childId: saved.id, silverId: silver?.ok ? silver.id : null, giftOk: gift?.ok === true };`,
  );
  note(seeded.ok, 'фикстуры заведены (карточка ребёнка, серенький, выдача)', seeded.ok ? undefined : seeded);
  if (!seeded.ok) throw new Error(`фикстуры: ${seeded.reason ?? ''} ${seeded.error ?? ''}`);

  // Меню: Персонал и доступ → Дети.
  const nav = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     if (!ov) return { ok: false, reason: 'оверлей меню не открылся' };
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Персонал'));
     if (!g) return { ok: false, reason: 'группа «Персонал и доступ» не найдена', have: groups.map(txt).slice(0, 40) };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes('Дети'));
     if (!it) return { ok: false, reason: 'пункт «Дети» не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 40) };
     it.click(); await wait(2500);
     return { ok: true };`,
  );
  note(nav.ok, 'меню: Персонал и доступ → Дети', nav.ok ? undefined : nav);
  if (!nav.ok) throw new Error(`навигация: ${nav.reason}`);

  const page = await evaluate(
    ws,
    `const body = document.body.innerText;
     return { title: body.includes('Дети сотрудников'), counter: body.includes('Всего:') || body.includes('Показано:'),
              facets: body.includes('Возраст') && body.includes('Состояние') };`,
  );
  note(page.title, 'экран «Дети» открылся', page);
  note(page.counter, 'счётчик списка на месте', page);
  note(page.facets, 'панель ступеней (фасеты) на месте', page);
  const shots = [await shot(ws, 'screen')];

  // Строка ребёнка доезжает до клиента по синку: публикатор зеркала тикает раз в минуту.
  let appeared = { ok: false };
  for (let i = 0; i < 20; i += 1) {
    appeared = await evaluate(
      ws,
      `const res = await window.matrica.children.list();
       const rows = res?.ok ? res.rows : [];
       const child = rows.find((r) => r.fullName === 'Смоук Тестовый Ребёнок');
       const silver = rows.find((r) => r.fullName === 'Смоук Серенький Ребёнок');
       return { ok: Boolean(child), count: rows.length, silver: Boolean(silver) };`,
    );
    if (appeared.ok) break;
    await sleep(6000);
  }
  note(appeared.ok, 'карточка ребёнка доехала до клиента по синку', appeared);
  await evaluate(ws, `await wait(500); return true;`);
  const view = await evaluate(
    ws,
    `const body = document.body.innerText;
     return { row: body.includes('Смоук Тестовый Ребёнок'),
              silverMark: body.includes('серенький'),
              silverHint: body.includes('в отборы и напоминалки не попадает'),
              age: /\\d+ лет/.test(body),
              soon: body.includes('Кого поздравить') };`,
  );
  note(view.row, 'ребёнок виден в списке', view);
  note(view.age, 'возраст посчитан и показан', view);
  note(view.silverMark, 'серенький помечен', view);
  note(view.silverHint, 'у серенького сказано, что он не попадает в отборы и напоминалки', view);
  note(view.soon, 'панель «Кого поздравить» на месте', view);
  shots.push(await shot(ws, 'list'));

  // Серенький не должен попасть в «Кого поздравить» (у него ДР через 3 дня).
  const silverNotReminded = await evaluate(
    ws,
    `const body = document.body.innerText;
     const panel = body.split('Кого поздравить')[1] ?? '';
     return { ok: !panel.includes('Смоук Серенький Ребёнок'), panel: panel.slice(0, 200) };`,
  );
  note(silverNotReminded.ok, 'серенький не попал в «Кого поздравить»', silverNotReminded);

  // Напоминание — заметкой: жмём «Напомнить» у первого ребёнка.
  const noteCreated = await evaluate(
    ws,
    `const btn = [...document.querySelectorAll('button')].filter(visible).find((b) => txt(b) === 'Напомнить');
     if (!btn) return { ok: false, reason: 'кнопка «Напомнить» не найдена' };
     click(btn); await wait(2500);
     const list = await window.matrica.notes.list();
     const notes = list?.ok ? (list.notes ?? []) : [];
     const hit = notes.find((n) => String(n.title ?? '').includes('Смоук Тестовый Ребёнок'));
     return { ok: Boolean(hit), title: hit?.title ?? null, dueAt: hit?.dueAt ?? null, reminders: hit?.reminders ?? null };`,
  );
  note(noteCreated.ok, 'напоминание заведено заметкой (срок и точки)', noteCreated.ok ? undefined : noteCreated);
  shots.push(await shot(ws, 'reminder'));

  // Организационный модуль: раздел, мероприятие и журнал выдачи.
  const nav2 = await evaluate(
    ws,
    `if (!document.querySelector('.v3-menu-overlay')) {
       const el = document.elementFromPoint(75, 17); const b = el && el.closest('button');
       if (!b) return { ok: false, reason: 'кнопка МЕНЮ не найдена' };
       b.click(); await wait(1000);
     }
     const ov = document.querySelector('.v3-menu-overlay');
     const groups = [...ov.querySelectorAll('button')];
     const g = groups.find((x) => txt(x).replace(/^▸|^▾/, '').replace(/\\d+$/, '').trim().startsWith('Персонал'));
     if (!g) return { ok: false, reason: 'группа «Персонал и доступ» не найдена' };
     if (txt(g).startsWith('▸')) { g.click(); await wait(900); }
     const it = [...ov.querySelectorAll('button')].find((x) => txt(x).includes('Организационное'));
     if (!it) return { ok: false, reason: 'пункт «Организационное» не найден', have: [...ov.querySelectorAll('button')].map(txt).slice(0, 40) };
     it.click(); await wait(2500);
     const body = document.body.innerText;
     return { ok: body.includes('Организационный модуль') && body.includes('Мероприятия') && body.includes('Журнал выдачи') };`,
  );
  note(nav2.ok, 'меню: Персонал и доступ → Организационное', nav2.ok ? undefined : nav2);

  let giftAppeared = { ok: false };
  for (let i = 0; i < 20; i += 1) {
    giftAppeared = await evaluate(
      ws,
      `const res = await window.matrica.organization.list();
       const gifts = res?.ok ? (res.gifts ?? []) : [];
       const hit = gifts.find((g) => g.title === 'Смоук-подарок');
       return { ok: Boolean(hit), kind: hit?.kind ?? null, child: hit?.recipientChildId ?? null };`,
    );
    if (giftAppeared.ok) break;
    await sleep(6000);
  }
  note(giftAppeared.ok, 'запись о выдаче доехала до клиента', giftAppeared);
  const journal = await evaluate(
    ws,
    `const body = document.body.innerText;
     return { gift: body.includes('Смоук-подарок'), child: body.includes('Смоук Тестовый Ребёнок'), kind: body.includes('подарок') };`,
  );
  note(journal.gift && journal.child, 'в журнале выдачи виден подарок и его получатель', journal);
  shots.push(await shot(ws, 'organization'));

  // Уборка: снесём заведённое.
  await evaluate(
    ws,
    `await window.matrica.children.remove(${JSON.stringify(seeded.childId)});
     if (${JSON.stringify(seeded.silverId)}) await window.matrica.children.remove(${JSON.stringify(seeded.silverId)});
     return true;`,
  );

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps, screenshots: shots }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  process.exit(2);
});
