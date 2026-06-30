import { describe, expect, it } from 'vitest';

import { actorIsAuthor, canEditTimesheet } from '../services/timesheetService.js';

describe('timesheet edit permission gate', () => {
  it('author can always edit', () => {
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: false }, 'ivan')).toBe(true);
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: true }, 'ivan')).toBe(true);
  });

  it('non-author is blocked when allow-others is off (default)', () => {
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: false }, 'petr')).toBe(false);
  });

  it('non-author may edit only when the author enabled allow-others', () => {
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: true }, 'petr')).toBe(true);
  });

  it('legacy timesheet without an author stays open to anyone', () => {
    expect(canEditTimesheet({ createdBy: null, allowOthersEdit: false }, 'petr')).toBe(true);
    expect(canEditTimesheet({ createdBy: null, allowOthersEdit: false }, null)).toBe(true);
  });

  it('author match is case/space-insensitive on login', () => {
    expect(actorIsAuthor('Ivan', ' ivan ')).toBe(true);
    expect(actorIsAuthor('ivan', 'petr')).toBe(false);
    expect(actorIsAuthor(null, 'ivan')).toBe(false);
  });

  it('missing actor is never the author and cannot edit a guarded timesheet', () => {
    expect(actorIsAuthor('ivan', undefined)).toBe(false);
    expect(canEditTimesheet({ createdBy: 'ivan', allowOthersEdit: false }, undefined)).toBe(false);
  });
});
