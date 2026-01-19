import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
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
  return lower.endsWith('.exe') || lower.endsWith('.yml') || lower.endsWith('.blockmap');
}

async function listFolder(token, remotePath) {
  const url =
    'https://cloud-api.yandex.net/v1/disk/resources?' +
    new URLSearchParams({ path: remotePath, limit: '200' }).toString();
  const res = await yreq(url, token, { method: 'GET' });
  const json = await res.json();
  const items = (json?._embedded?.items ?? []).filter(Boolean);
  return items.map((x) => ({ name: String(x.name), path: String(x.path), modified: String(x.modified ?? '') }));
}

async function moveResource(token, fromPath, toPath) {
  const url =
    'https://cloud-api.yandex.net/v1/disk/resources/move?' +
    new URLSearchParams({ from: fromPath, path: toPath, overwrite: 'true' }).toString();
  await yreq(url, token, { method: 'POST' });
}

async function deleteResource(token, remotePath) {
  const url =
    'https://cloud-api.yandex.net/v1/disk/resources?' +
    new URLSearchParams({ path: remotePath, permanently: 'true' }).toString();
  await yreq(url, token, { method: 'DELETE' });
}

function extractVersion(name) {
  const m = name.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => Number(x));
  const pb = String(b).split('.').map((x) => Number(x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function parseLatestYmlPath(text) {
  const m = String(text).match(/^path:\s*["']?([^\n"']+)["']?/m);
  return m?.[1]?.trim() ?? null;
}

async function main() {
  const token = requireEnv('YANDEX_DISK_TOKEN');
  const dir = getArg('--dir') ?? 'electron-app/release';
  const remoteBase = normalizeRemotePath(requireEnv('YANDEX_DISK_FOLDER'));
  const remoteLatestFolder = normalizeRemotePath(posixPath.join(remoteBase, 'latest'));

  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).filter(isReleaseArtifact);
  const exe = files.find((f) => f.toLowerCase().endsWith('.exe'));
  if (!exe) {
    throw new Error(`No release artifacts found in ${dir}`);
  }
  const latestYml = files.find((f) => f.toLowerCase() === 'latest.yml') ?? null;
  const latestYmlText = latestYml ? await readFile(join(dir, latestYml), 'utf8').catch(() => '') : '';
  const expectedExeName = parseLatestYmlPath(latestYmlText) ?? exe;
  const blockmap = files.find((f) => f.toLowerCase() === `${exe.toLowerCase()}.blockmap`) ?? null;
  const expectedBlockmapName = `${expectedExeName}.blockmap`;
  const localBlockmap = blockmap ?? files.find((f) => f.toLowerCase().endsWith('.exe.blockmap')) ?? null;

  await ensureFolder(token, remoteBase);
  await ensureFolder(token, remoteLatestFolder);

  // 1) Чистим /latest, чтобы не копился мусор.
  const latestItems = await listFolder(token, remoteLatestFolder).catch(() => []);
  for (const it of latestItems) {
    const lower = it.name.toLowerCase();
    if (!isReleaseArtifact(lower)) continue;
    // В ответах API поле path обычно вида "disk:/...". Его нельзя прогонять через normalizeRemotePath.
    if (lower.endsWith('.exe')) {
      const from = it.path;
      const to = normalizeRemotePath(posixPath.join(remoteBase, it.name));
      // eslint-disable-next-line no-console
      console.log(`Moving old latest -> root: ${it.name}`);
      await moveResource(token, from, to);
      continue;
    }
    // Остальные артефакты (yml/blockmap) удаляем из latest.
    const p = it.path;
    // eslint-disable-next-line no-console
    console.log(`Deleting old latest artifact: ${it.name}`);
    await deleteResource(token, p);
  }

  // 2) Загружаем новый installer + latest.yml + blockmap в /latest.
  const latestUploads = [
    { name: expectedExeName, local: join(dir, exe), remote: normalizeRemotePath(posixPath.join(remoteLatestFolder, expectedExeName)) },
  ];
  if (latestYml) {
    latestUploads.push({
      name: latestYml,
      local: join(dir, latestYml),
      remote: normalizeRemotePath(posixPath.join(remoteLatestFolder, latestYml)),
    });
  }
  if (localBlockmap) {
    latestUploads.push({
      name: expectedBlockmapName,
      local: join(dir, localBlockmap),
      remote: normalizeRemotePath(posixPath.join(remoteLatestFolder, expectedBlockmapName)),
    });
  }
  for (const f of latestUploads) {
    // eslint-disable-next-line no-console
    console.log(`Uploading to latest: ${f.name}`);
    await uploadFile(token, f.local, f.remote);
  }

  // 3) Храним в корне только 3 последние версии (по semver из имени, иначе по modified).
  const rootItems = await listFolder(token, remoteBase);
  const exes = rootItems.filter((x) => x.name.toLowerCase().endsWith('.exe'));
  const withVer = exes.map((x) => ({ ...x, ver: extractVersion(x.name) }));
  withVer.sort((a, b) => {
    if (a.ver && b.ver) return compareSemver(b.ver, a.ver);
    return String(b.modified).localeCompare(String(a.modified));
  });
  const keep = new Set(withVer.slice(0, 3).map((x) => x.name));
  for (const x of withVer.slice(3)) {
    if (keep.has(x.name)) continue;
    // В ответах API поле path обычно вида "disk:/...". Его нельзя прогонять через normalizeRemotePath.
    const p = x.path;
    // eslint-disable-next-line no-console
    console.log(`Deleting old installer: ${x.name}`);
    await deleteResource(token, p);
  }

  // eslint-disable-next-line no-console
  console.log(`Yandex.Disk upload done: ${remoteLatestFolder} (latest exe/yml/blockmap) and root keep=3`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


