export const theme = {
  colors: {
    // background / surfaces
    appBgFrom: '#0b1024',
    appBgVia: '#0b3b8a',
    appBgTo: '#7c1d6f',
    surface: 'rgba(255,255,255,0.94)',
    surface2: 'rgba(255,255,255,0.88)',
    border: 'rgba(15, 23, 42, 0.18)',
    borderStrong: 'rgba(15, 23, 42, 0.28)',
    text: '#0b1220',
    muted: '#334155',
    subtle: '#64748b',
    danger: '#b91c1c',
    success: '#15803d',
    warn: '#b45309',
  },
  accents: {
    engines: { bg: '#1d4ed8', border: '#1e40af', text: '#ffffff' },
    auth: { bg: '#7c3aed', border: '#5b21b6', text: '#ffffff' },
    sync: { bg: '#ea580c', border: '#c2410c', text: '#ffffff' },
    reports: { bg: '#059669', border: '#047857', text: '#ffffff' },
    admin: { bg: '#db2777', border: '#9d174d', text: '#ffffff' },
    audit: { bg: '#0891b2', border: '#0e7490', text: '#ffffff' },
    neutral: { bg: '#0f172a', border: '#0b1220', text: '#ffffff' },
  },
} as const;

export type AccentKey = keyof typeof theme.accents;

export function tabAccent(tab: string): AccentKey {
  if (tab === 'engines' || tab === 'engine') return 'engines';
  if (tab === 'auth') return 'auth';
  if (tab === 'sync') return 'sync';
  if (tab === 'reports') return 'reports';
  if (tab === 'admin') return 'admin';
  if (tab === 'audit') return 'audit';
  return 'neutral';
}


