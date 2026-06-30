// Имена installer-файлов авто-апдейтера. Чистый модуль (без electron/IO) — тестируется напрямую.

/** Файл считается запускаемым installer'ом только с расширением .exe. */
export function isLaunchableInstallerName(name: string): boolean {
  return name.toLowerCase().endsWith('.exe');
}

/**
 * Путь временного файла сборки blockmap-delta. КРИТИЧНО: оканчивается на `.exe`.
 *
 * validateInstallerPath отвергает не-`.exe` имена. Раньше delta собиралась в
 * `<installer>.delta.tmp` → `validateInstallerIntegrity` падал на расширении → throw →
 * молчаливый откат на полную закачку. Симптом в поле: клиент догружает «только
 * изменения» (~10 МБ), затем всё равно качает полный installer (~111 МБ). Системно
 * (каждая delta), без следа в логе. См. installerNaming.test.ts.
 */
export function deltaAssemblyTempPath(stableInstallerPath: string): string {
  return `${stableInstallerPath}.delta-new.exe`;
}
