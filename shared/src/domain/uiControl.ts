export type UiDisplayTarget = 'departmentButtons' | 'sectionButtons' | 'listFont' | 'cardFont';
export type UiDisplayButtonState = 'active' | 'inactive';

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

export type UiControlSettings = {
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
  };
  directories: {
    tableFontSize: number;
    entityCardMinWidth: number;
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

export const DEFAULT_UI_CONTROL_SETTINGS: UiControlSettings = {
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
  },
  directories: {
    tableFontSize: 13,
    entityCardMinWidth: 520,
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

export function sanitizeUiControlSettings(raw: unknown): UiControlSettings {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = DEFAULT_UI_CONTROL_SETTINGS;
  const menuButtonsRaw = value.menuButtons && typeof value.menuButtons === 'object' ? (value.menuButtons as Record<string, unknown>) : {};
  const globalRaw = value.global && typeof value.global === 'object' ? (value.global as Record<string, unknown>) : {};
  const cardsRaw = value.cards && typeof value.cards === 'object' ? (value.cards as Record<string, unknown>) : {};
  const listsRaw = value.lists && typeof value.lists === 'object' ? (value.lists as Record<string, unknown>) : {};
  const directoriesRaw = value.directories && typeof value.directories === 'object' ? (value.directories as Record<string, unknown>) : {};
  const miscRaw = value.misc && typeof value.misc === 'object' ? (value.misc as Record<string, unknown>) : {};
  const inputsRaw = value.inputs && typeof value.inputs === 'object' ? (value.inputs as Record<string, unknown>) : {};

  const menuDisplay = sanitizeUiDisplayPrefs({
    selectedTarget: menuButtonsRaw.selectedTarget,
    selectedButtonState: menuButtonsRaw.selectedButtonState,
    departmentButtons: menuButtonsRaw.departmentButtons,
    sectionButtons: menuButtonsRaw.sectionButtons,
    listFontSize: base.lists.fontSize,
    cardFontSize: base.cards.fontSize,
  });

  const autoGrowMinChars = clampNumber(inputsRaw.autoGrowMinChars, base.inputs.autoGrowMinChars, 3, 40);
  const autoGrowMaxCharsRaw = clampNumber(inputsRaw.autoGrowMaxChars, base.inputs.autoGrowMaxChars, 6, 80);
  const autoGrowMaxChars = Math.max(autoGrowMinChars, autoGrowMaxCharsRaw);

  return {
    global: {
      titleFontSize: clampNumber(globalRaw.titleFontSize, base.global.titleFontSize, 12, 34),
      sectionFontSize: clampNumber(globalRaw.sectionFontSize, base.global.sectionFontSize, 11, 30),
      bodyFontSize: clampNumber(globalRaw.bodyFontSize, base.global.bodyFontSize, 10, 28),
      mutedFontSize: clampNumber(globalRaw.mutedFontSize, base.global.mutedFontSize, 10, 24),
      space1: clampNumber(globalRaw.space1, base.global.space1, 0, 40),
      space2: clampNumber(globalRaw.space2, base.global.space2, 0, 40),
      space3: clampNumber(globalRaw.space3, base.global.space3, 0, 40),
      space4: clampNumber(globalRaw.space4, base.global.space4, 0, 60),
      space5: clampNumber(globalRaw.space5, base.global.space5, 0, 80),
    },
    menuButtons: {
      selectedTarget: menuDisplay.selectedTarget,
      selectedButtonState: menuDisplay.selectedButtonState,
      departmentButtons: menuDisplay.departmentButtons,
      sectionButtons: menuDisplay.sectionButtons,
    },
    cards: {
      fontSize: clampNumber(cardsRaw.fontSize, base.cards.fontSize, 10, 48),
      rowGap: clampNumber(cardsRaw.rowGap, base.cards.rowGap, 0, 30),
      rowPaddingY: clampNumber(cardsRaw.rowPaddingY, base.cards.rowPaddingY, 0, 30),
      rowPaddingX: clampNumber(cardsRaw.rowPaddingX, base.cards.rowPaddingX, 0, 30),
      sectionAltBackgrounds: clampBoolean(cardsRaw.sectionAltBackgrounds, base.cards.sectionAltBackgrounds),
      sectionAltStrength: clampNumber(cardsRaw.sectionAltStrength, base.cards.sectionAltStrength, 0, 30),
    },
    lists: {
      fontSize: clampNumber(listsRaw.fontSize, base.lists.fontSize, 10, 48),
      rowPaddingY: clampNumber(listsRaw.rowPaddingY, base.lists.rowPaddingY, 0, 24),
      rowPaddingX: clampNumber(listsRaw.rowPaddingX, base.lists.rowPaddingX, 0, 24),
    },
    directories: {
      tableFontSize: clampNumber(directoriesRaw.tableFontSize, base.directories.tableFontSize, 10, 36),
      entityCardMinWidth: clampNumber(directoriesRaw.entityCardMinWidth, base.directories.entityCardMinWidth, 260, 1200),
    },
    misc: {
      datePickerScale: clampNumber(miscRaw.datePickerScale, base.misc.datePickerScale, 1, 3),
      datePickerFontSize: clampNumber(miscRaw.datePickerFontSize, base.misc.datePickerFontSize, 10, 28),
    },
    inputs: {
      autoGrowAllFields: clampBoolean(inputsRaw.autoGrowAllFields, base.inputs.autoGrowAllFields),
      autoGrowMinChars,
      autoGrowMaxChars,
      autoGrowExtraChars: clampNumber(inputsRaw.autoGrowExtraChars, base.inputs.autoGrowExtraChars, 0, 12),
    },
  };
}

export function mergeUiControlSettings(base: UiControlSettings, overlay?: unknown): UiControlSettings {
  if (!overlay || typeof overlay !== 'object') return sanitizeUiControlSettings(base);
  const b = sanitizeUiControlSettings(base);
  const o = sanitizeUiControlSettings(overlay);
  return {
    global: { ...b.global, ...o.global },
    menuButtons: {
      ...b.menuButtons,
      ...o.menuButtons,
      departmentButtons: {
        active: { ...b.menuButtons.departmentButtons.active, ...o.menuButtons.departmentButtons.active },
        inactive: { ...b.menuButtons.departmentButtons.inactive, ...o.menuButtons.departmentButtons.inactive },
      },
      sectionButtons: {
        active: { ...b.menuButtons.sectionButtons.active, ...o.menuButtons.sectionButtons.active },
        inactive: { ...b.menuButtons.sectionButtons.inactive, ...o.menuButtons.sectionButtons.inactive },
      },
    },
    cards: { ...b.cards, ...o.cards },
    lists: { ...b.lists, ...o.lists },
    directories: { ...b.directories, ...o.directories },
    misc: { ...b.misc, ...o.misc },
    inputs: { ...b.inputs, ...o.inputs },
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
