import { describe, expect, it } from 'vitest';
import { isPersonalName, maskEntry, maskPersonal, maskUrl, maskValue } from '../src/logs/mask.js';

/** What get_logs hides of a stored entry: user ids and client addresses, all but 4 characters. */

describe('maskValue', () => {
  it.each([
    ['203.0.113.45', '*****3.45'],
    ['made-up-admin', '*****dmin'],
    ['2001:db8::1', '*****8::1'],
    ['12345', '*****2345'],
    ['1234', '*****'],
    ['abc', '*****'],
    ['', '*****'],
  ])('masks %j as %j', (value, masked) => {
    expect(maskValue(value)).toBe(masked);
  });

  it('counts characters, not UTF-16 units', () => {
    expect(maskValue('made-up-😀😀😀😀')).toBe('*****😀😀😀😀');
    expect(maskValue('😀😀😀😀')).toBe('*****');
  });
});

describe('isPersonalName', () => {
  it.each(['userId', 'targetUserId', 'remoteAddress', 'user_id', 'ip', 'clientAddress', 'sub'])(
    'counts %s as personal',
    (name) => {
      expect(isPersonalName(name)).toBe(true);
    },
  );

  // `url` is not masked as a whole: only a user id in its path is (see maskUrl).
  it.each(['clientId', 'connectionId', 'modelId', 'reqId', 'remotePort', 'url', 'zip', 'subject'])(
    'does not mask %s as a whole',
    (name) => {
      expect(isPersonalName(name)).toBe(false);
    },
  );
});

describe('maskUrl', () => {
  it.each([
    ['/api/admin/agents/users/made-up-user-0002', '/api/admin/agents/users/*****0002'],
    ['/api/admin/agents/users/made-up-user-0002?x=1', '/api/admin/agents/users/*****0002?x=1'],
    ['/api/admin/agents/users/abc', '/api/admin/agents/users/*****'],
    ['/api/admin/agents/made-up-connection', '/api/admin/agents/made-up-connection'],
    ['/api/admin/agents', '/api/admin/agents'],
    ['/api/models/made-up-model-0001', '/api/models/made-up-model-0001'],
    ['/other/api/admin/agents/users/made-up-user', '/other/api/admin/agents/users/made-up-user'],
  ])('gives %j as %j', (url, masked) => {
    expect(maskUrl(url)).toBe(masked);
  });
});

describe('maskPersonal', () => {
  it('masks user ids and client addresses at any depth, and nothing else', () => {
    const extra = {
      reqId: 'req-1',
      userId: 'made-up-user-0001',
      targetUserId: 'made-up-user-0002',
      clientId: 'made-up-client',
      req: { method: 'GET', url: '/api/models', remoteAddress: '198.51.100.23', remotePort: 51234 },
      disconnect: { req: { method: 'DELETE', url: '/api/admin/agents/users/made-up-user-0004' } },
      nested: [{ deeper: { userId: 'made-up-user-0003' } }],
      roles: ['Admin'],
    };
    expect(maskPersonal(extra)).toEqual({
      reqId: 'req-1',
      userId: '*****0001',
      targetUserId: '*****0002',
      clientId: 'made-up-client',
      req: { method: 'GET', url: '/api/models', remoteAddress: '*****0.23', remotePort: 51234 },
      disconnect: { req: { method: 'DELETE', url: '/api/admin/agents/users/*****0004' } },
      nested: [{ deeper: { userId: '*****0003' } }],
      roles: ['Admin'],
    });
    // A copy: what it was given is unchanged.
    expect(extra.userId).toBe('made-up-user-0001');
  });

  it('masks short values to the prefix alone, numbers as text, and whatever a personal field holds', () => {
    expect(
      maskPersonal({
        userId: 'u1',
        ip: 1234567,
        sub: ['made-up-a', 'made-up-bb'],
        clientAddress: { v4: '192.0.2.10' },
        remoteAddress: null,
      }),
    ).toEqual({
      userId: '*****',
      ip: '*****4567',
      sub: ['*****up-a', '*****p-bb'],
      clientAddress: { v4: '*****2.10' },
      remoteAddress: null,
    });
  });

  it('leaves values that are not objects as they are', () => {
    expect(maskPersonal('made-up text')).toBe('made-up text');
    expect(maskPersonal(7)).toBe(7);
    expect(maskPersonal(null)).toBeNull();
  });
});

describe('maskEntry', () => {
  it('masks the other fields and keeps the time, level and message', () => {
    const entry = {
      id: '1',
      time: '2026-03-10T12:00:00.000Z',
      level: 'info' as const,
      msg: 'signed in',
      extra: { userId: 'made-up-user-0001', roles: ['Admin'] },
    };
    expect(maskEntry(entry)).toEqual({
      ...entry,
      extra: { userId: '*****0001', roles: ['Admin'] },
    });
  });
});
