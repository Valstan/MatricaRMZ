export function prependUtf8Bom(content: string): string {
  return '\uFEFF' + content;
}

