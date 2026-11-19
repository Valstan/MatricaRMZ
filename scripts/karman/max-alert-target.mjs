// Канал тревог в МАКС: узнать адресата и включить канал.
//
// ЗАЧЕМ. `GET /chats` у МАКС отключён (с июня 2026), поэтому адресата бот узнаёт ТОЛЬКО
// из входящего сообщения: владелец пишет боту «Матрица РМЗ» одно сообщение, сервер его
// вычитывает и отвечает в тот же чат. Дальше адресат кладётся в комнату КАРМАНА ключом
// `MAX_ALERT_CHAT_ID` (или `MAX_ALERT_USER_ID`) — и тревоги завода идут в МАКС.
//
// Шаги:
//   node scripts/karman/max-alert-target.mjs discover   — прочитать обновления бота и показать адресата
//   node scripts/karman/max-alert-target.mjs enable <chat_id>   — положить адресата в комнату
//
// Токен бота лежит в комнате «Матрица РМЗ» (`matricarmz`) ключом `MAX_ALERT_TOKEN`; адрес
// сервиса и ТОКЕН КОМНАТЫ (писать можно только им) — в `%USERPROFILE%\.matricarmz-keys`
// (`vault-url`, `karman-token`). Ничего из этого не печатается.
//
// Рецепт — `docs/OPERATIONS.md` §8б.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KEYS_DIR = join(process.env.USERPROFILE ?? '', '.matricarmz-keys');
const PROJECT_ROOM = 'matricarmz';
const MAX_API_BASE = 'https://platform-api2.max.ru';

function readKey(name) {
  try {
    return readFileSync(join(KEYS_DIR, name), 'utf8').trim();
  } catch {
    console.error(`Нет файла ${join(KEYS_DIR, name)} — он лежит на машине владельца, не в репозитории.`);
    process.exit(2);
  }
}

const base = readKey('vault-url').replace(/\/+$/, '');
const roomToken = readKey('karman-token');

async function vaultGet(path) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${roomToken}` } });
  if (!res.ok) throw new Error(`комната КАРМАНА: HTTP ${res.status}`);
  return await res.json();
}

async function vaultPut(secrets) {
  const res = await fetch(`${base}/api/secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${roomToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ secrets }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`комната КАРМАНА: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Токен бота — из комнаты проекта (не печатаем). */
async function botToken() {
  const json = await vaultGet('/api/secrets?key=MAX_ALERT_TOKEN');
  const value = String(json?.secrets?.MAX_ALERT_TOKEN ?? '').trim();
  if (!value) throw new Error('в комнате нет ключа MAX_ALERT_TOKEN');
  return value;
}

/**
 * Адресат из обновлений бота. Ищем рекурсивно: у МАКС `chat_id` лежит на верхнем уровне
 * события (а не внутри `message`), и форма события менялась — так надёжнее.
 */
function findChatRef(node, depth = 0) {
  if (depth > 6 || node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findChatRef(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const chat = node.chat ?? {};
  const user = node.user ?? {};
  const chatId = node.chat_id ?? chat.chat_id ?? chat.id;
  const userId = node.user_id ?? user.user_id ?? user.id;
  if (chatId == null && userId == null) {
    for (const value of Object.values(node)) {
      const hit = findChatRef(value, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const out = { text: String(node.text ?? '') };
  if (chatId != null) out.chatId = String(chatId);
  if (userId != null) out.userId = String(userId);
  return out;
}

async function discover() {
  const token = await botToken();
  const res = await fetch(`${MAX_API_BASE}/updates?timeout=5&limit=100`, {
    headers: { Authorization: token },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`МАКС: HTTP ${res.status} ${detail.slice(0, 200)}`);
    process.exitCode = 1;
    return;
  }
  const payload = await res.json().catch(() => null);
  const updates = Array.isArray(payload?.updates) ? payload.updates : [];
  const found = updates.map((u) => findChatRef(u)).find(Boolean);
  if (!found) {
    console.log('Обновлений нет — владелец должен написать боту «Матрица РМЗ» одно сообщение в МАКС.');
    console.log('Бот ответит и покажет адресат (чат или личный диалог); его кладут в комнату.');
    // exitCode, а не process.exit: на Windows принудительный выход во время висящего
    // fetch роняет node проверкой libuv (Assertion failed: UV_HANDLE_CLOSING).
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({ chatId: found.chatId ?? null, userId: found.userId ?? null }, null, 2));
}

async function enable(target) {
  const value = String(target ?? '').trim();
  if (!value) throw new Error('нужен chat_id или user_id');
  const isUser = value.startsWith('user:');
  const id = isUser ? value.slice('user:'.length) : value;
  const key = isUser ? 'MAX_ALERT_USER_ID' : 'MAX_ALERT_CHAT_ID';
  await vaultPut({ [key]: id });
  console.log(`Готово: ${key} = ${id} в комнате «Матрица РМЗ» (${PROJECT_ROOM}).`);
  console.log('Канал поднимется сам: рантайм читает комнату (кэш 5 минут), перезапуск не нужен.');
}

const [command, target] = process.argv.slice(2);
try {
  if (command === 'discover') await discover();
  else if (command === 'enable') await enable(target);
  else {
    console.error('Использование: max-alert-target.mjs discover | enable <chat_id|user:user_id>');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`Не получилось: ${String(e?.message ?? e)}`);
  process.exitCode = 1;
}
