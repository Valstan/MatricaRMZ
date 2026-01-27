export const theme = {
  colors: {
    // background / surfaces
    appBgFrom: 'var(--app-bg-from)',
    appBgVia: 'var(--app-bg-via)',
    appBgTo: 'var(--app-bg-to)',
    surface: 'var(--surface)',
    surface2: 'var(--surface-2)',
    border: 'var(--border)',
    borderStrong: 'var(--border-strong)',
    text: 'var(--text)',
    muted: 'var(--muted)',
    subtle: 'var(--subtle)',
    danger: 'var(--danger)',
    success: 'var(--success)',
    warn: 'var(--warn)',
    chatMineBg: 'var(--chat-mine-bg)',
    chatMineBorder: 'var(--chat-mine-border)',
    chatOtherBg: 'var(--chat-other-bg)',
    chatOtherBorder: 'var(--chat-other-border)',
    chatMenuBg: 'var(--chat-menu-bg)',
    chatMenuBorder: 'var(--chat-menu-border)',
    chatMenuShadow: 'var(--chat-menu-shadow)',
  },
  accents: {
    engines: { bg: '#1d4ed8', border: '#1e40af', text: '#ffffff' },
    auth: { bg: '#7c3aed', border: '#5b21b6', text: '#ffffff' },
    sync: { bg: '#ea580c', border: '#c2410c', text: '#ffffff' },
    reports: { bg: '#059669', border: '#047857', text: '#ffffff' },
    requests: { bg: '#a21caf', border: '#701a75', text: '#ffffff' },
    admin: { bg: '#db2777', border: '#9d174d', text: '#ffffff' },
    audit: { bg: '#0891b2', border: '#0e7490', text: '#ffffff' },
    changes: { bg: '#16a34a', border: '#15803d', text: '#ffffff' },
    employees: { bg: '#0f766e', border: '#0d9488', text: '#ffffff' },
    neutral: { bg: '#0f172a', border: '#0b1220', text: '#ffffff' },
  },
} as const;

export type AccentKey = keyof typeof theme.accents;

export function tabAccent(tab: string): AccentKey {
  if (tab === 'engines' || tab === 'engine' || tab === 'engine_brands' || tab === 'engine_brand') return 'engines';
  if (tab === 'auth') return 'auth';
  if (tab === 'reports') return 'reports';
  if (tab === 'requests' || tab === 'request') return 'requests';
  if (tab === 'employees' || tab === 'employee') return 'employees';
  if (tab === 'admin' || tab === 'masterdata' || tab === 'products' || tab === 'product' || tab === 'services' || tab === 'service')
    return 'admin';
  if (tab === 'audit') return 'audit';
  if (tab === 'changes') return 'changes';
  if (tab === 'notes') return 'reports';
  return 'neutral';
}


