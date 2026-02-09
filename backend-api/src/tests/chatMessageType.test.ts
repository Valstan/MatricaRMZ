import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import { chatMessageRowSchema } from '@matricarmz/shared';

describe('chatMessageRowSchema', () => {
  it('accepts text_notify message type', () => {
    const now = Date.now();
    const row = {
      id: randomUUID(),
      sender_user_id: randomUUID(),
      sender_username: 'tester',
      recipient_user_id: null,
      message_type: 'text_notify',
      body_text: 'hello',
      payload_json: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      sync_status: 'synced',
    };
    const res = chatMessageRowSchema.safeParse(row);
    expect(res.success).toBe(true);
  });
});
