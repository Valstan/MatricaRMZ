/**
 * Restyle stage 2 (density) — push the denser table/list/card baseline to the
 * GLOBAL UI defaults so existing clients actually re-pull it.
 *
 * Why a script and not just a code-default change: table/list density is a
 * RUNTIME setting stored in the DB (GLOBAL `client_settings.uiGlobalSettingsJson`),
 * seeded from `DEFAULT_UI_CONTROL_SETTINGS` only when the row is first created.
 * Changing the code default reaches fresh installs only; existing deployments keep
 * the previously-seeded values. `setGlobalUiDefaults` + a version bump is the
 * intended channel: clients compare `uiDefaultsVersion` and re-pull when it rises.
 *
 * The client `effective` settings resolve to `presets.profiles[defaultPresetId]`
 * (default = `medium`), so this tightens the `medium` profile (and the top-level
 * working copy). Idempotent: uses Math.min, so it only ever tightens and re-runs
 * are no-ops. small/large/xlarge presets are left untouched (intentionally roomier).
 *
 * Dry-run by default (no writes, no version bump). Flag: --apply
 *   pnpm -F @matricarmz/backend-api ui:tighten-global-density            # dry-run
 *   pnpm -F @matricarmz/backend-api ui:tighten-global-density --apply
 */
import 'dotenv/config';

import { sanitizeUiControlSettings, type UiControlSettings, type UiControlTuning } from '@matricarmz/shared';

import { pool } from '../database/db.js';
import { getGlobalUiDefaults, setGlobalUiDefaults } from '../services/clientSettingsService.js';

const APPLY = process.argv.includes('--apply');

// Excel-dense baseline (matches the new DEFAULT_UI_CONTROL_SETTINGS code default).
const TARGET = { listsRowPaddingY: 3, cardsRowPaddingY: 3, cardsRowGap: 3 } as const;

function tightenTuning(t: UiControlTuning): { changed: boolean; before: Record<string, number>; after: Record<string, number> } {
  const before = { listsRowPaddingY: t.lists.rowPaddingY, cardsRowPaddingY: t.cards.rowPaddingY, cardsRowGap: t.cards.rowGap };
  t.lists.rowPaddingY = Math.min(t.lists.rowPaddingY, TARGET.listsRowPaddingY);
  t.cards.rowPaddingY = Math.min(t.cards.rowPaddingY, TARGET.cardsRowPaddingY);
  t.cards.rowGap = Math.min(t.cards.rowGap, TARGET.cardsRowGap);
  const after = { listsRowPaddingY: t.lists.rowPaddingY, cardsRowPaddingY: t.cards.rowPaddingY, cardsRowGap: t.cards.rowGap };
  const changed = before.listsRowPaddingY !== after.listsRowPaddingY || before.cardsRowPaddingY !== after.cardsRowPaddingY || before.cardsRowGap !== after.cardsRowGap;
  return { changed, before, after };
}

async function main(): Promise<void> {
  const current = await getGlobalUiDefaults();
  const settings = sanitizeUiControlSettings(JSON.parse(current.settings)) as UiControlSettings;

  const targetPreset = settings.presets.defaultPresetId; // client effective = profiles[defaultPresetId]
  const profile = settings.presets.profiles[targetPreset];

  const profileDelta = tightenTuning(profile);
  // top-level working copy mirrors the editor preset; tighten it too for consistency
  const topDelta = tightenTuning(settings);

  const anyChange = profileDelta.changed || topDelta.changed;

  console.log('=== tighten-global-ui-density ===');
  console.log('current version:', current.version);
  console.log('default preset :', targetPreset);
  console.log(`profile.${targetPreset} density:`, profileDelta.before, '->', profileDelta.after, profileDelta.changed ? '(changed)' : '(already dense)');
  console.log('top-level density:', topDelta.before, '->', topDelta.after, topDelta.changed ? '(changed)' : '(already dense)');

  if (!anyChange) {
    console.log('Nothing to do — already at or below target density. No version bump.');
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY-RUN: would write tightened defaults and bump version ${current.version} -> ${current.version + 1}.`);
    console.log('Re-run with --apply to persist (clients re-pull on the higher version).');
    return;
  }

  const res = await setGlobalUiDefaults({ settings, bumpVersion: true });
  console.log(`\nAPPLIED: version ${current.version} -> ${res.version}. Clients will re-pull the denser defaults on next fetch.`);
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error(err);
    return pool.end().finally(() => process.exit(1));
  });
