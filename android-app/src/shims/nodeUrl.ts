// Шим 'node:url' (android): путей на диске у планшета нет, но ссылка на «файл»
// нужна печати фотографий (fileService печатает картинки через file://-ссылки).
// Ссылка остаётся осмысленной: псевдо-путь планшета в file://-виде.
export function pathToFileURL(path: string): { href: string } {
  const p = String(path ?? '');
  return { href: `file://${p.startsWith('/') ? '' : '/'}${p}` };
}

export function fileURLToPath(url: string): string {
  return String(url ?? '').replace(/^file:\/\//, '');
}

export default { pathToFileURL, fileURLToPath };
