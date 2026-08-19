#!/usr/bin/env node
// Seals the irreplaceable keys of this project into one passphrase-protected file, so a
// dead disk on PC40 stops being an unrecoverable event.
//
// What goes in:
//   matricarmz-release.keystore  — Android signing key. One key forever: an APK signed by a
//                                  different one will not install over the fleet, so losing it
//                                  means reinstalling every tablet with data wiped.
//   .pw                          — its password.
//   backup-private.pem           — private half of the off-site backup envelope. Without it the
//                                  nightly dumps on Yandex.Disk are unreadable noise.
//
// The passphrase is typed by the operator and stored nowhere. Lose it and the bundle is as good
// as gone — write it down somewhere that is not this computer.
//
//   node scripts/seal-key-bundle.mjs seal       [--out <file.sealed>]
//   node scripts/seal-key-bundle.mjs unseal      --in <file.sealed> --dir <target-dir>
//   node scripts/seal-key-bundle.mjs self-check  --in <file.sealed>
//
// All three halves are here on purpose: a backup format nobody can open is not a backup.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const KEYS_DIR = join(homedir(), '.matricarmz-keys');
const MEMBERS = ['matricarmz-release.keystore', '.pw', 'backup-private.pem'];
const MAGIC = Buffer.from('MRMZSEAL', 'ascii');
const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  const v = process.argv[i + 1];
  return i >= 0 && v && !v.startsWith('--') ? v : null;
}

const IS_TTY = Boolean(process.stdin.isTTY);
let rlShared = null;
let hidePrompt = '';
let pipedLines = null;

// One interface for the whole run: closing and reopening it swallows the rest of stdin, so a
// second prompt would never resolve.
function reader() {
  if (rlShared) return rlShared;
  rlShared = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Echo the prompt but not the typed characters, so the passphrase never lands in the
  // scrollback — and from there in a screenshot or a shared terminal log.
  rlShared._writeToOutput = (chunk) => {
    if (String(chunk).includes(hidePrompt)) rlShared.output.write(hidePrompt);
  };
  return rlShared;
}

// Piped stdin (a scripted check) is drained once up front: readline's second question does
// not resolve reliably on a non-terminal stream, and a backup tool that hangs in CI is a
// backup tool nobody exercises.
async function readPipedLines() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
}

async function askHidden(prompt) {
  if (!IS_TTY) {
    pipedLines ??= await readPipedLines();
    return String(pipedLines.shift() ?? '').trim();
  }
  hidePrompt = prompt;
  return new Promise((resolve) => {
    reader().question(prompt, (answer) => {
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function closeReader() {
  rlShared?.close();
  rlShared = null;
}

// Length-prefixed container: no tar/zip dependency, and unseal restores exact bytes and names
// without guessing.
function pack(files) {
  const chunks = [];
  for (const [name, body] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(6);
    head.writeUInt16BE(nameBuf.length, 0);
    head.writeUInt32BE(body.length, 2);
    chunks.push(head, nameBuf, body);
  }
  return Buffer.concat(chunks);
}

function unpack(buf) {
  const files = [];
  let at = 0;
  while (at < buf.length) {
    const nameLen = buf.readUInt16BE(at);
    const bodyLen = buf.readUInt32BE(at + 2);
    at += 6;
    files.push([buf.subarray(at, at + nameLen).toString('utf8'), buf.subarray(at + nameLen, at + nameLen + bodyLen)]);
    at += nameLen + bodyLen;
  }
  return files;
}

async function openSealed(inPath) {
  const buf = readFileSync(inPath);
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    console.error('Неверная сигнатура — это не свёрток ключей MatricaRMZ.');
    process.exit(1);
  }
  const version = buf.readUInt8(MAGIC.length);
  if (version !== VERSION) {
    console.error(`Неподдерживаемая версия свёртка: ${version}`);
    process.exit(1);
  }

  let at = MAGIC.length + 1;
  const salt = buf.subarray(at, (at += SALT_LEN));
  const iv = buf.subarray(at, (at += IV_LEN));
  const tag = buf.subarray(at, (at += TAG_LEN));
  const body = buf.subarray(at);

  const pass = await askHidden('Пароль свёртка: ');
  // Pinning authTagLength keeps a truncated-tag forgery from being accepted as valid.
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(pass, salt, 32, SCRYPT), iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  try {
    return unpack(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    console.error('Не открылось: неверный пароль или файл повреждён.');
    process.exit(1);
  }
}

async function seal() {
  const missing = MEMBERS.filter((m) => !existsSync(join(KEYS_DIR, m)));
  if (missing.length) {
    console.error(`Не найдены файлы в ${KEYS_DIR}: ${missing.join(', ')}`);
    process.exit(1);
  }

  const pass = await askHidden('Пароль для запечатывания: ');
  if (pass.length < 12) {
    console.error('Пароль короче 12 символов — этот свёрток переживёт компьютер, пароль должен быть под стать.');
    process.exit(1);
  }
  if ((await askHidden('Повторите пароль: ')) !== pass) {
    console.error('Пароли не совпали.');
    process.exit(1);
  }

  const payload = pack(MEMBERS.map((m) => [m, readFileSync(join(KEYS_DIR, m))]));
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(pass, salt, 32, SCRYPT), iv, { authTagLength: TAG_LEN });
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);

  const head = Buffer.alloc(MAGIC.length + 1);
  MAGIC.copy(head, 0);
  head.writeUInt8(VERSION, MAGIC.length);

  const outPath = arg('out') ?? join(KEYS_DIR, 'matricarmz-keys.sealed');
  writeFileSync(outPath, Buffer.concat([head, salt, iv, cipher.getAuthTag(), body]));

  console.log(`Запечатано: ${outPath}`);
  console.log(`Внутри: ${MEMBERS.join(', ')}`);
  console.log('');
  console.log('Проверить, что свёрток открывается (сделать сейчас, не когда понадобится):');
  console.log(`  node scripts/seal-key-bundle.mjs self-check --in "${outPath}"`);
  console.log('');
  console.log('Дальше — руками, это единственное, что нельзя автоматизировать:');
  console.log('  1) копия на офлайн-носитель (флешка/диск) → в сейф предприятия;');
  console.log('  2) вторая копия ВНЕ здания (носитель у владельца дома либо облако);');
  console.log('  3) пароль записать отдельно от носителей и не на этом компьютере.');
}

async function unseal() {
  const inPath = arg('in');
  const dir = arg('dir');
  if (!inPath || !dir) {
    console.error('Нужны --in <file.sealed> и --dir <куда распаковать>');
    process.exit(2);
  }

  mkdirSync(dir, { recursive: true });
  for (const [name, content] of await openSealed(inPath)) {
    writeFileSync(join(dir, name), content, { mode: 0o600 });
    console.log(`${name}: ${content.length} Б`);
  }
  console.log(`Распаковано в ${dir}`);
}

async function selfCheck() {
  const inPath = arg('in');
  if (!inPath) {
    console.error('Нужен --in <file.sealed>');
    process.exit(2);
  }

  // Proves the sealed file yields byte-identical originals — the difference between "it
  // decrypted" and "it restores what we put in".
  let ok = true;
  for (const [name, content] of await openSealed(inPath)) {
    const original = readFileSync(join(KEYS_DIR, name));
    const same = original.length === content.length && timingSafeEqual(original, content);
    console.log(`${name}: ${same ? 'совпадает с оригиналом' : 'РАСХОЖДЕНИЕ'}`);
    ok &&= same;
  }
  console.log(ok ? 'Свёрток проверен: все файлы восстанавливаются побайтово.' : 'ПРОВЕРКА НЕ ПРОЙДЕНА.');
  process.exitCode = ok ? 0 : 1;
}

const cmd = process.argv[2];
try {
  if (cmd === 'seal') await seal();
  else if (cmd === 'unseal') await unseal();
  else if (cmd === 'self-check') await selfCheck();
  else {
    console.error('Использование: node scripts/seal-key-bundle.mjs seal|unseal|self-check [--out|--in|--dir]');
    process.exit(2);
  }
} finally {
  closeReader();
}
