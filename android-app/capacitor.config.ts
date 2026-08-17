import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.matricarmz.tablet',
  appName: 'MatricaRMZ',
  webDir: 'dist',
  // Консоль WebView в logcat и в release-сборках: единственный планшет в поле
  // отлаживается только через adb, без этого JS-ошибки невидимы (2026-08-17).
  loggingBehavior: 'production',
  android: {
    // Renderer talks to prod over HTTPS only; cleartext stays off.
    allowMixedContent: false,
  },
  plugins: {
    CapacitorSQLite: {
      // SQLCipher replica encryption (parity with the Electron client's encrypted SQLite).
      androidIsEncryption: true,
      androidMasterkeyAlias: 'matricarmz-db-masterkey',
    },
  },
};

export default config;
