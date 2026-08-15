// Номер версии программы за свою жизнь сменил три схемы:
//   1.x.y          — самая первая нумерация (эпоха 0, в парке её уже нет);
//   2026.814.1503  — CalVer, дата сборки как semver (эпоха 1, см. calver.ts);
//   3.1.0, 3.2.0…  — поколение программы + порядковый номер релиза (эпоха 2),
//                    пользователю показывается как «Матрица3-РМЗ (1)».
//
// Числовое сравнение слева направо на границе схем ВРЁТ: 3 меньше 2026, то есть
// новая нумерация выглядит откатом назад, и самообновление у клиента встаёт
// намертво — он считает свежий релиз старее установленного. Поэтому сравниваем
// сначала по эпохе, и только внутри одной эпохи — по числам.
//
// Понимать эпоху обязан УЖЕ УСТАНОВЛЕННЫЙ клиент: версию с сервера он сравнивает
// со своей сам, своим кодом. Поэтому эта функция уехала в парк мост-релизом
// (последним CalVer) ДО того, как появился первый 3.x. Клиент, пропустивший мост,
// на 3.x сам не обновится — только переустановкой руками.

// Текущее поколение программы. Заодно нижняя граница эпохи 2: всё, что меньше,
// относится к добро-CalVer'ной нумерации 1.x/2.x.
export const APP_GENERATION = 3;

// CalVer начинается с года, поэтому мажор у него заведомо четырёхзначный.
const CALVER_MIN_MAJOR = 2000;

export const VERSION_EPOCH_LEGACY = 0;
export const VERSION_EPOCH_CALVER = 1;
export const VERSION_EPOCH_GENERATION = 2;

function versionSegments(version: string): number[] | null {
  const m = String(version ?? '')
    .trim()
    .match(/^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/);
  if (!m?.[1]) return null;
  const parts = m[1].split('.').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts;
}

// Какой схеме нумерации принадлежит версия; null — строка вообще не версия.
export function versionEpoch(version: string): number | null {
  const parts = versionSegments(version);
  if (!parts) return null;
  const major = parts[0] ?? 0;
  if (major >= CALVER_MIN_MAJOR) return VERSION_EPOCH_CALVER;
  if (major >= APP_GENERATION) return VERSION_EPOCH_GENERATION;
  return VERSION_EPOCH_LEGACY;
}

// -1/0/1 для «a старее / та же / новее b». Версия более поздней эпохи всегда
// новее любой версии ранней, сколько бы там ни было в мажоре. Нераспознанная
// строка с любой стороны → 0: обновляться на непонятное нельзя, но и объявлять
// его устаревшим тоже (прежнее поведение обоих клиентских сравнений).
export function compareAppVersion(a: string, b: string): number {
  const pa = versionSegments(a);
  const pb = versionSegments(b);
  if (!pa || !pb) return 0;
  const ea = versionEpoch(a);
  const eb = versionEpoch(b);
  if (ea === null || eb === null) return 0;
  if (ea !== eb) return ea > eb ? 1 : -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db ? 1 : -1;
  }
  return 0;
}
