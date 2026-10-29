import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'dist/main'),
      emptyOutDir: true,
      rollupOptions: {
        // Два входа: главный процесс и движок синка, который живёт отдельным
        // `utilityProcess` (docs/plans/client-ram-cache-and-sync-worker-2026-10.md).
        // Формат у обоих общий (CJS), поэтому `__dirname` в воркере работает.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          syncWorker: resolve(__dirname, 'src/main/workers/syncWorker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: resolve(__dirname, 'dist/preload'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          update: resolve(__dirname, 'src/preload/update.ts'),
          startup: resolve(__dirname, 'src/preload/startup.ts'),
        },
        output: {
          // В Windows preload по умолчанию исполняется как CommonJS.
          // ESM preload (.mjs) может падать с "Cannot use import statement outside a module".
          format: 'cjs',
          // Явно используем .cjs, чтобы Electron не пытался интерпретировать как ESM.
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    server: {
      // Force IPv4: vite default 'localhost' may bind only to [::1] on Windows,
      // while Electron main loadURL('http://localhost:5173') resolves IPv4
      // and falls back to loadFile(dist) on miss — masking stale UI.
      host: '127.0.0.1',
    },
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replaceAll('\\', '/');
            if (normalized.includes('/node_modules/react-datepicker/') || normalized.includes('/node_modules/date-fns/')) {
              return 'date-ui';
            }
            if (
              normalized.includes('/node_modules/react/') ||
              normalized.includes('/node_modules/react-dom/') ||
              normalized.includes('/node_modules/scheduler/')
            ) {
              return 'react-vendor';
            }
            if (
              normalized.includes('/node_modules/@matricarmz/shared/') ||
              normalized.includes('/node_modules/@matricarmz/ledger/')
            ) {
              return 'shared';
            }
            if (normalized.includes('/node_modules/')) {
              return 'vendor';
            }
            if (normalized.includes('/shared/src/')) {
              return 'shared';
            }
            // theme.ts — лист: в нём нет ни одного импорта, только объявление
            // `export const theme`. Кладём его в отдельный чанк, чтобы он
            // гарантированно инициализировался раньше любого потребителя.
            //
            // Без этого Rollup уносил theme.ts в чанк страниц (`pages-control`),
            // а `pages-control` импортирует `ui-components` — и `ui-components`
            // читает theme на уровне модуля (`const STATE_TONE = { planned:
            // theme.colors.subtle }`). Получается цикл чанков, и при загрузке
            // рендерера падает TDZ: «Cannot access 'theme' before initialization» —
            // `main.tsx` не стартует, окно вечно показывает «Загрузка интерфейса…».
            // Это уронило релиз 3.89.0 (весь парк Windows-клиентов).
            if (normalized.endsWith('/src/renderer/src/ui/theme.ts')) {
              return 'ui-theme';
            }
            if (normalized.includes('/src/renderer/src/ui/pages/')) {
              if (
                normalized.includes('/EnginesPage.') ||
                normalized.includes('/EngineDetailsPage.') ||
                normalized.includes('/EngineBrandsPage.') ||
                normalized.includes('/EngineBrandDetailsPage.') ||
                normalized.includes('/PartsPage.') ||
                normalized.includes('/PartDetailsPage.') ||
                normalized.includes('/PartTemplatesPage.') ||
                normalized.includes('/PartTemplateDetailsPage.')
              ) {
                return 'pages-production';
              }
              if (
                normalized.includes('/ContractsPage.') ||
                normalized.includes('/ContractDetailsPage.')
              ) {
                return 'pages-contracts';
              }
              if (
                normalized.includes('/CounterpartiesPage.') ||
                normalized.includes('/CounterpartyDetailsPage.')
              ) {
                return 'pages-counterparties';
              }
              if (
                normalized.includes('/SupplyRequestsPage.') ||
                normalized.includes('/SupplyRequestDetailsPage.') ||
                normalized.includes('/WorkOrdersPage.') ||
                normalized.includes('/WorkOrderDetailsPage.')
              ) {
                return 'pages-supply';
              }
              if (
                normalized.includes('/NomenclaturePage.') ||
                normalized.includes('/NomenclatureDetailsPage.') ||
                normalized.includes('/StockBalancesPage.') ||
                normalized.includes('/StockDocumentsPage.') ||
                normalized.includes('/StockDocumentDetailsPage.') ||
                normalized.includes('/StockInventoryPage.')
              ) {
                return 'pages-warehouse';
              }
              if (
                normalized.includes('/ToolsPage.') ||
                normalized.includes('/ToolDetailsPage.') ||
                normalized.includes('/ToolPropertiesPage.') ||
                normalized.includes('/ToolPropertyDetailsPage.') ||
                normalized.includes('/EmployeesPage.') ||
                normalized.includes('/EmployeeDetailsPage.') ||
                normalized.includes('/ServicesPage.') ||
                normalized.includes('/SimpleMasterdataDetailsPage.')
              ) {
                return 'pages-masterdata';
              }
              if (
                normalized.includes('/HistoryPage.') ||
                normalized.includes('/NotesPage.')
              ) {
                return 'pages-history';
              }
              if (
                normalized.includes('/AuthPage.') ||
                normalized.includes('/SettingsPage.')
              ) {
                return 'pages-session';
              }
              if (
                normalized.includes('/ChangesPage.') ||
                normalized.includes('/SuperadminAuditPage.')
              ) {
                return 'pages-analytics';
              }
              if (normalized.includes('/AdminPage.')) {
                return 'pages-admin';
              }
              return 'pages-control';
            }
            if (normalized.includes('/src/renderer/src/ui/components/')) {
              return 'ui-components';
            }
            if (normalized.includes('/src/renderer/src/ui/hooks/') || normalized.includes('/src/renderer/src/ui/utils/')) {
              return 'ui-runtime';
            }
            return undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@matricarmz/shared': resolve(__dirname, '../shared/src/index.ts'),
      },
    },
    plugins: [react()],
  },
});


