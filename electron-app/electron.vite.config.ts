import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          update: resolve(__dirname, 'src/preload/update.ts'),
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
    build: {
      outDir: 'dist/renderer',
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
            if (normalized.includes('/node_modules/')) {
              return 'vendor';
            }
            if (normalized.includes('/shared/src/')) {
              return 'shared';
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
                normalized.includes('/ProductsPage.') ||
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
                normalized.includes('/ReportsPage.') ||
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
      },
    },
    plugins: [react()],
  },
});


