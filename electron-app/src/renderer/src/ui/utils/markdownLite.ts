function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+?)`/g, (_, code: string) => `<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;font-family:ui-monospace,monospace;font-size:0.9em">${code}</code>`);
  out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<![*_])\*([^*\n]+?)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/(?<!_)_([^_\n]+?)_(?!_)/g, '<em>$1</em>');
  return out;
}

function renderCodeBlock(lines: string[], lang: string): string {
  const isSql = /^sql$/i.test(lang);
  const body = lines.map(escapeHtml).join('\n');
  const styled = isSql ? body.replace(/\b(SELECT|FROM|WHERE|JOIN|ON|GROUP BY|ORDER BY|LIMIT|AND|OR|AS|NULL|NOT|IN|IS|HAVING|UNION|LEFT|RIGHT|INNER|OUTER|DESC|ASC|COUNT|SUM|MIN|MAX|AVG|DISTINCT)\b/gi, '<span style="color:#0b6">$1</span>') : body;
  return `<pre style="background:rgba(0,0,0,0.06);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0;font-family:ui-monospace,monospace;font-size:0.85em;line-height:1.35"><code>${styled}</code></pre>`;
}

export function renderMarkdown(input: string): string {
  const text = String(input ?? '');
  if (!text.trim()) return '';
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  let inUl = false;
  let inOl = false;
  const closeLists = () => {
    if (inUl) {
      out.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      out.push('</ol>');
      inOl = false;
    }
  };
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.trimEnd();
    const fence = /^```\s*([a-z0-9_-]*)\s*$/i.exec(line);
    if (fence) {
      closeLists();
      const lang = fence[1] ?? '';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++;
      out.push(renderCodeBlock(buf, lang));
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      closeLists();
      const level = Math.min(3, (h[1] ?? '').length);
      out.push(`<h${level + 3} style="margin:6px 0 4px;font-size:${1.05 - level * 0.05}em">${renderInline(h[2] ?? '')}</h${level + 3}>`);
      i++;
      continue;
    }
    const ol = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      if (inUl) {
        out.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        out.push('<ol style="margin:4px 0;padding-left:20px">');
        inOl = true;
      }
      out.push(`<li>${renderInline(ol[2] ?? '')}</li>`);
      i++;
      continue;
    }
    const ul = /^[*-]\s+(.+)$/.exec(line);
    if (ul) {
      if (inOl) {
        out.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        out.push('<ul style="margin:4px 0;padding-left:20px">');
        inUl = true;
      }
      out.push(`<li>${renderInline(ul[1] ?? '')}</li>`);
      i++;
      continue;
    }
    if (line === '') {
      closeLists();
      out.push('<div style="height:6px"></div>');
      i++;
      continue;
    }
    closeLists();
    out.push(`<div>${renderInline(line)}</div>`);
    i++;
  }
  closeLists();
  return out.join('');
}
