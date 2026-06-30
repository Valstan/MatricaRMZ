// CalVer релизной версии: дата сборки как валидный монотонный semver.
// Формат: YYYY.(MM*100+DD).(HH*100+MM) — напр. 2026-06-14 15:30 → "2026.614.1530".
// Сегменты без ведущих нулей (semver их запрещает): MM*100+DD ≥ 101, HH*100+MM ≥ 0.
// Монотонно по времени (год → месяц-день → час-минута); любой CalVer > старого 1.x.
// Канонический генератор/парсер — здесь; scripts/bump-version.mjs дублирует формулу
// генерации (3 строки) намеренно, чтобы остаться dependency-free Node-скриптом.

export type CalverParts = { year: number; month: number; day: number; hour: number; minute: number };

export function calverFromDate(d: Date): string {
  const year = d.getFullYear();
  const monthDay = (d.getMonth() + 1) * 100 + d.getDate();
  const hourMinute = d.getHours() * 100 + d.getMinutes();
  return `${year}.${monthDay}.${hourMinute}`;
}

export function parseCalver(version: string): CalverParts | null {
  const m = String(version ?? '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const year = Number(m[1]);
  const md = Number(m[2]);
  const hm = Number(m[3]);
  const month = Math.floor(md / 100);
  const day = md % 100;
  const hour = Math.floor(hm / 100);
  const minute = hm % 100;
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return { year, month, day, hour, minute };
}

// Сравнение двух CalVer-строк по монотонным сегментам (year → MM*100+DD →
// HH*100+MM). Возвращает -1/0/1, либо null если хотя бы одна — не CalVer
// (напр. старая 1.x), чтобы вызывающий явно решил, как трактовать неизвестное.
export function compareCalver(a: string, b: string): number | null {
  const pa = parseCalver(a);
  const pb = parseCalver(b);
  if (!pa || !pb) return null;
  if (pa.year !== pb.year) return pa.year < pb.year ? -1 : 1;
  const mdA = pa.month * 100 + pa.day;
  const mdB = pb.month * 100 + pb.day;
  if (mdA !== mdB) return mdA < mdB ? -1 : 1;
  const hmA = pa.hour * 100 + pa.minute;
  const hmB = pb.hour * 100 + pb.minute;
  if (hmA !== hmB) return hmA < hmB ? -1 : 1;
  return 0;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// Человекочитаемая дата сборки из CalVer; null для не-CalVer (старые 1.x) → вызывающий
// падает на сырую строку версии.
export function formatCalverBuildDate(version: string): string | null {
  const p = parseCalver(version);
  if (!p) return null;
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year} ${pad2(p.hour)}:${pad2(p.minute)}`;
}
