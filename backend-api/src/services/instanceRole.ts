const NON_PRIMARY_ROLES = new Set(['secondary', 'readonly', 'worker']);

export function getInstanceRole(): string {
  return String(process.env.MATRICA_INSTANCE_ROLE ?? '').trim().toLowerCase();
}

export function isPrimaryInstance(role = getInstanceRole()): boolean {
  return !NON_PRIMARY_ROLES.has(role);
}

export function shouldRunBackgroundJobs(role = getInstanceRole()): boolean {
  return isPrimaryInstance(role);
}

