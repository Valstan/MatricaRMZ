export type AdminUserSummary = {
  id: string;
  username: string;
  login?: string;
  fullName?: string;
  role: string;
  isActive: boolean;
  deleteRequestedAt?: number | null;
  deleteRequestedById?: string | null;
  deleteRequestedByUsername?: string | null;
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

type ErrorResult = { ok: false; error: string };

export type AdminUsersListResponse = { ok: true; users: AdminUserSummary[] } | ErrorResult;

export type AdminUserPermissionsResponse =
  | ({ ok: true } & AdminUserPermissionsPayload)
  | ErrorResult;

export type AdminDelegationsListResponse = { ok: true; delegations: PermissionDelegation[] } | ErrorResult;
