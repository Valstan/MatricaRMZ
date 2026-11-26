#!/usr/bin/env node
/**
 * Канал промтов проекта в КАРМАНе (мандат brain D-190).
 *
 * Проект читает СВОЙ раздел и архивирует выполненное:
 *   node scripts/karman/prompts-section.mjs list        — заголовки живых промтов
 *   node scripts/karman/prompts-section.mjs full        — тексты живых промтов ЦЕЛИКОМ
 *   node scripts/karman/prompts-section.mjs show <id>   — текст одного промта (живого или архивного)
 *   node scripts/karman/prompts-section.mjs archived    — заголовки архивных промтов
 *   node scripts/karman/prompts-section.mjs archive <id>   — «архив = сделано»
 *   node scripts/karman/prompts-section.mjs unarchive <id>
 *
 * Внешние входы (в репозитории их быть не может — значение токена и адрес сервиса):
 *   PROMPTS_TOKEN_MATRICARMZ — токен раздела (выпускает сам проект, лежит в комнате КАРМАНА);
 *   KARMAN_URL — базовый адрес сервиса.
 */

const PROJECT = 'MatricaRMZ';
const token = process.env.PROMPTS_TOKEN_MATRICARMZ;
const base = (process.env.KARMAN_URL ?? '').replace(/\/+$/, '');

if (!token) {
  console.error('Нет PROMPTS_TOKEN_MATRICARMZ в env — токен раздела лежит в комнате КАРМАНА, значение вне git.');
  process.exit(2);
}
if (!base) {
  console.error('Нет KARMAN_URL в env — адрес сервиса в репозитории не хранится.');
  process.exit(2);
}

const [, , command = 'list', rawId] = process.argv;

const headers = { Authorization: `Bearer ${token}` };

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const reason = {
      403: 'токен не от этого раздела',
      404: 'такого промта в разделе нет',
      503: 'канал не настроен: комната karman не приняла выдачу токена (грант pending)',
    }[res.status] ?? `HTTP ${res.status}`;
    throw new Error(reason);
  }
  return text ? JSON.parse(text) : {};
}

function print(prompts) {
  if (!prompts.length) {
    console.log('Пусто.');
    return;
  }
  for (const p of prompts) {
    const head = (p.body ?? '').split('\n').find((line) => line.trim().length > 0) ?? '';
    console.log(`#${p.id} | ${p.createdAt} | ${p.title || head.slice(0, 80)}`);
    console.log(`   ${head.slice(0, 300)}`);
  }
}

try {
  if (command === 'list' || command === 'archived') {
    const query = command === 'archived' ? '&archived=1' : '';
    const data = await call('GET', `/api/prompts/section?project=${PROJECT}${query}`);
    print(data.prompts ?? []);
  } else if (command === 'full') {
    // Тексты живых промтов целиком: `list` показывает только первую строку, а план
    // (критерии приёмки, решения, риски) живёт дальше — читать его надо целиком.
    const data = await call('GET', `/api/prompts/section?project=${PROJECT}`);
    for (const p of data.prompts ?? []) {
      console.log(`\n=== #${p.id} · ${p.createdAt} · ${p.title || ''} ===`);
      console.log(p.body ?? '');
    }
  } else if (command === 'show') {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      console.error('Нужен числовой id промта.');
      process.exit(2);
    }
    const live = await call('GET', `/api/prompts/section?project=${PROJECT}`);
    let prompt = (live.prompts ?? []).find((p) => p.id === id);
    if (!prompt) {
      const arch = await call('GET', `/api/prompts/section?project=${PROJECT}&archived=1`);
      prompt = (arch.prompts ?? []).find((p) => p.id === id);
    }
    if (!prompt) {
      console.error(`Промт #${id} в разделе не найден (ни живой, ни архивный).`);
      process.exit(1);
    }
    console.log(`#${prompt.id} · ${prompt.createdAt} · ${prompt.title || ''}`);
    console.log(prompt.body ?? '');
  } else if (command === 'archive' || command === 'unarchive') {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) {
      console.error('Нужен числовой id промта.');
      process.exit(2);
    }
    const data = await call('POST', '/api/prompts/section', {
      project: PROJECT,
      id,
      archived: command === 'archive',
    });
    console.log(`Промт #${data.id}: archived=${data.archived}`);
  } else {
    console.error(`Неизвестная команда: ${command}. list | full | show <id> | archived | archive <id> | unarchive <id>`);
    process.exit(2);
  }
} catch (err) {
  console.error(`Не получилось: ${err.message}`);
  process.exit(1);
}
