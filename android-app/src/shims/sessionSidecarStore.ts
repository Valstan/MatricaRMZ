// Шим sessionSidecarStore для android: sidecar-копия сессии — десктопный
// механизм переживания пересборки userData-БД (%APPDATA%\MatricaRMZ). На
// планшете реплика/сессия живут в WebView-хранилище, а reset перекрыт
// setResetLocalDatabaseImpl — sidecar здесь честный no-op.

export function readSidecarSession(): { enc: true; data: string } | null {
  return null;
}

export function writeSidecarSession(_stored: { enc: boolean; data: string }): void {
  // no-op
}

export function clearSidecarSession(): void {
  // no-op
}
