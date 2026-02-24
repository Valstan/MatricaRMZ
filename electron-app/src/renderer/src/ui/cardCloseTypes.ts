export type CardCloseActions = {
  isDirty: () => boolean;
  saveAndClose: () => Promise<void>;
  closeWithoutSave: () => void;
  copyToNew: () => Promise<void>;
};
