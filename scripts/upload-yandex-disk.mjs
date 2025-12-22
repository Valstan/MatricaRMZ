import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, join, posix as posixPath } from 'node:path';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function normalizeRemotePath(p) {
  // Yandex Disk paths are POSIX-like, must start with /
  let out = p.replaceAll('\\', '/');
  if (!out.startsWith('/')) out = `/${out}`;
  // remove trailing slash (except root)
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

async function yreq(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `OAuth ${token}`,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex API ${res.status} ${res.statusText}: ${text}`);
  }
  return res;
}

async function ensureFolder(token, remotePath) {
  const url =
    'https://cloud-api.yandex.net/v1/disk/resources?' +
    new URLSearchParams({ path: remotePath }).toString();
  // 201 created, 409 already exists, but API returns 409 as error.
  // We'll ignore 409 by probing with GET first.
  try {
    await yreq(url, token, { method: 'GET' });
    return;
  } catch {
    // continue to create
  }
  const res = await fetch(url, { method: 'PUT', headers: { Authorization: `OAuth ${token}` } });
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex mkdir failed ${res.status}: ${text}`);
  }
}

async function uploadFile(token, localFilePath, remoteFilePath) {
  const url =
    'https://cloud-api.yandex.net/v1/disk/resources/upload?' +
    new URLSearchParams({ path: remoteFilePath, overwrite: 'true' }).toString();
  const res = await yreq(url, token, { method: 'GET' });
  const json = await res.json();
  const href = json?.href;
  if (!href) throw new Error(`No upload href for ${remoteFilePath}`);

  const put = await fetch(href, {
    method: 'PUT',
    body: createReadStream(localFilePath),
    // Node.js требует duplex при отправке stream в fetch()
    // (иначе: "duplex option is required when sending a body").
    duplex: 'half',
    headers: {
      // Content-Type is optional for Yandex Disk PUT.
    },
  });
  if (!put.ok) {
    const text = await put.text().catch(() => '');
    throw new Error(`Upload failed ${put.status}: ${text}`);
  }
}

function isReleaseArtifact(filename) {
  const lower = filename.toLowerCase();
  return (
    lower === 'latest.yml' ||
    lower.endsWith('.exe') ||
    lower.endsWith('.blockmap') ||
    lower.endsWith('.zip')
  );
}

async function main() {
  const token = requireEnv('YANDEX_DISK_TOKEN');
  const dir = getArg('--dir') ?? 'electron-app/release';
  const remoteBase = normalizeRemotePath(requireEnv('YANDEX_DISK_FOLDER'));
  const tag = process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || 'unknown';
  const remoteTagFolder = normalizeRemotePath(posixPath.join(remoteBase, tag));
  const remoteLatestFolder = normalizeRemotePath(posixPath.join(remoteBase, 'latest'));

  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).filter(isReleaseArtifact);
  if (files.length === 0) {
    throw new Error(`No release artifacts found in ${dir}`);
  }

  await ensureFolder(token, remoteBase);
  await ensureFolder(token, remoteTagFolder);
  await ensureFolder(token, remoteLatestFolder);

  for (const name of files) {
    const localPath = join(dir, name);
    const remotePath = normalizeRemotePath(posixPath.join(remoteTagFolder, name));
    const remoteLatestPath = normalizeRemotePath(posixPath.join(remoteLatestFolder, name));

    // eslint-disable-next-line no-console
    console.log(`Uploading to Yandex.Disk: ${name}`);
    await uploadFile(token, localPath, remotePath);
    await uploadFile(token, localPath, remoteLatestPath);
  }

  // eslint-disable-next-line no-console
  console.log(`Yandex.Disk upload done: ${remoteTagFolder} and ${remoteLatestFolder}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


