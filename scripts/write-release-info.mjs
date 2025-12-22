import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function env(name) {
  return process.env[name] ?? '';
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

async function ensurePublished(token, folderPath) {
  const publishUrl =
    'https://cloud-api.yandex.net/v1/disk/resources/publish?' +
    new URLSearchParams({ path: folderPath }).toString();

  // publish может вернуть 409 если уже опубликовано — это нормально
  const res = await fetch(publishUrl, {
    method: 'PUT',
    headers: { Authorization: `OAuth ${token}` },
  });
  if (!res.ok && res.status !== 409) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yandex publish failed ${res.status}: ${text}`);
  }

  const infoUrl =
    'https://cloud-api.yandex.net/v1/disk/resources?' +
    new URLSearchParams({ path: folderPath, fields: 'public_url' }).toString();
  const infoRes = await yreq(infoUrl, token, { method: 'GET' });
  const json = await infoRes.json();
  if (!json?.public_url) throw new Error('Yandex did not return public_url');
  return String(json.public_url);
}

async function main() {
  const releaseDate = new Date().toISOString();
  const token = env('YANDEX_DISK_TOKEN');
  const folder = env('YANDEX_DISK_FOLDER'); // например: /matricarmz

  const info = { releaseDate };

  if (token && folder) {
    const publicUrl = await ensurePublished(token, folder);
    info.update = {
      provider: 'yandex',
      // В electron-app мы будем использовать это как public_key
      yandexPublicKey: publicUrl,
      // А путь внутри public ресурса будет относительным: latest/latest.yml
      yandexBasePath: 'latest',
    };
  }

  const outPath = join(process.cwd(), 'electron-app', 'release-info.json');
  await writeFile(outPath, JSON.stringify(info, null, 2), 'utf8');
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(info));
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(String(e));
  process.exit(1);
});


