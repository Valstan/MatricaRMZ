import { basename } from 'node:path';

import { describe, it, expect } from 'vitest';

import { isLaunchableInstallerName, deltaAssemblyTempPath } from './installerNaming.js';

describe('installer naming — delta full-fallback regression', () => {
  it('the OLD `.delta.tmp` assembly name is NOT launchable (this was the field bug)', () => {
    // tryServerDeltaDownload assembled into `<installer>.delta.tmp`; validateInstallerPath
    // rejected the non-.exe name → integrity throw → silent fallback to full download.
    expect(isLaunchableInstallerName('matrica_rmz_update.exe.delta.tmp')).toBe(false);
  });

  it('deltaAssemblyTempPath yields a launchable `.exe` name that passes the installer-name gate', () => {
    const tmp = deltaAssemblyTempPath('C:/Users/x/MatricaRMZ-Updates/matrica_rmz_update.exe');
    expect(isLaunchableInstallerName(basename(tmp))).toBe(true);
    expect(tmp.toLowerCase().endsWith('.exe')).toBe(true);
    // Distinct from the source installer (delta reads the old .exe while writing the temp).
    expect(tmp).not.toBe('C:/Users/x/MatricaRMZ-Updates/matrica_rmz_update.exe');
  });

  it('plain installer names are launchable', () => {
    expect(isLaunchableInstallerName('MatricaRMZ-Setup-2026.625.726.exe')).toBe(true);
    expect(isLaunchableInstallerName('matrica_rmz_update.exe')).toBe(true);
    expect(isLaunchableInstallerName('latest.yml')).toBe(false);
  });
});
