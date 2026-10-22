import { principalFromClaims } from './principal';

const exp = Math.floor(Date.now() / 1000) + 60;

describe('principalFromClaims', () => {
  it('maps verified claims to a principal', () => {
    const p = principalFromClaims({
      sub: 'u1',
      tid: 't-1',
      scope: 'capacity:read  capacity:write',
      exp,
    });
    expect(p).toEqual({
      subject: 'u1',
      tenantId: 't-1',
      scopes: new Set(['capacity:read', 'capacity:write']),
    });
  });

  it('treats a missing scope claim as no scopes', () => {
    expect(principalFromClaims({ sub: 'u1', tid: 't-1', exp })?.scopes.size).toBe(0);
  });

  it.each([
    ['missing tenant', { sub: 'u1', exp }],
    ['tenant with unsafe chars', { sub: 'u1', tid: "t'1; drop", exp }],
    ['missing subject', { tid: 't-1', exp }],
    ['missing exp (non-expiring token)', { sub: 'u1', tid: 't-1' }],
    ['not an object', 'token'],
  ])('rejects %s', (_label, claims) => {
    expect(principalFromClaims(claims)).toBeNull();
  });
});
