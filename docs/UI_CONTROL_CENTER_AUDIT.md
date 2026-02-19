# UI Control Center Audit

Grouped inventory of renderer files with hardcoded UI values that should be moved under centralized UI tokens/settings.

## Menu Buttons

- `electron-app/src/renderer/src/ui/layout/Tabs.tsx`
- `electron-app/src/renderer/src/ui/App.tsx`

## Cards

- `electron-app/src/renderer/src/ui/components/SectionCard.tsx`
- `electron-app/src/renderer/src/ui/components/EntityCardShell.tsx`
- `electron-app/src/renderer/src/ui/pages/*DetailsPage.tsx`

## Lists and Tables

- `electron-app/src/renderer/src/ui/components/DataTable.tsx`
- `electron-app/src/renderer/src/ui/components/TwoColumnList.tsx`
- `electron-app/src/renderer/src/ui/pages/*Page.tsx` list views (`EnginesPage`, `ToolsPage`, `EmployeesPage`, etc.)

## Directories / Masterdata

- `electron-app/src/renderer/src/ui/pages/SimpleMasterdataDetailsPage.tsx`
- `electron-app/src/renderer/src/ui/pages/AdminPage.tsx`
- `electron-app/src/renderer/src/ui/pages/EngineBrandsPage.tsx`
- `electron-app/src/renderer/src/ui/pages/ToolPropertiesPage.tsx`

## Global / Misc

- `electron-app/src/renderer/src/ui/global.css`
- `electron-app/src/renderer/src/ui/components/Button.tsx`
- `electron-app/src/renderer/src/ui/components/Input.tsx`
- `electron-app/src/renderer/src/ui/components/SearchSelect.tsx`
- `electron-app/src/renderer/src/ui/components/AiAgentChat.tsx`
- `electron-app/src/renderer/src/ui/pages/AuthPage.tsx`
- `electron-app/src/renderer/src/ui/pages/SettingsPage.tsx`

## Priority for first migration wave

1. `App.tsx`, `Tabs.tsx` (menu and section controls)
2. `global.css` + shared UI contract as source of truth
3. Base components: `Button.tsx`, `Input.tsx`, `SectionCard.tsx`, `DataTable.tsx`
4. Heaviest pages with many inline styles: `SettingsPage.tsx`, `ToolsPage.tsx`, `NotesPage.tsx`, `SuperadminAuditPage.tsx`
