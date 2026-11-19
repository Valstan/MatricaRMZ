import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Канал тревог в МАКС (владелец 19.11.2026 — токен бота «Матрица РМЗ» в комнате
// «Матрица РМЗ»). Рвётся молча в трёх местах:
//
//   1) В проде `logInfo` без флага `critical` не пишется ВОВСЕ (`shouldLog` в logger.ts:
//      в prod-mode остаются только warn и error). Значит, строка «канал МАКС: адресат
//      определён» без `critical` не видна нигде: адресат определился — и потерялся.
//   2) Адресат берётся только из входящего сообщения боту (`GET /chats` у МАКС отключён),
//      сообщение сервер ВЫЧИТЫВАЕТ, а записать адресат он не может — бокс read-only.
//      Значит, определённый адресат обязан где-то остаться.
//   3) Токен и адресат читаются из комнаты КАРМАНА (env → комната). Если это отвалится,
//      канал молча превращается в no-op, и тревоги завода уходят в никуда.
function src(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const SERVICE = src('./criticalEventsMaxService.ts');
const LOGGER = src('../utils/logger.ts');

describe('канал МАКС виден в прод-журнале', () => {
  it('строки про адресат помечены critical — иначе в проде info молчит', () => {
    expect(LOGGER).toContain("if (critical) return true;");
    expect(LOGGER, 'в проде info не пишется без critical').toContain("return level === 'warn' || level === 'error';");
    expect(SERVICE).toContain(
      "logInfo('канал МАКС: адресат определён', { kind: to.kind, id: to.value }, { critical: true });",
    );
    expect(SERVICE).toContain(
      "logInfo('канал МАКС: адресат пока не известен', { error: found.error }, { critical: true });",
    );
  });

  it('определённый адресат не теряется: он остаётся в подсказке и вспоминается при старте', () => {
    expect(SERVICE).toContain('writeMaxTargetHint(to);');
    expect(SERVICE).toContain('const hint = readMaxTargetHint();');
    expect(SERVICE).toContain('канал МАКС: адресат был определён раньше — положите его в комнату КАРМАНА');
    expect(SERVICE).toContain("ключ: hint.kind === 'chat' ? 'MAX_ALERT_CHAT_ID' : 'MAX_ALERT_USER_ID'");
  });

  it('подсказка — не источник правды: отправка читает адресата из комнаты', () => {
    expect(SERVICE).toContain("await readVaultSecret('MAX_ALERT_CHAT_ID')");
    expect(SERVICE).toContain("await readVaultSecret('MAX_ALERT_USER_ID')");
    expect(SERVICE, 'отправка берёт адресата из комнаты, а не из подсказки').toContain(
      'const [accessToken, to] = await Promise.all([resolveToken(), resolveTarget()]);',
    );
  });
});

describe('токен и адресат берутся из комнаты КАРМАНА', () => {
  it('токен: сначала env, потом комната — иначе «положил токен и забыл перезапустить»', () => {
    expect(SERVICE).toContain("const fromEnv = envText('MATRICA_MAX_ALERT_TOKEN');");
    expect(SERVICE).toContain("return await readVaultSecret('MAX_ALERT_TOKEN');");
  });

  it('без токена и адресата канал — честный no-op, без запросов наружу', () => {
    expect(SERVICE).toContain('if (!accessToken || !to) return { ok: false, error:');
    expect(SERVICE).toContain('export async function isMaxAlertConfigured()');
  });
});
