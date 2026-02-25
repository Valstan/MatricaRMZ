export type CardCloseActions = {
  isDirty: () => boolean;
  saveAndClose: () => Promise<void>;
  reset: () => Promise<void>;
  closeWithoutSave: () => void;
  copyToNew: () => Promise<void>;
};
