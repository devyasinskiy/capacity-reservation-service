import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import { RedpandaContainer, type StartedRedpandaContainer } from '@testcontainers/redpanda';
import type { Kysely } from 'kysely';
import type { Database } from '../../src/shared/database/database.types';
import { RetryableError } from '../../src/shared/errors/retryable-error';
import { ApplyTreasuryMessage } from '../../src/modules/capacity/application/apply-treasury-message';
import { KyselyCapacityStore } from '../../src/modules/capacity/infrastructure/persistence/kysely-capacity-store';
import { auditLedger } from '../../src/modules/capacity/infrastructure/persistence/ledger-audit';
import { TreasuryMessageListener } from '../../src/modules/capacity/messaging/treasury-message.listener';
import { ConfluentTreasuryKafka } from '../../src/infrastructure/kafka/confluent-kafka';
import { testDatabase, uniqueTenant } from '../support/db';
import { treasuryMessages } from '../support/treasury-messages';
import { waitFor } from '../support/wait-for';

jest.setTimeout(180_000);

/**
 * Real broker (Redpanda) + real Postgres: proves at-least-once consumption with commit-after-
 * DB-commit, inbox dedup, retry with backoff and dead-lettering that never blocks a partition.
 */
describe('treasury Kafka consumer (integration)', () => {
  let redpanda: StartedRedpandaContainer;
  let brokers: string[];
  let kafka: KafkaJS.Kafka;
  let producer: KafkaJS.Producer;
  let db: Kysely<Database>;
  let store: KyselyCapacityStore;
  const running: Array<{ listener: TreasuryMessageListener }> = [];

  beforeAll(async () => {
    Logger.overrideLogger(['error']);
    redpanda = await new RedpandaContainer('redpandadata/redpanda:v26.2.4').start();
    brokers = [redpanda.getBootstrapServers()];
    kafka = new KafkaJS.Kafka({ kafkaJS: { brokers, logLevel: KafkaJS.logLevel.ERROR } });
    producer = kafka.producer();
    await producer.connect();
    db = testDatabase({ poolMax: 10 });
    store = new KyselyCapacityStore(db, { lockTimeoutMs: 5000, statementTimeoutMs: 10000 });
  });

  afterAll(async () => {
    for (const r of running) await r.listener.stop();
    await producer?.disconnect();
    await db?.destroy();
    await redpanda?.stop();
  });

  /** Fresh topics + group per test so tests are independent. */
  async function harness(
    opts: {
      apply?: ApplyTreasuryMessage;
      maxAttempts?: number;
      groupId?: string;
      topic?: string;
    } = {},
  ) {
    const topic = opts.topic ?? `treasury-${randomUUID().slice(0, 8)}`;
    const dlqTopic = `${topic}.dlq`;
    const admin = kafka.admin();
    await admin.connect();
    await admin
      .createTopics({
        topics: [
          { topic, numPartitions: 3 },
          { topic: dlqTopic, numPartitions: 1 },
        ],
      })
      .catch(() => undefined);
    await admin.disconnect();

    const groupId = opts.groupId ?? `group-${randomUUID().slice(0, 8)}`;
    const client = new ConfluentTreasuryKafka({
      brokers,
      clientId: 'test',
      groupId,
      topic,
      dlqTopic,
      partitionsConsumedConcurrently: 3,
    });
    const listener = new TreasuryMessageListener(
      client,
      opts.apply ?? new ApplyTreasuryMessage(store),
      client,
      {
        maxAttempts: opts.maxAttempts ?? 3,
        initialDelayMs: 10,
        maxDelayMs: 50,
      },
    );
    running.push({ listener });
    await listener.start();

    const key = { tenantId: uniqueTenant(), programId: 'PRG-K' };
    const msgs = treasuryMessages(key.tenantId, key.programId);
    const send = (value: object | string, correlationId: string = randomUUID()) =>
      producer.send({
        topic,
        messages: [
          {
            key: `${key.tenantId}:${key.programId}`, // per-program ordering (ADR-010)
            value: typeof value === 'string' ? value : JSON.stringify(value),
            headers: { 'x-correlation-id': correlationId },
          },
        ],
      });
    return { topic, dlqTopic, groupId, client, listener, key, msgs, send };
  }

  async function readDlq(dlqTopic: string, expected: number) {
    const consumer = kafka.consumer({
      kafkaJS: { groupId: `dlq-reader-${randomUUID()}`, fromBeginning: true },
    });
    const seen: Array<{ value: string; headers: Record<string, string> }> = [];
    await consumer.connect();
    await consumer.subscribe({ topics: [dlqTopic] });
    await consumer.run({
      eachMessage: ({ message }) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(message.headers ?? {}))
          headers[k] = String(Array.isArray(v) ? v[0] : v);
        seen.push({ value: message.value?.toString() ?? '', headers });
        return Promise.resolve();
      },
    });
    try {
      await waitFor(() => Promise.resolve(seen.length >= expected), 60_000);
      return seen;
    } finally {
      await consumer.disconnect();
    }
  }

  const reserved = async (key: { tenantId: string; programId: string }) =>
    (await store.findProgram(key))?.reserved.minor;
  const inboxCount = async (tenantId: string) =>
    Number(
      (
        await db
          .selectFrom('inbox_messages')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('tenant_id', '=', tenantId)
          .executeTakeFirstOrThrow()
      ).n,
    );

  async function committedOffsets(groupId: string, topic: string): Promise<bigint> {
    const admin = kafka.admin();
    await admin.connect();
    try {
      const offsets = await admin.fetchOffsets({ groupId, topics: [topic] });
      return offsets[0]!.partitions.reduce(
        (sum, p) => sum + (BigInt(p.offset) > 0n ? BigInt(p.offset) : 0n),
        0n,
      );
    } finally {
      await admin.disconnect();
    }
  }

  it('applies a limit set, external reserve and partial release; commits offsets; propagates correlation IDs', async () => {
    const h = await harness();
    await h.send(h.msgs.limitSet('100000'), 'corr-limit');
    await h.send(h.msgs.externalCreated('T-1', '30000'));
    await h.send(h.msgs.externalReleased('T-1', '10000'));

    await waitFor(
      async () => (await reserved(h.key)) === 20000n && (await inboxCount(h.key.tenantId)) === 3,
    );
    const ledger = await db
      .selectFrom('ledger_entries')
      .selectAll()
      .where('tenant_id', '=', h.key.tenantId)
      .orderBy('id')
      .execute();
    expect(ledger.map((l) => l.type)).toEqual([
      'LIMIT_SET',
      'EXTERNAL_RESERVE',
      'EXTERNAL_RELEASE',
    ]);
    expect(ledger[0]).toMatchObject({ source: 'KAFKA', correlation_id: 'corr-limit' });
    expect((await auditLedger(db, { tenantId: h.key.tenantId })).mismatches).toEqual([]);
    await waitFor(async () => (await committedOffsets(h.groupId, h.topic)) === 3n);
  });

  it('reconciles a chunked snapshot delivered through the broker (parts on the same partition)', async () => {
    const h = await harness();
    await h.send(h.msgs.limitSet('5000'));
    await h.send(h.msgs.externalCreated('T-1', '100'));
    await waitFor(async () => (await reserved(h.key)) === 100n);
    const parts = h.msgs.snapshot({
      asOf: new Date(Date.now() + 2000),
      limitMinor: '7000',
      totalParts: 3,
      reservations: [
        { origin: 'EXTERNAL', ref: 'T-1', invoiceId: 'INV-T-1', outstandingMinor: '100' },
        { origin: 'EXTERNAL', ref: 'T-2', invoiceId: 'INV-T-2', outstandingMinor: '0' },
      ],
    });
    for (const p of parts) await h.send(p);
    await waitFor(async () => (await store.findProgram(h.key))?.limit.minor === 7000n);
    const runs = await db
      .selectFrom('reconciliation_runs')
      .selectAll()
      .where('tenant_id', '=', h.key.tenantId)
      .execute();
    expect(runs).toMatchObject([{ discrepancy_count: 0, treasury_total_minor: 100n }]);
  });

  it('dead-letters a poison message immediately and keeps consuming the same partition', async () => {
    const h = await harness();
    await h.send(h.msgs.limitSet('5000'));
    await h.send('{"this is": not json', 'corr-poison');
    await h.send(h.msgs.externalCreated('T-1', '100')); // same key → same partition, after the poison

    await waitFor(async () => (await reserved(h.key)) === 100n);
    const [letter] = await readDlq(h.dlqTopic, 1);
    expect(letter!.value).toBe('{"this is": not json');
    expect(letter!.headers).toMatchObject({
      'x-error-code': 'INVALID_MESSAGE',
      'x-attempts': '1',
      'x-original-topic': h.topic,
      'x-correlation-id': 'corr-poison',
    });
  });

  it('dead-letters business-rule violations (no retries) with the domain code', async () => {
    const h = await harness();
    await h.send(h.msgs.limitSet('5000'));
    await h.send(h.msgs.externalCreated('T-1', '100'));
    await h.send(h.msgs.externalReleased('T-1', '101'));
    const [letter] = await readDlq(h.dlqTopic, 1);
    expect(letter!.headers).toMatchObject({ 'x-error-code': 'OVER_RELEASE', 'x-attempts': '1' });
    expect(await reserved(h.key)).toBe(100n);
  });

  it('applies a redelivered message once (inbox dedup)', async () => {
    const h = await harness();
    const limit = h.msgs.limitSet('5000');
    const create = h.msgs.externalCreated('T-1', '100');
    await h.send(limit);
    await h.send(create);
    await h.send(create); // producer retry / replay
    await waitFor(async () => (await committedOffsets(h.groupId, h.topic)) === 3n);
    expect(await reserved(h.key)).toBe(100n);
    expect(await inboxCount(h.key.tenantId)).toBe(2);
  });

  it('does not reprocess committed messages after a consumer restart', async () => {
    const first = await harness();
    await first.send(first.msgs.limitSet('5000'));
    await first.send(first.msgs.externalCreated('T-1', '100'));
    await waitFor(async () => (await committedOffsets(first.groupId, first.topic)) === 2n);
    await first.listener.stop();

    const apply = new ApplyTreasuryMessage(store);
    const spy = jest.spyOn(apply, 'execute');
    const second = await harness({ apply, groupId: first.groupId, topic: first.topic });
    await second.send(first.msgs.externalCreated('T-2', '50'));
    await waitFor(async () => (await reserved(first.key)) === 150n);
    expect(spy).toHaveBeenCalledTimes(1); // only the new message
  });

  it('retries transient failures with backoff and then succeeds without dead-lettering', async () => {
    const real = new ApplyTreasuryMessage(store);
    let failures = 2;
    const flaky = Object.assign(Object.create(real) as ApplyTreasuryMessage, {
      execute: (...args: Parameters<ApplyTreasuryMessage['execute']>) =>
        failures-- > 0
          ? Promise.reject(new RetryableError('db blip', 'CONNECTION'))
          : real.execute(...args),
    });
    const h = await harness({ apply: flaky, maxAttempts: 5 });
    await h.send(h.msgs.limitSet('5000'));
    await waitFor(async () => (await store.findProgram(h.key))?.limit.minor === 5000n);
    expect(failures).toBe(-1);
    await waitFor(async () => (await committedOffsets(h.groupId, h.topic)) === 1n);
  });

  it('dead-letters after exhausting retries so the partition is never blocked forever', async () => {
    const real = new ApplyTreasuryMessage(store);
    const h0 = { calls: 0 };
    const alwaysDown = Object.assign(Object.create(real) as ApplyTreasuryMessage, {
      execute: (...args: Parameters<ApplyTreasuryMessage['execute']>) => {
        h0.calls++;
        const [message] = args;
        return message.type === 'PROGRAM_LIMIT_SET' && h0.calls <= 3
          ? Promise.reject(new RetryableError('db down', 'CONNECTION'))
          : real.execute(...args);
      },
    });
    const h = await harness({ apply: alwaysDown, maxAttempts: 3 });
    await h.send(h.msgs.limitSet('5000'));
    const [letter] = await readDlq(h.dlqTopic, 1);
    expect(letter!.headers).toMatchObject({
      'x-error-code': 'TRANSIENT_CONNECTION',
      'x-attempts': '3',
    });
    await waitFor(async () => (await committedOffsets(h.groupId, h.topic)) === 1n);
  });
});
