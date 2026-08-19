import { readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';

import { decryptFileHybrid, normalizeKeyMaterial, parseBackupHeader } from '../services/backupCrypto.js';

// Recovery-side tool: run it on a machine that HOLDS the private key (never on the prod
// server — that is the whole point of the envelope). Deliberately imports no database or
// dotenv module so it works from a bare checkout during a real incident.

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

function usage(): never {
  console.error(
    [
      'Расшифровка ночного бэкапа MatricaRMZ.',
      '',
      'Использование:',
      '  pnpm -F @matricarmz/backend-api backup:decrypt --in <2026-08-19.dump.enc> --out <2026-08-19.dump> --key <private.pem>',
      '',
      'Параметры:',
      '  --in          зашифрованный файл (скачан с Яндекс.Диска)',
      '  --out         куда положить расшифрованный дамп',
      '  --key         PEM приватного ключа (хранится ВНЕ прод-сервера)',
      '  --passphrase  пароль ключа, если он под паролем',
      '                (лучше передавать через переменную BACKUP_ENCRYPTION_KEY_PASSPHRASE —',
      '                 аргумент командной строки виден в списке процессов)',
      '',
      'Восстановление после расшифровки:',
      '  pg_restore --clean --if-exists --no-owner --no-privileges -d <база> <2026-08-19.dump>',
    ].join('\n'),
  );
  process.exit(2);
}

async function main() {
  const inPath = arg('in');
  const outPath = arg('out');
  const keyPath = arg('key');
  if (!inPath || !outPath || !keyPath) usage();

  const passphrase = (arg('passphrase') ?? process.env.BACKUP_ENCRYPTION_KEY_PASSPHRASE ?? '').trim();
  const privateKeyPem = normalizeKeyMaterial(readFileSync(keyPath, 'utf8'));

  const header = parseBackupHeader(readFileSync(inPath).subarray(0, 512));
  console.log(`[decryptBackup] конверт v${header.version}, ключевой блок ${header.wrappedKeyLength} Б`);

  await decryptFileHybrid({ inPath, outPath, privateKeyPem, ...(passphrase ? { passphrase } : {}) });

  const { size } = await stat(outPath);
  const head = readFileSync(outPath).subarray(0, 5).toString('ascii');
  // pg_dump --format=custom always starts with the "PGDMP" magic; seeing it means the
  // artifact is a genuine restorable dump, not merely bytes that decrypted without error.
  const looksLikeDump = head === 'PGDMP';
  console.log(`[decryptBackup] ${basename(outPath)}: ${size} Б, сигнатура pg_dump: ${looksLikeDump ? 'да' : 'НЕТ'}`);
  if (!looksLikeDump) {
    console.warn('[decryptBackup] предупреждение: это не похоже на pg_dump --format=custom');
  }
}

void main().catch((e) => {
  console.error(`[decryptBackup] ошибка: ${String(e)}`);
  process.exitCode = 1;
});
