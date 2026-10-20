import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * MCP-прокси: движок запускает его рядом с собой (stdio, JSON-RPC), а он
 * перекладывает вызовы инструментов в loopback-мост клиента (aiLocalTools).
 * Отдельный процесс нужен потому, что движку нужен stdio-сервер, а база и её
 * ключ живут в основном процессе клиента — отдавать их наружу нельзя.
 */
export const MCP_PROXY_SOURCE = `'use strict';
const readline = require('node:readline');

const url = process.env.MATRICA_TOOLS_URL || '';
const token = process.env.MATRICA_TOOLS_TOKEN || '';
let catalog = [];
try { catalog = JSON.parse(process.env.MATRICA_TOOLS_CATALOG || '[]'); } catch { catalog = []; }

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');

async function callTool(name, args) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-matrica-token': token },
      body: JSON.stringify({ name, args: args || {} }),
    });
    const body = await res.json();
    if (!body || body.ok !== true) {
      return { isError: true, content: [{ type: 'text', text: String((body && body.error) || 'ошибка инструмента') }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(body.data) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: 'мост инструментов недоступен: ' + String(e && e.message ? e.message : e) }] };
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.id === undefined || req.id === null) return;
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: (req.params && req.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'matrica-db', version: '1.0.0' },
    }});
    return;
  }
  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: catalog } });
    return;
  }
  if (req.method === 'tools/call') {
    const params = req.params || {};
    callTool(params.name, params.arguments).then((result) => {
      send({ jsonrpc: '2.0', id: req.id, result });
    });
    return;
  }
  send({ jsonrpc: '2.0', id: req.id, result: {} });
});
`;

export function mcpProxyPath(engineDir: string): string {
  return join(engineDir, 'matrica-mcp.cjs');
}

export function engineConfigPath(engineDir: string): string {
  return join(engineDir, 'config', 'opencode', 'opencode.json');
}

export type McpServerConfig = {
  type: 'local';
  command: string[];
  environment: Record<string, string>;
};

export function engineConfig(server: McpServerConfig): string {
  // Схема конфига движка — плоская карта серверов под ключом mcp (проверено
  // живым движком v2.0.32: файл с "mcp": {"<имя>": {...}} он читает и
  // нормализует сам).
  return JSON.stringify({ mcp: { 'matrica-db': server } }, null, 2);
}

export async function writeEngineMcpFiles(
  engineDir: string,
  opts: { execPath: string; bridgeUrl: string; bridgeToken: string; catalog: unknown },
): Promise<void> {
  const proxy = mcpProxyPath(engineDir);
  await writeFile(proxy, MCP_PROXY_SOURCE, 'utf8');
  const server: McpServerConfig = {
    type: 'local',
    command: [opts.execPath, proxy],
    environment: {
      ELECTRON_RUN_AS_NODE: '1',
      MATRICA_TOOLS_URL: opts.bridgeUrl,
      MATRICA_TOOLS_TOKEN: opts.bridgeToken,
      MATRICA_TOOLS_CATALOG: JSON.stringify(opts.catalog),
    },
  };
  await writeFile(engineConfigPath(engineDir), engineConfig(server), 'utf8');
}
