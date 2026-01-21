export type AdminUserSummary = {
  id: string;
  username: string;
  login?: string;
  fullName?: string;
  role: string;
  isActive: boolean;
};

export type AdminUserPermissionsPayload = {
  user: { id: string; username: string; login?: string; role: string; isActive?: boolean };
  allCodes: string[];
  base: Record<string, boolean>;
  overrides: Record<string, boolean>;
  effective: Record<string, boolean>;
};

export type PermissionDelegation = {
  id: string;
  fromUserId: string;
  toUserId: string;
  permCode: string;
  startsAt: number;
  endsAt: number;
  note: string | null;
  createdAt: number;
  createdByUserId: string;
  revokedAt: number | null;
  revokedByUserId: string | null;
  revokeNote: string | null;
};

export type AdminUsersListResponse = { ok: true; users: AdminUserSummary[] } | { ok: false; error: string };

export type AdminUserPermissionsResponse =
  | ({ ok: true } & AdminUserPermissionsPayload)
  | { ok: false; error: string };

export type AdminDelegationsListResponse = { ok: true; delegations: PermissionDelegation[] } | { ok: false; error: string };
