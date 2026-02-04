export type EmployeeAccessInfo = {
  id: string;
  accessEnabled: boolean;
  systemRole: string;
  deleteRequestedAt?: number | null;
  deleteRequestedById?: string | null;
  deleteRequestedByUsername?: string | null;
};
