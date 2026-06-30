// Lifted to shared/src/domain/tieredSearch.ts (#035 Ф0) — single matcher for
// Electron, web-admin and server-side dedup. This shim keeps existing imports
// working; new code should import from '@matricarmz/shared' directly.
export {
  buildLookupHighlightParts,
  keyboardLayoutVariants,
  normalizeLookupCompact,
  normalizeLookupText,
  rankLookupOptions,
  searchLookupOptionsTiered,
  tokenizeLookup,
  type LookupOptionLike,
  type SearchHighlightPart,
  type TieredSearchResult,
} from '@matricarmz/shared';
