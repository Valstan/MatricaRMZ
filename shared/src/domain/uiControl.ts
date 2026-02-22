export type UiDisplayTarget = 'departmentButtons' | 'sectionButtons' | 'listFont' | 'cardFont';
export type UiDisplayButtonState = 'active' | 'inactive';
export const UI_PRESET_IDS = ['small', 'medium', 'large', 'xlarge'] as const;
export type UiPresetId = (typeof UI_PRESET_IDS)[number];
export const DEFAULT_UI_PRESET_ID: UiPresetId = 'medium';

export type UiDisplayButtonStyle = {
  fontSize: number;
  width: number;
  height: number;
  paddingX: number;
  paddingY: number;
  gap: number;
};

export type UiDisplayButtonConfig = {
  active: UiDisplayButtonStyle;
  inactive: UiDisplayButtonStyle;
};

export type UiDisplayPrefs = {
  selectedTarget: UiDisplayTarget;
  selectedButtonState: UiDisplayButtonState;
  departmentButtons: UiDisplayButtonConfig;
  sectionButtons: UiDisplayButtonConfig;
  listFontSize: number;
  cardFontSize: number;
};

export type UiControlTuning = {
  global: {
    titleFontSize: number;
    sectionFontSize: number;
    bodyFontSize: number;
    mutedFontSize: number;
    space1: number;
    space2: number;
    space3: number;
    space4: number;
    space5: number;
  };
  menuButtons: {
    selectedTarget: UiDisplayTarget;
    selectedButtonState: UiDisplayButtonState;
    departmentButtons: UiDisplayButtonConfig;
    sectionButtons: UiDisplayButtonConfig;
  };
  cards: {
    fontSize: number;
    rowGap: number;
    rowPaddingY: number;
    rowPaddingX: number;
    sectionAltBackgrounds: boolean;
    sectionAltStrength: number;
  };
  lists: {
    fontSize: number;
    rowPaddingY: number;
    rowPaddingX: number;
    textColumnMaxCh: number;
    autoColumnsEnabled: boolean;
    autoColumnsMax: number;
    autoColumnsGapPx: number;
  };
  directories: {
    tableFontSize: number;
    entityCardMinWidth: number;
  };
  layout: {
    contentMaxWidth: number;
    blockMinWidth: number;
    blockMaxWidth: number;
  };
  misc: {
    datePickerScale: number;
    datePickerFontSize: number;
  };
  inputs: {
    autoGrowAllFields: boolean;
    autoGrowMinChars: number;
    autoGrowMaxChars: number;
    autoGrowExtraChars: number;
  };
};

export type UiControlSettings = UiControlTuning & {
  presets: {
    defaultPresetId: UiPresetId;
    editorPresetId: UiPresetId;
    profiles: Record<UiPresetId, UiControlTuning>;
  };
};

export const UI_DEFAULTS_VERSION = 1;

export const DEFAULT_UI_DISPLAY_PREFS: UiDisplayPrefs = {
  selectedTarget: 'departmentButtons',
  selectedButtonState: 'active',
  departmentButtons: {
    active: { fontSize: 26, width: 240, height: 152, paddingX: 16, paddingY: 5, gap: 8 },
    inactive: { fontSize: 26, width: 240, height: 152, paddingX: 16, paddingY: 5, gap: 8 },
  },
  sectionButtons: {
    active: { fontSize: 24, width: 200, height: 64, paddingX: 18, paddingY: 8, gap: 6 },
    inactive: { fontSize: 24, width: 200, height: 64, paddingX: 18, paddingY: 8, gap: 6 },
  },
  listFontSize: 14,
  cardFontSize: 14,
};

const DEFAULT_UI_CONTROL_TUNING: UiControlTuning = {
  global: {
    titleFontSize: 18,
    sectionFontSize: 15,
    bodyFontSize: 13,
    mutedFontSize: 12,
    space1: 4,
    space2: 8,
    space3: 12,
    space4: 16,
    space5: 20,
  },
  menuButtons: {
    selectedTarget: DEFAULT_UI_DISPLAY_PREFS.selectedTarget,
    selectedButtonState: DEFAULT_UI_DISPLAY_PREFS.selectedButtonState,
    departmentButtons: {
      active: { ...DEFAULT_UI_DISPLAY_PREFS.departmentButtons.active },
      inactive: { ...DEFAULT_UI_DISPLAY_PREFS.departmentButtons.inactive },
    },
    sectionButtons: {
      active: { ...DEFAULT_UI_DISPLAY_PREFS.sectionButtons.active },
      inactive: { ...DEFAULT_UI_DISPLAY_PREFS.sectionButtons.inactive },
    },
  },
  cards: {
    fontSize: DEFAULT_UI_DISPLAY_PREFS.cardFontSize,
    rowGap: 4,
    rowPaddingY: 4,
    rowPaddingX: 6,
    sectionAltBackgrounds: true,
    sectionAltStrength: 8,
  },
  lists: {
    fontSize: DEFAULT_UI_DISPLAY_PREFS.listFontSize,
    rowPaddingY: 4,
    rowPaddingX: 6,
    textColumnMaxCh: 48,
    autoColumnsEnabled: true,
    autoColumnsMax: 3,
    autoColumnsGapPx: 10,
  },
  directories: {
    tableFontSize: 13,
    entityCardMinWidth: 520,
  },
  layout: {
    contentMaxWidth: 1600,
    blockMinWidth: 420,
    blockMaxWidth: 920,
  },
  misc: {
    datePickerScale: 2,
    datePickerFontSize: 14,
  },
  inputs: {
    autoGrowAllFields: true,
    autoGrowMinChars: 10,
    autoGrowMaxChars: 48,
    autoGrowExtraChars: 2,
  },
};

function cloneUiControlTuning(tuning: UiControlTuning): UiControlTuning {
  return {
    global: { ...tuning.global },
    menuButtons: {
      selectedTarget: tuning.menuButtons.selectedTarget,
      selectedButtonState: tuning.menuButtons.selectedButtonState,
      departmentButtons: {
        active: { ...tuning.menuButtons.departmentButtons.active },
        inactive: { ...tuning.menuButtons.departmentButtons.inactive },
      },
      sectionButtons: {
        active: { ...tuning.menuButtons.sectionButtons.active },
        inactive: { ...tuning.menuButtons.sectionButtons.inactive },
      },
    },
    cards: { ...tuning.cards },
    lists: { ...tuning.lists },
    directories: { ...tuning.directories },
    layout: { ...tuning.layout },
    misc: { ...tuning.misc },
    inputs: { ...tuning.inputs },
  };
}

function clonePresetProfiles(profiles: Record<UiPresetId, UiControlTuning>): Record<UiPresetId, UiControlTuning> {
  return {
    small: cloneUiControlTuning(profiles.small),
    medium: cloneUiControlTuning(profiles.medium),
    large: cloneUiControlTuning(profiles.large),
    xlarge: cloneUiControlTuning(profiles.xlarge),
  };
}

const DEFAULT_UI_PRESET_PROFILES: Record<UiPresetId, UiControlTuning> = {
  small: {
    ...cloneUiControlTuning(DEFAULT_UI_CONTROL_TUNING),
    global: { ...DEFAULT_UI_CONTROL_TUNING.global, titleFontSize: 17, sectionFontSize: 14, bodyFontSize: 12, mutedFontSize: 11, space3: 10, space4: 12, space5: 16 },
    menuButtons: {
      ...DEFAULT_UI_CONTROL_TUNING.menuButtons,
      departmentButtons: {
        active: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.departmentButtons.active, fontSize: 20, width: 190, height: 120, paddingX: 12, paddingY: 4, gap: 6 },
        inactive: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.departmentButtons.inactive, fontSize: 20, width: 190, height: 120, paddingX: 12, paddingY: 4, gap: 6 },
      },
      sectionButtons: {
        active: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.sectionButtons.active, fontSize: 18, width: 170, height: 52, paddingX: 12, paddingY: 6, gap: 5 },
        inactive: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.sectionButtons.inactive, fontSize: 18, width: 170, height: 52, paddingX: 12, paddingY: 6, gap: 5 },
      },
    },
    cards: { ...DEFAULT_UI_CONTROL_TUNING.cards, fontSize: 13, rowPaddingY: 3, rowPaddingX: 5, rowGap: 3, sectionAltStrength: 6 },
    lists: { ...DEFAULT_UI_CONTROL_TUNING.lists, fontSize: 13, rowPaddingY: 3, rowPaddingX: 5, textColumnMaxCh: 44, autoColumnsGapPx: 8 },
    directories: { ...DEFAULT_UI_CONTROL_TUNING.directories, tableFontSize: 12, entityCardMinWidth: 420 },
    layout: { ...DEFAULT_UI_CONTROL_TUNING.layout, contentMaxWidth: 1280, blockMinWidth: 320, blockMaxWidth: 700 },
    misc: { ...DEFAULT_UI_CONTROL_TUNING.misc, datePickerScale: 1.6, datePickerFontSize: 13 },
    inputs: { ...DEFAULT_UI_CONTROL_TUNING.inputs, autoGrowMinChars: 8, autoGrowMaxChars: 34, autoGrowExtraChars: 1 },
  },
  medium: cloneUiControlTuning(DEFAULT_UI_CONTROL_TUNING),
  large: {
    ...cloneUiControlTuning(DEFAULT_UI_CONTROL_TUNING),
    global: { ...DEFAULT_UI_CONTROL_TUNING.global, titleFontSize: 19, sectionFontSize: 16, bodyFontSize: 14, mutedFontSize: 12, space4: 18, space5: 22 },
    menuButtons: {
      ...DEFAULT_UI_CONTROL_TUNING.menuButtons,
      departmentButtons: {
        active: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.departmentButtons.active, fontSize: 28, width: 260, height: 160, paddingX: 18, paddingY: 6, gap: 9 },
        inactive: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.departmentButtons.inactive, fontSize: 28, width: 260, height: 160, paddingX: 18, paddingY: 6, gap: 9 },
      },
      sectionButtons: {
        active: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.sectionButtons.active, fontSize: 25, width: 220, height: 72, paddingX: 18, paddingY: 9, gap: 7 },
        inactive: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.sectionButtons.inactive, fontSize: 25, width: 220, height: 72, paddingX: 18, paddingY: 9, gap: 7 },
      },
    },
    cards: { ...DEFAULT_UI_CONTROL_TUNING.cards, fontSize: 15, rowPaddingY: 5, rowPaddingX: 7, rowGap: 5, sectionAltStrength: 10 },
    lists: { ...DEFAULT_UI_CONTROL_TUNING.lists, fontSize: 15, rowPaddingY: 5, rowPaddingX: 7, textColumnMaxCh: 52, autoColumnsGapPx: 12 },
    directories: { ...DEFAULT_UI_CONTROL_TUNING.directories, tableFontSize: 14, entityCardMinWidth: 560 },
    layout: { ...DEFAULT_UI_CONTROL_TUNING.layout, contentMaxWidth: 1900, blockMinWidth: 460, blockMaxWidth: 980 },
    misc: { ...DEFAULT_UI_CONTROL_TUNING.misc, datePickerScale: 2.1, datePickerFontSize: 15 },
    inputs: { ...DEFAULT_UI_CONTROL_TUNING.inputs, autoGrowMinChars: 11, autoGrowMaxChars: 56, autoGrowExtraChars: 2 },
  },
  xlarge: {
    ...cloneUiControlTuning(DEFAULT_UI_CONTROL_TUNING),
    global: { ...DEFAULT_UI_CONTROL_TUNING.global, titleFontSize: 20, sectionFontSize: 17, bodyFontSize: 14, mutedFontSize: 12, space4: 20, space5: 24 },
    menuButtons: {
      ...DEFAULT_UI_CONTROL_TUNING.menuButtons,
      departmentButtons: {
        active: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.departmentButtons.active, fontSize: 30, width: 280, height: 172, paddingX: 20, paddingY: 7, gap: 10 },
        inactive: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.departmentButtons.inactive, fontSize: 30, width: 280, height: 172, paddingX: 20, paddingY: 7, gap: 10 },
      },
      sectionButtons: {
        active: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.sectionButtons.active, fontSize: 26, width: 235, height: 76, paddingX: 20, paddingY: 10, gap: 8 },
        inactive: { ...DEFAULT_UI_CONTROL_TUNING.menuButtons.sectionButtons.inactive, fontSize: 26, width: 235, height: 76, paddingX: 20, paddingY: 10, gap: 8 },
      },
    },
    cards: { ...DEFAULT_UI_CONTROL_TUNING.cards, fontSize: 15, rowPaddingY: 6, rowPaddingX: 8, rowGap: 6, sectionAltStrength: 10 },
    lists: { ...DEFAULT_UI_CONTROL_TUNING.lists, fontSize: 15, rowPaddingY: 6, rowPaddingX: 8, textColumnMaxCh: 56, autoColumnsGapPx: 12 },
    directories: { ...DEFAULT_UI_CONTROL_TUNING.directories, tableFontSize: 14, entityCardMinWidth: 620 },
    layout: { ...DEFAULT_UI_CONTROL_TUNING.layout, contentMaxWidth: 2300, blockMinWidth: 500, blockMaxWidth: 1100 },
    misc: { ...DEFAULT_UI_CONTROL_TUNING.misc, datePickerScale: 2.2, datePickerFontSize: 16 },
    inputs: { ...DEFAULT_UI_CONTROL_TUNING.inputs, autoGrowMinChars: 12, autoGrowMaxChars: 64, autoGrowExtraChars: 3 },
  },
};

export const DEFAULT_UI_CONTROL_SETTINGS: UiControlSettings = {
  ...cloneUiControlTuning(DEFAULT_UI_PRESET_PROFILES[DEFAULT_UI_PRESET_ID]),
  presets: {
    defaultPresetId: DEFAULT_UI_PRESET_ID,
    editorPresetId: DEFAULT_UI_PRESET_ID,
    profiles: clonePresetProfiles(DEFAULT_UI_PRESET_PROFILES),
  },
};

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampBoolean(raw: unknown, fallback: boolean): boolean {
  if (raw === true) return true;
  if (raw === false) return false;
  return fallback;
}

function safeButtonStyle(raw: unknown, fallback: UiDisplayButtonStyle): UiDisplayButtonStyle {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const value = raw as Record<string, unknown>;
  return {
    fontSize: clampNumber(value.fontSize, fallback.fontSize, 10, 48),
    width: clampNumber(value.width, fallback.width, 60, 480),
    height: clampNumber(value.height, fallback.height, 24, 280),
    paddingX: clampNumber(value.paddingX, fallback.paddingX, 0, 60),
    paddingY: clampNumber(value.paddingY, fallback.paddingY, 0, 40),
    gap: clampNumber(value.gap, fallback.gap, 0, 60),
  };
}

function safeButtonConfig(raw: unknown, fallback: UiDisplayButtonConfig): UiDisplayButtonConfig {
  if (!raw || typeof raw !== 'object') return { active: { ...fallback.active }, inactive: { ...fallback.inactive } };
  const value = raw as Record<string, unknown>;
  return {
    active: safeButtonStyle(value.active, fallback.active),
    inactive: safeButtonStyle(value.inactive, fallback.inactive),
  };
}

export function sanitizeUiDisplayPrefs(raw: unknown): UiDisplayPrefs {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const selectedTargetRaw = String(value.selectedTarget ?? DEFAULT_UI_DISPLAY_PREFS.selectedTarget);
  const selectedTarget: UiDisplayTarget = ['departmentButtons', 'sectionButtons', 'listFont', 'cardFont'].includes(selectedTargetRaw)
    ? (selectedTargetRaw as UiDisplayTarget)
    : DEFAULT_UI_DISPLAY_PREFS.selectedTarget;
  const selectedButtonStateRaw = String(value.selectedButtonState ?? DEFAULT_UI_DISPLAY_PREFS.selectedButtonState);
  const selectedButtonState: UiDisplayButtonState = selectedButtonStateRaw === 'inactive' ? 'inactive' : 'active';
  return {
    selectedTarget,
    selectedButtonState,
    departmentButtons: safeButtonConfig(value.departmentButtons, DEFAULT_UI_DISPLAY_PREFS.departmentButtons),
    sectionButtons: safeButtonConfig(value.sectionButtons, DEFAULT_UI_DISPLAY_PREFS.sectionButtons),
    listFontSize: clampNumber(value.listFontSize, DEFAULT_UI_DISPLAY_PREFS.listFontSize, 10, 48),
    cardFontSize: clampNumber(value.cardFontSize, DEFAULT_UI_DISPLAY_PREFS.cardFontSize, 10, 48),
  };
}

function isUiPresetId(raw: unknown): raw is UiPresetId {
  return typeof raw === 'string' && (UI_PRESET_IDS as readonly string[]).includes(raw);
}

export function sanitizeUiPresetId(raw: unknown, fallback: UiPresetId = DEFAULT_UI_PRESET_ID): UiPresetId {
  return isUiPresetId(raw) ? raw : fallback;
}

function sanitizeUiControlTuning(raw: unknown, fallback: UiControlTuning): UiControlTuning {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const menuButtonsRaw = value.menuButtons && typeof value.menuButtons === 'object' ? (value.menuButtons as Record<string, unknown>) : {};
  const globalRaw = value.global && typeof value.global === 'object' ? (value.global as Record<string, unknown>) : {};
  const cardsRaw = value.cards && typeof value.cards === 'object' ? (value.cards as Record<string, unknown>) : {};
  const listsRaw = value.lists && typeof value.lists === 'object' ? (value.lists as Record<string, unknown>) : {};
  const directoriesRaw = value.directories && typeof value.directories === 'object' ? (value.directories as Record<string, unknown>) : {};
  const layoutRaw = value.layout && typeof value.layout === 'object' ? (value.layout as Record<string, unknown>) : {};
  const miscRaw = value.misc && typeof value.misc === 'object' ? (value.misc as Record<string, unknown>) : {};
  const inputsRaw = value.inputs && typeof value.inputs === 'object' ? (value.inputs as Record<string, unknown>) : {};

  const menuDisplay = sanitizeUiDisplayPrefs({
    selectedTarget: menuButtonsRaw.selectedTarget,
    selectedButtonState: menuButtonsRaw.selectedButtonState,
    departmentButtons: menuButtonsRaw.departmentButtons,
    sectionButtons: menuButtonsRaw.sectionButtons,
    listFontSize: fallback.lists.fontSize,
    cardFontSize: fallback.cards.fontSize,
  });

  const autoGrowMinChars = clampNumber(inputsRaw.autoGrowMinChars, fallback.inputs.autoGrowMinChars, 3, 40);
  const autoGrowMaxCharsRaw = clampNumber(inputsRaw.autoGrowMaxChars, fallback.inputs.autoGrowMaxChars, 6, 80);
  const autoGrowMaxChars = Math.max(autoGrowMinChars, autoGrowMaxCharsRaw);
  const blockMinWidth = clampNumber(layoutRaw.blockMinWidth, fallback.layout.blockMinWidth, 220, 1000);
  const blockMaxWidthRaw = clampNumber(layoutRaw.blockMaxWidth, fallback.layout.blockMaxWidth, 260, 1400);
  const blockMaxWidth = Math.max(blockMinWidth, blockMaxWidthRaw);

  return {
    global: {
      titleFontSize: clampNumber(globalRaw.titleFontSize, fallback.global.titleFontSize, 12, 34),
      sectionFontSize: clampNumber(globalRaw.sectionFontSize, fallback.global.sectionFontSize, 11, 30),
      bodyFontSize: clampNumber(globalRaw.bodyFontSize, fallback.global.bodyFontSize, 10, 28),
      mutedFontSize: clampNumber(globalRaw.mutedFontSize, fallback.global.mutedFontSize, 10, 24),
      space1: clampNumber(globalRaw.space1, fallback.global.space1, 0, 40),
      space2: clampNumber(globalRaw.space2, fallback.global.space2, 0, 40),
      space3: clampNumber(globalRaw.space3, fallback.global.space3, 0, 40),
      space4: clampNumber(globalRaw.space4, fallback.global.space4, 0, 60),
      space5: clampNumber(globalRaw.space5, fallback.global.space5, 0, 80),
    },
    menuButtons: {
      selectedTarget: menuDisplay.selectedTarget,
      selectedButtonState: menuDisplay.selectedButtonState,
      departmentButtons: menuDisplay.departmentButtons,
      sectionButtons: menuDisplay.sectionButtons,
    },
    cards: {
      fontSize: clampNumber(cardsRaw.fontSize, fallback.cards.fontSize, 10, 48),
      rowGap: clampNumber(cardsRaw.rowGap, fallback.cards.rowGap, 0, 30),
      rowPaddingY: clampNumber(cardsRaw.rowPaddingY, fallback.cards.rowPaddingY, 0, 30),
      rowPaddingX: clampNumber(cardsRaw.rowPaddingX, fallback.cards.rowPaddingX, 0, 30),
      sectionAltBackgrounds: clampBoolean(cardsRaw.sectionAltBackgrounds, fallback.cards.sectionAltBackgrounds),
      sectionAltStrength: clampNumber(cardsRaw.sectionAltStrength, fallback.cards.sectionAltStrength, 0, 30),
    },
    lists: {
      fontSize: clampNumber(listsRaw.fontSize, fallback.lists.fontSize, 10, 48),
      rowPaddingY: clampNumber(listsRaw.rowPaddingY, fallback.lists.rowPaddingY, 0, 24),
      rowPaddingX: clampNumber(listsRaw.rowPaddingX, fallback.lists.rowPaddingX, 0, 24),
      textColumnMaxCh: Math.round(clampNumber(listsRaw.textColumnMaxCh, fallback.lists.textColumnMaxCh, 24, 88)),
      autoColumnsEnabled: clampBoolean(listsRaw.autoColumnsEnabled, fallback.lists.autoColumnsEnabled),
      autoColumnsMax: Math.round(clampNumber(listsRaw.autoColumnsMax, fallback.lists.autoColumnsMax, 1, 3)),
      autoColumnsGapPx: Math.round(clampNumber(listsRaw.autoColumnsGapPx, fallback.lists.autoColumnsGapPx, 0, 32)),
    },
    directories: {
      tableFontSize: clampNumber(directoriesRaw.tableFontSize, fallback.directories.tableFontSize, 10, 36),
      entityCardMinWidth: clampNumber(directoriesRaw.entityCardMinWidth, fallback.directories.entityCardMinWidth, 260, 1200),
    },
    layout: {
      contentMaxWidth: clampNumber(layoutRaw.contentMaxWidth, fallback.layout.contentMaxWidth, 960, 2600),
      blockMinWidth,
      blockMaxWidth,
    },
    misc: {
      datePickerScale: clampNumber(miscRaw.datePickerScale, fallback.misc.datePickerScale, 1, 3),
      datePickerFontSize: clampNumber(miscRaw.datePickerFontSize, fallback.misc.datePickerFontSize, 10, 28),
    },
    inputs: {
      autoGrowAllFields: clampBoolean(inputsRaw.autoGrowAllFields, fallback.inputs.autoGrowAllFields),
      autoGrowMinChars,
      autoGrowMaxChars,
      autoGrowExtraChars: clampNumber(inputsRaw.autoGrowExtraChars, fallback.inputs.autoGrowExtraChars, 0, 12),
    },
  };
}

export function extractUiControlTuning(settings: UiControlSettings): UiControlTuning {
  return cloneUiControlTuning(settings);
}

export function withUiControlTuning(settings: UiControlSettings, tuning: UiControlTuning): UiControlSettings {
  return {
    ...settings,
    ...cloneUiControlTuning(tuning),
    presets: {
      ...settings.presets,
      profiles: clonePresetProfiles(settings.presets.profiles),
    },
  };
}

export function resolveUiControlPreset(settings: UiControlSettings, presetId?: unknown): UiControlTuning {
  const safe = sanitizeUiControlSettings(settings);
  const id = sanitizeUiPresetId(presetId, safe.presets.defaultPresetId);
  return cloneUiControlTuning(safe.presets.profiles[id] ?? safe.presets.profiles[safe.presets.defaultPresetId]);
}

export function withUiControlPresetApplied(settings: UiControlSettings, presetId?: unknown): UiControlSettings {
  const safe = sanitizeUiControlSettings(settings);
  const tuning = resolveUiControlPreset(safe, presetId);
  return withUiControlTuning(safe, tuning);
}

export function sanitizeUiControlSettings(raw: unknown): UiControlSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = DEFAULT_UI_CONTROL_SETTINGS;
  const topLevelTuning = sanitizeUiControlTuning(value, extractUiControlTuning(base));
  const presetsRaw = value.presets && typeof value.presets === 'object' ? (value.presets as Record<string, unknown>) : {};
  const profilesRaw = presetsRaw.profiles && typeof presetsRaw.profiles === 'object' ? (presetsRaw.profiles as Record<string, unknown>) : {};
  const hasProfileInput = UI_PRESET_IDS.some((id) => profilesRaw[id] != null);
  const profiles: Record<UiPresetId, UiControlTuning> = {
    small: sanitizeUiControlTuning(profilesRaw.small, base.presets.profiles.small),
    medium: sanitizeUiControlTuning(profilesRaw.medium, base.presets.profiles.medium),
    large: sanitizeUiControlTuning(profilesRaw.large, base.presets.profiles.large),
    xlarge: sanitizeUiControlTuning(profilesRaw.xlarge, base.presets.profiles.xlarge),
  };
  if (!hasProfileInput) {
    profiles[DEFAULT_UI_PRESET_ID] = cloneUiControlTuning(topLevelTuning);
  }
  const defaultPresetId = sanitizeUiPresetId(presetsRaw.defaultPresetId, base.presets.defaultPresetId);
  const editorPresetId = sanitizeUiPresetId(presetsRaw.editorPresetId, defaultPresetId);
  const editorTuning = profiles[editorPresetId] ?? profiles[defaultPresetId] ?? topLevelTuning;
  return {
    ...cloneUiControlTuning(editorTuning),
    presets: {
      defaultPresetId,
      editorPresetId,
      profiles: clonePresetProfiles(profiles),
    },
  };
}

export function mergeUiControlSettings(base: UiControlSettings, overlay?: unknown): UiControlSettings {
  if (!overlay || typeof overlay !== 'object') return sanitizeUiControlSettings(base);
  const b = sanitizeUiControlSettings(base);
  const o = sanitizeUiControlSettings(overlay);
  const mergedProfiles: Record<UiPresetId, UiControlTuning> = {
    small: mergeUiControlTuning(b.presets.profiles.small, o.presets.profiles.small),
    medium: mergeUiControlTuning(b.presets.profiles.medium, o.presets.profiles.medium),
    large: mergeUiControlTuning(b.presets.profiles.large, o.presets.profiles.large),
    xlarge: mergeUiControlTuning(b.presets.profiles.xlarge, o.presets.profiles.xlarge),
  };
  const mergedTopLevel = mergeUiControlTuning(extractUiControlTuning(b), extractUiControlTuning(o));
  return {
    ...mergedTopLevel,
    presets: {
      defaultPresetId: sanitizeUiPresetId(o.presets.defaultPresetId, b.presets.defaultPresetId),
      editorPresetId: sanitizeUiPresetId(o.presets.editorPresetId, b.presets.editorPresetId),
      profiles: mergedProfiles,
    },
  };
}

export function uiControlToDisplayPrefs(settings: UiControlSettings): UiDisplayPrefs {
  return sanitizeUiDisplayPrefs({
    selectedTarget: settings.menuButtons.selectedTarget,
    selectedButtonState: settings.menuButtons.selectedButtonState,
    departmentButtons: settings.menuButtons.departmentButtons,
    sectionButtons: settings.menuButtons.sectionButtons,
    listFontSize: settings.lists.fontSize,
    cardFontSize: settings.cards.fontSize,
  });
}

function mergeUiControlTuning(base: UiControlTuning, overlay: UiControlTuning): UiControlTuning {
  return {
    global: { ...base.global, ...overlay.global },
    menuButtons: {
      ...base.menuButtons,
      ...overlay.menuButtons,
      departmentButtons: {
        active: { ...base.menuButtons.departmentButtons.active, ...overlay.menuButtons.departmentButtons.active },
        inactive: { ...base.menuButtons.departmentButtons.inactive, ...overlay.menuButtons.departmentButtons.inactive },
      },
      sectionButtons: {
        active: { ...base.menuButtons.sectionButtons.active, ...overlay.menuButtons.sectionButtons.active },
        inactive: { ...base.menuButtons.sectionButtons.inactive, ...overlay.menuButtons.sectionButtons.inactive },
      },
    },
    cards: { ...base.cards, ...overlay.cards },
    lists: { ...base.lists, ...overlay.lists },
    directories: { ...base.directories, ...overlay.directories },
    layout: { ...base.layout, ...overlay.layout },
    misc: { ...base.misc, ...overlay.misc },
    inputs: { ...base.inputs, ...overlay.inputs },
  };
}
