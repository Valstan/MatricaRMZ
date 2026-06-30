export type CardCloseActions = {
  isDirty: () => boolean;
  saveAndClose: () => Promise<void>;
  reset: () => Promise<void>;
  closeWithoutSave: () => void;
  copyToNew: () => Promise<void>;
  /**
   * Phase 3b: persist a recovery draft and close without committing to the document
   * store. Present only on draft-capable cards (work order first); when absent the
   * close-guard keeps the two-way save/discard prompt.
   */
  keepDraft?: () => Promise<void>;
};
