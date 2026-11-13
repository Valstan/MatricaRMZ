/**
 * Проба окна клиента: что сейчас в рендерере (адрес, заголовок, есть ли мост
 * `window.matrica`, что видно на экране). Помогает, когда смоук падает на
 * «waitFor: мост клиента»: окно может открыться пустым (about:blank) или с
 * запасной страницей «Не загружен preload (IPC мост)».
 *
 *   node .claude/skills/verifier-electron/scripts/cdp-probe-window.mjs
 */
const PORT = process.env.MATRICA_CDP_PORT || '9222';
const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const list = (await res.json()).filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
console.log('targets:', list.map((t) => `${t.type} ${t.url}`).join(' | '));
if (!list.length) process.exit(0);
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
let WebSocket;
try {
  WebSocket = require('ws');
} catch {
  const { execSync } = require('node:child_process');
  const dir = execSync('node -e "console.log(require.resolve(\'ws\'))"', { cwd: 'node_modules/.pnpm', encoding: 'utf8' }).trim();
  WebSocket = require(dir);
}
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0;
function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 30000);
    const onMsg = (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id !== msgId) return;
      clearTimeout(t);
      ws.off('message', onMsg);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ href: location.href, title: document.title, hasMatrica: typeof window.matrica, bodyLen: (document.body?.innerText ?? '').length, body: (document.body?.innerText ?? '').slice(0, 400) })`,
  returnByValue: true,
});
console.log(r.result.value);
ws.close();
