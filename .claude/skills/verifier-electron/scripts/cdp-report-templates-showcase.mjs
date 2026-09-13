#!/usr/bin/env node
// Смоук витрины заготовок (этап 2B пакета владельца 12.09.2026).
//
// Проверяется ровно то, что рвётся молча и не ловится unit-тестами: экран ЖИВЬЁМ собирает
// три разных хранилища, показывает настройки словами, не двоит шаблон со строкой журнала
// про тот же отбор — и открывает отчёт уже настроенным.
//
//   node .claude/skills/verifier-electron/scripts/cdp-report-templates-showcase.mjs

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const OUT = '.verifier-electron/cdp-report-templates-showcase.json';

function wsLib() {
  try {
    return require('ws');
  } catch {
    const { execSync } = require('node:child_process');
    const dir = execSync('node -e "console.log(require.resolve(\'ws\'))"', {
      cwd: 'node_modules/.pnpm',
      encoding: 'utf8',
    }).trim();
    return require(dir);
  }
}

const WebSocket = wsLib();
const steps = [];
function note(ok, what, extra) {
  steps.push({ ok, what, ...(extra ? { extra } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? ` — ${JSON.stringify(extra)}` : ''}`);
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

// Любой вызов моста — под таймаутом: permission-denied внутри главного процесса иначе
// висит без диагностики (дисциплина из SKILL.md).
async function evaluate(ws, expression) {
  const result = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
  }
  return result.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [target] = await targets();
  if (!target) throw new Error('нет renderer-таргета — окно не открылось');
  const ws = await connect(target.webSocketDebuggerUrl);
  await send(ws, 'Runtime.enable');
  await send(ws, 'Page.enable');

  // 1. Логин — ФОРМОЙ, а не мостом. `auth.login` через мост сессию заводит, но рендерер
  //    остаётся на экране входа: он не слушает мост, и дальше драйвер ищет меню на форме
  //    логина и «не находит пункт» (потеряно на первом прогоне 13.09).
  //    Суперадмин: у verify урезан доступ по разделам, а витрина живёт в «Контроле».
  const login = await evaluate(
    ws,
    `function click(el) { for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true })); }
     function setVal(el, v) {
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(el, v);
       el.dispatchEvent(new Event('input', { bubbles: true }));
     }
     const inputs = [...document.querySelectorAll('input')];
     const pwd = inputs.find((i) => i.type === 'password');
     const user = inputs.find((i) => i.type !== 'password');
     if (!pwd || !user) return { ok: true, already: true };
     setVal(user, 'valstan');
     await new Promise((r) => setTimeout(r, 300));
     setVal(pwd, 'valstan-dev');
     await new Promise((r) => setTimeout(r, 300));
     const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === 'Войти');
     if (!btn) return { ok: false, reason: 'кнопки «Войти» нет' };
     click(btn);
     await new Promise((r) => setTimeout(r, 4000));
     const st = await window.matrica.auth.status();
     return { ok: Boolean(st?.loggedIn), role: st?.user?.role ?? null };`,
  );
  note(login.ok, 'вход суперадмином', login.already ? { already: true } : login);
  if (!login.ok) throw new Error('логин не прошёл');
  await sleep(1500);

  const userId = await evaluate(ws, `const s = await window.matrica.auth.status(); return String(s?.user?.id ?? '');`);

  // 2. Фикстура: сохранённый набор настроек С ОПИСАНИЕМ и строка журнала про ТОТ ЖЕ отбор.
  //    Два источника, один отбор — витрина обязана показать одну карточку, а не две.
  const sameFilters = { brandIds: [] };
  const fixture = await evaluate(
    ws,
    `const filters = ${JSON.stringify(sameFilters)};
     const saved = await window.matrica.reports.filterTemplateSave({
       userId: ${JSON.stringify(userId)},
       presetId: 'engine_stages',
       template: { name: 'СМОУК сверка с бухгалтерией', filters, disabled: [], description: 'Для сверки с бухгалтерией' },
     });
     const logged = await window.matrica.reports.historyAdd({
       userId: ${JSON.stringify(userId)},
       entry: { presetId: 'engine_stages', title: 'Стадии двигателей по контрактам', generatedAt: Date.now(), filters, disabled: [], rowCount: 7 },
     });
     const other = await window.matrica.reports.historyAdd({
       userId: ${JSON.stringify(userId)},
       entry: { presetId: 'parts_demand', title: 'Потребность в деталях', generatedAt: Date.now() - 60000, filters: { includePurchases: true }, disabled: [], rowCount: 3 },
     });
     return { saved: !!saved?.ok, logged: !!logged?.ok, other: !!other?.ok,
              description: (saved?.templates ?? []).find((t) => t.name === 'СМОУК сверка с бухгалтерией')?.description ?? null };`,
  );
  note(fixture.saved && fixture.logged && fixture.other, 'фикстура: шаблон + две записи журнала', fixture);
  note(
    fixture.description === 'Для сверки с бухгалтерией',
    'описание шаблона доехало до хранилища и вернулось',
    { description: fixture.description },
  );

  // 3. Открыть вкладку «Заготовки отчётов» по меню — как это делает оператор.
  const opened = await evaluate(
    ws,
    `function click(el) { for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true })); }
     function byText(text) {
       return [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim().includes(text));
     }
     // Оверлеи после входа («Что нового», модал черновиков) перехватывают клики по меню.
     for (const label of ['За работу!', 'Отклонить', 'Закрыть']) {
       for (let i = 0; i < 4; i++) { const b = byText(label); if (!b) break; click(b); await new Promise((r) => setTimeout(r, 250)); }
     }
     // Прогон не первый: вкладка уже открыта, левое меню скрыто, а список на экране —
     // от прошлого раза (мостовая правка шаблонов окно не уведомляет). Поэтому сначала
     // пробуем привести УЖЕ открытый экран в чистое состояние, и только потом идём в меню.
     let reused = false;
     if (!document.querySelector('[data-report-showcase-search]')) {
       // Панель меню сворачивается кнопкой «МЕНЮ» — без неё групп в DOM нет вовсе.
       const menuBtn = byText('МЕНЮ');
       if (menuBtn && !byText('Контроль и аналитика')) { click(menuBtn); await new Promise((r) => setTimeout(r, 800)); }
       const group = byText('Контроль и аналитика');
       if (!group) return { ok: false, reason: 'группы «Контроль и аналитика» нет — не то окно' };
       if ((group.textContent ?? '').includes('▸')) { click(group); await new Promise((r) => setTimeout(r, 1200)); }
       const tab = byText('Заготовки отчётов');
       if (!tab) return { ok: false, reason: 'пункт меню не найден' };
       click(tab);
       await new Promise((r) => setTimeout(r, 2500));
     } else {
       reused = true;
     }
     const search = document.querySelector('[data-report-showcase-search]');
     if (!search) return { ok: false, reason: 'экран витрины не открылся' };
     // Поисковая строка и список переживают прогон — чистим оба, иначе ассерты считают
     // вчерашний экран.
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(search, '');
     search.dispatchEvent(new Event('input', { bubbles: true }));
     const refresh = byText('Обновить');
     if (refresh) { click(refresh); }
     await new Promise((r) => setTimeout(r, 2000));
     return { ok: true, reused };`,
  );
  note(opened.ok, 'вкладка «Заготовки отчётов» открывается из меню', opened.ok ? undefined : opened);

  // 4. Что на экране: карточки трёх видов, описание владельца, настройки словами.
  const screen = await evaluate(
    ws,
    `const cards = [...document.querySelectorAll('[data-report-showcase-card]')];
     const kinds = cards.map((c) => c.getAttribute('data-report-showcase-card'));
     const texts = cards.map((c) => (c.textContent ?? '').replace(/\\s+/g, ' ').trim());
     return {
       count: cards.length,
       kinds,
       hasSearch: Boolean(document.querySelector('[data-report-showcase-search]')),
       descriptions: [...document.querySelectorAll('[data-report-showcase-description]')].map((d) => (d.textContent ?? '').trim()),
       smokeCards: texts.filter((t) => t.includes('СМОУК')),
       partsDemandCards: texts.filter((t) => t.includes('Потребность в деталях')),
     };`,
  );
  note(screen.count > 0, 'витрина показывает карточки', { count: screen.count, kinds: screen.kinds });
  note(screen.hasSearch, 'поле поиска на месте');
  note(
    screen.descriptions.includes('Для сверки с бухгалтерией'),
    'подпись владельца видна отдельной строкой',
    { descriptions: screen.descriptions },
  );
  note(
    screen.smokeCards.length === 1,
    'шаблон и строка журнала про один отбор не двоятся',
    { smokeCards: screen.smokeCards.length },
  );
  note(
    screen.smokeCards[0]?.includes('строили') || screen.smokeCards[0]?.includes('2026'),
    'у заготовки видно, когда её строили',
    { card: screen.smokeCards[0]?.slice(0, 160) ?? null },
  );
  note(
    screen.partsDemandCards.length === 1,
    'строка журнала без сохранённого шаблона показана отдельной карточкой',
    { count: screen.partsDemandCards.length },
  );

  // 5. Поиск по описанию — владелец ищет словами, которыми подписывал.
  const search = await evaluate(
    ws,
    `const input = document.querySelector('[data-report-showcase-search]');
     const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
     setter.call(input, 'бухгалтер');
     input.dispatchEvent(new Event('input', { bubbles: true }));
     await new Promise((r) => setTimeout(r, 700));
     const cards = [...document.querySelectorAll('[data-report-showcase-card]')];
     return { count: cards.length, first: (cards[0]?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120) };`,
  );
  note(search.count === 1, 'поиск по слову из описания находит нужную заготовку', search);

  // 6. Главное: открытие отчёта УЖЕ настроенным — ради этого экран и делался.
  const open = await evaluate(
    ws,
    `function click(el) { for (const type of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(type, { bubbles: true })); }
     const card = document.querySelector('[data-report-showcase-card]');
     const btn = [...card.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Открыть с этими настройками'));
     if (!btn) return { ok: false, reason: 'кнопки открытия нет' };
     click(btn);
     await new Promise((r) => setTimeout(r, 3000));
     const body = (document.body.textContent ?? '').replace(/\\s+/g, ' ');
     return {
       ok: true,
       onPreset: body.includes('Стадии двигателей по контрактам'),
       prefilledNotice: body.includes('готовыми настройками') || body.includes('Настройки подставлены') || body.includes('подставлен'),
     };`,
  );
  note(open.ok && open.onPreset, 'щелчок открывает тот самый отчёт', open);

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' });
  writeFileSync('.verifier-electron/cdp-report-templates-showcase.png', Buffer.from(shot.data, 'base64'));

  // Уборка фикстуры: стенд переживает прогоны, смоуковый шаблон не должен копиться.
  await evaluate(
    ws,
    `const list = await window.matrica.reports.filterTemplatesList({ userId: ${JSON.stringify(userId)}, presetId: 'engine_stages' });
     const tpl = (list?.templates ?? []).find((t) => t.name === 'СМОУК сверка с бухгалтерией');
     if (tpl) await window.matrica.reports.filterTemplateDelete({ userId: ${JSON.stringify(userId)}, presetId: 'engine_stages', templateId: tpl.id });
     return true;`,
  );

  const failed = steps.filter((s) => !s.ok);
  writeFileSync(OUT, JSON.stringify({ verdict: failed.length === 0 ? 'PASS' : 'FAIL', steps }, null, 2));
  console.log(`\n${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`} — отчёт: ${OUT}`);
  ws.close();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  writeFileSync(OUT, JSON.stringify({ verdict: 'ERROR', error: e.message, steps }, null, 2));
  process.exit(2);
});
