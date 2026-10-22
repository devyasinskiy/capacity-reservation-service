/**
 * Publishes sample treasury messages to Kafka (dev/demo tool).
 *
 *   npm run publish -- limit       --program PRG-USD-001 --currency USD --limit 1500000000
 *   npm run publish -- ext-reserve --program PRG-USD-001 --ref TRS-1 --amount 250000 [--invoice INV-TRS-1]
 *   npm run publish -- ext-release --program PRG-USD-001 --ref TRS-1 --amount 100000
 *   npm run publish -- snapshot    --program PRG-USD-001 [--parts 3] [--omit 1] [--limit <minor>]
 *   npm run publish -- poison      (malformed bytes → DLQ)
 *
 * Common: --tenant t-1 --brokers localhost:19092 --topic treasury.capacity.v1 --correlation-id <id>
 *         --version <n> (default: Date.now(), monotonic enough for a demo).
 * `snapshot` builds treasury's view from the current database (DATABASE_URL), as of now;
 * `--omit N` drops the N most recent reservations to simulate treasury missing them.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { createDatabase } from '../src/shared/database/database';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tenant: { type: 'string', default: 't-1' },
    program: { type: 'string', default: 'PRG-USD-001' },
    brokers: { type: 'string', default: process.env.KAFKA_BROKERS ?? 'localhost:19092' },
    topic: { type: 'string', default: process.env.KAFKA_TREASURY_TOPIC ?? 'treasury.capacity.v1' },
    'correlation-id': { type: 'string' },
    version: { type: 'string' },
    currency: { type: 'string', default: 'USD' },
    limit: { type: 'string' },
    ref: { type: 'string' },
    invoice: { type: 'string' },
    amount: { type: 'string' },
    parts: { type: 'string', default: '1' },
    omit: { type: 'string', default: '0' },
  },
});

const command = positionals[0];
const version = values.version ?? String(Date.now());
const correlationId = values['correlation-id'] ?? `sample-${randomUUID()}`;

const envelope = (type: string, payload: object) => ({
  messageId: randomUUID(),
  type,
  schemaVersion: 1,
  tenantId: values.tenant,
  programId: values.program,
  version,
  occurredAt: new Date().toISOString(),
  payload,
});

function required(name: 'limit' | 'ref' | 'amount'): string {
  const v = values[name];
  if (!v) throw new Error(`--${name} is required for "${command}"`);
  return v;
}

async function buildSnapshot(): Promise<object[]> {
  const url = process.env.DATABASE_URL ?? 'postgres://app:app@localhost:5432/capacity';
  const db = createDatabase(url, { poolMax: 1, applicationName: 'publish-sample' });
  try {
    const program = await db
      .selectFrom('programs')
      .select(['currency', 'limit_minor'])
      .where('tenant_id', '=', values.tenant)
      .where('program_id', '=', values.program)
      .executeTakeFirstOrThrow();
    const rows = await db
      .selectFrom('reservations')
      .select([
        'id',
        'origin',
        'external_ref',
        'invoice_id',
        'program_amount_minor',
        'released_program_minor',
      ])
      .where('tenant_id', '=', values.tenant)
      .where('program_id', '=', values.program)
      .orderBy('created_at', 'desc')
      .execute();
    const reservations = rows.slice(Number(values.omit)).map((r) => ({
      origin: r.origin,
      ref: r.origin === 'EXTERNAL' ? r.external_ref! : r.id,
      invoiceId: r.invoice_id,
      outstandingMinor: (r.program_amount_minor - r.released_program_minor).toString(),
    }));
    const totalParts = Math.max(1, Number(values.parts));
    const snapshotId = `SNAP-${randomUUID().slice(0, 8)}`;
    const asOf = new Date().toISOString();
    return Array.from({ length: totalParts }, (_, i) =>
      envelope('PROGRAM_RECONCILIATION_SNAPSHOT', {
        snapshotId,
        part: i + 1,
        totalParts,
        asOf,
        currency: program.currency,
        limitMinor: values.limit ?? program.limit_minor.toString(),
        reservations: reservations.filter((_, idx) => idx % totalParts === i),
      }),
    );
  } finally {
    await db.destroy();
  }
}

async function messagesFor(cmd: string | undefined): Promise<Array<object | string>> {
  switch (cmd) {
    case 'limit':
      return [
        envelope('PROGRAM_LIMIT_SET', { currency: values.currency, limitMinor: required('limit') }),
      ];
    case 'ext-reserve': {
      const ref = required('ref');
      return [
        envelope('EXTERNAL_RESERVATION_CREATED', {
          externalRef: ref,
          invoiceId: values.invoice ?? `INV-${ref}`,
          currency: values.currency,
          amountMinor: required('amount'),
        }),
      ];
    }
    case 'ext-release':
      return [
        envelope('EXTERNAL_RESERVATION_RELEASED', {
          externalRef: required('ref'),
          currency: values.currency,
          amountMinor: required('amount'),
        }),
      ];
    case 'snapshot':
      return buildSnapshot();
    case 'poison':
      return ['{"definitely": not json'];
    default:
      throw new Error(
        'Usage: publish-sample <limit|ext-reserve|ext-release|snapshot|poison> [options] — see file header',
      );
  }
}

async function main(): Promise<void> {
  const messages = await messagesFor(command);
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: values.brokers.split(','), logLevel: KafkaJS.logLevel.ERROR },
  });
  const producer = kafka.producer({ kafkaJS: { acks: -1 } });
  await producer.connect();
  try {
    await producer.send({
      topic: values.topic,
      messages: messages.map((m) => ({
        key: `${values.tenant}:${values.program}`, // per-program ordering (ADR-010)
        value: typeof m === 'string' ? m : JSON.stringify(m),
        headers: { 'x-correlation-id': correlationId },
      })),
    });
  } finally {
    await producer.disconnect();
  }
  for (const m of messages) console.log(typeof m === 'string' ? m : JSON.stringify(m));
  console.error(
    `Published ${messages.length} message(s) to ${values.topic} (correlation-id ${correlationId})`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
