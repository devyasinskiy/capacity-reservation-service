import { InvalidTreasuryMessageError, parseTreasuryMessage } from './treasury-message.schema';

const envelope = {
  messageId: 'msg-1',
  schemaVersion: 1,
  tenantId: 't-1',
  programId: 'PRG-1',
  version: 7,
  occurredAt: '2026-10-11T12:00:00Z',
};
const parse = (o: unknown) => parseTreasuryMessage(JSON.stringify(o));
const issuesOf = (o: unknown) => {
  try {
    parse(o);
    return [];
  } catch (e) {
    return (e as InvalidTreasuryMessageError).issues;
  }
};

describe('treasury message schema', () => {
  it('parses a limit set with bigint version and Date timestamp', () => {
    const m = parse({
      ...envelope,
      type: 'PROGRAM_LIMIT_SET',
      payload: { currency: 'USD', limitMinor: '1000000000' },
    });
    expect(m).toMatchObject({
      type: 'PROGRAM_LIMIT_SET',
      version: 7n,
      payload: { limitMinor: '1000000000' },
    });
    expect(m.occurredAt).toEqual(new Date('2026-10-11T12:00:00Z'));
  });

  it('accepts versions as strings beyond 2^53', () => {
    const m = parse({
      ...envelope,
      version: '9007199254740993',
      type: 'PROGRAM_LIMIT_SET',
      payload: { currency: 'USD', limitMinor: '1' },
    });
    expect(m.version).toBe(9007199254740993n);
  });

  it('parses external reservation create/release and a snapshot part', () => {
    expect(
      parse({
        ...envelope,
        type: 'EXTERNAL_RESERVATION_CREATED',
        payload: { externalRef: 'T-1', invoiceId: 'INV-1', currency: 'USD', amountMinor: '500' },
      }).type,
    ).toBe('EXTERNAL_RESERVATION_CREATED');
    expect(
      parse({
        ...envelope,
        type: 'EXTERNAL_RESERVATION_RELEASED',
        payload: { externalRef: 'T-1', currency: 'USD', amountMinor: '5' },
      }).type,
    ).toBe('EXTERNAL_RESERVATION_RELEASED');
    expect(
      parse({
        ...envelope,
        type: 'PROGRAM_RECONCILIATION_SNAPSHOT',
        payload: {
          snapshotId: 'S-1',
          part: 1,
          totalParts: 1,
          asOf: '2026-10-11T11:59:00Z',
          currency: 'USD',
          limitMinor: '100',
          reservations: [
            { origin: 'LOCAL', ref: 'r-1', invoiceId: 'INV-1', outstandingMinor: '0' },
          ],
        },
      }).type,
    ).toBe('PROGRAM_RECONCILIATION_SNAPSHOT');
  });

  it.each([
    [
      'float amount',
      { type: 'PROGRAM_LIMIT_SET', payload: { currency: 'USD', limitMinor: 10.5 } },
      'payload.limitMinor',
    ],
    [
      'numeric amount',
      { type: 'PROGRAM_LIMIT_SET', payload: { currency: 'USD', limitMinor: 10 } },
      'payload.limitMinor',
    ],
    [
      'zero external amount',
      {
        type: 'EXTERNAL_RESERVATION_CREATED',
        payload: { externalRef: 'T', invoiceId: 'I', currency: 'USD', amountMinor: '0' },
      },
      'payload.amountMinor',
    ],
    [
      'unknown payload field',
      { type: 'PROGRAM_LIMIT_SET', payload: { currency: 'USD', limitMinor: '1', extra: 1 } },
      'payload',
    ],
    ['unknown type', { type: 'PROGRAM_DELETED', payload: {} }, 'type'],
    [
      'zero version',
      { version: 0, type: 'PROGRAM_LIMIT_SET', payload: { currency: 'USD', limitMinor: '1' } },
      'version',
    ],
    [
      'bad timestamp',
      {
        occurredAt: 'yesterday',
        type: 'PROGRAM_LIMIT_SET',
        payload: { currency: 'USD', limitMinor: '1' },
      },
      'occurredAt',
    ],
    [
      'part > totalParts',
      {
        type: 'PROGRAM_RECONCILIATION_SNAPSHOT',
        payload: {
          snapshotId: 'S',
          part: 3,
          totalParts: 2,
          asOf: '2026-10-11T11:59:00Z',
          currency: 'USD',
          limitMinor: '1',
          reservations: [],
        },
      },
      'payload.part',
    ],
  ])('rejects %s with a field path', (_l, override, path) => {
    expect(issuesOf({ ...envelope, ...override }).join(' ')).toContain(path);
  });

  it.each([[null], ['not json'], [Buffer.from('{"a":')]])('rejects unusable bytes %p', (value) => {
    expect(() => parseTreasuryMessage(value)).toThrow(InvalidTreasuryMessageError);
  });

  it('rejects unsupported schema versions', () => {
    expect(
      issuesOf({
        ...envelope,
        schemaVersion: 2,
        type: 'PROGRAM_LIMIT_SET',
        payload: { currency: 'USD', limitMinor: '1' },
      }),
    ).not.toEqual([]);
  });
});
