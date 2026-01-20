export type PrintSection = {
  id: string;
  title: string;
  html: string;
  checked?: boolean;
};

export function escapeHtml(s: string) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function openPrintPreview(opts: { title: string; subtitle?: string; sections: PrintSection[] }) {
  const title = escapeHtml(opts.title);
  const subtitle = opts.subtitle ? escapeHtml(opts.subtitle) : '';
  const controls = opts.sections
    .map((s) => {
      const checked = s.checked === false ? '' : 'checked';
      return `<label class="toggle">
  <input type="checkbox" data-section="${escapeHtml(s.id)}" ${checked}/>
  <span>${escapeHtml(s.title)}</span>
</label>`;
    })
    .join('\n');
  const content = opts.sections
    .map((s) => {
      const html = s.html?.trim() ? s.html : `<div class="muted">Нет данных</div>`;
      return `<section class="section" data-print-section="${escapeHtml(s.id)}">
  <h2>${escapeHtml(s.title)}</h2>
  ${html}
</section>`;
    })
    .join('\n');

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${title}</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 24px; color: #0b1220; }
    h1 { margin: 0 0 6px 0; font-size: 20px; }
    h2 { margin: 0 0 8px 0; font-size: 14px; }
    .subtitle { color: #6b7280; font-size: 12px; margin-bottom: 14px; }
    .controls { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; align-items: center; }
    .toggle { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; color: #111827; }
    .action { margin-left: auto; }
    button { border: 1px solid #cbd5f5; background: #2563eb; color: #fff; padding: 6px 12px; border-radius: 8px; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 12px; vertical-align: top; }
    th { background: #f8fafc; }
    ul { margin: 0; padding-left: 18px; }
    .section { margin-bottom: 16px; }
    .muted { color: #6b7280; }
    @media print { .no-print { display: none; } body { margin: 12mm; } }
  </style>
</head>
<body>
  <div class="no-print">
    <h1>${title}</h1>
    ${subtitle ? `<div class="subtitle">${subtitle}</div>` : ''}
    <div class="controls">
      ${controls}
      <button class="action" onclick="window.print()">Отправить на принтер</button>
    </div>
  </div>
  ${content}
  <script>
    const toggles = Array.from(document.querySelectorAll('input[data-section]'));
    function applyVisibility() {
      toggles.forEach((cb) => {
        const id = cb.getAttribute('data-section');
        const el = document.querySelector('[data-print-section="' + id + '"]');
        if (el) el.style.display = cb.checked ? '' : 'none';
      });
    }
    toggles.forEach((cb) => cb.addEventListener('change', applyVisibility));
    applyVisibility();
  </script>
</body>
</html>`;

  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.focus(), 200);
}
