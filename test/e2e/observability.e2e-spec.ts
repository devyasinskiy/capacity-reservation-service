import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Scope } from '../../src/modules/auth/scopes';
import { createManagementApp } from '../../src/modules/observability/management';
import { createApiApp, givenProgram, http } from '../support/app';
import { makeToken } from '../support/tokens';

interface SseEvent {
  event?: string;
  id?: string;
  data?: string;
}

/** Minimal SSE reader over fetch (Node 24): yields parsed events as they arrive. */
async function* readSse(url: string, token: string, signal: AbortSignal): AsyncGenerator<SseEvent> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const event: SseEvent = {};
      for (const line of block.split('\n')) {
        const [field, ...rest] = line.split(':');
        const value = rest.join(':').trimStart();
        if (field === 'event') event.event = value;
        else if (field === 'id') event.id = value;
        else if (field === 'data') event.data = (event.data ?? '') + value;
      }
      yield event;
    }
  }
}

describe('Observability: SSE and metrics (e2e)', () => {
  let app: NestExpressApplication;
  let management: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createApiApp();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    management = await createManagementApp(app);
    await management.init();
  });
  afterAll(async () => {
    await management?.close();
    await app?.close();
  });

  describe('GET /availability/stream (SSE, ADR-014)', () => {
    it('sends the current state, then a fresh consistent state after each committed change', async () => {
      const key = await givenProgram(app, { limitMinor: 10_000n });
      const token = makeToken({ tenant: key.tenantId, scopes: [Scope.READ, Scope.WRITE] });
      const abort = new AbortController();
      const events = readSse(
        `${baseUrl}/v1/programs/${key.programId}/availability/stream`,
        token,
        abort.signal,
      );
      try {
        const first = (await events.next()).value as SseEvent;
        expect(first.event).toBe('availability');
        expect(JSON.parse(first.data!)).toMatchObject({
          reserved: { amountMinor: '0' },
          version: '0',
        });

        await request(http(app))
          .post(`/v1/programs/${key.programId}/reservations`)
          .set('Authorization', `Bearer ${token}`)
          .send({ invoiceId: 'INV-SSE', amount: { amountMinor: '2500', currency: 'USD' } })
          .expect(201);

        let next = (await events.next()).value as SseEvent;
        while (next.event === 'heartbeat') next = (await events.next()).value as SseEvent;
        expect(next).toMatchObject({ event: 'availability', id: '1' });
        expect(JSON.parse(next.data!)).toMatchObject({
          reserved: { amountMinor: '2500', currency: 'USD' },
          available: { amountMinor: '7500', currency: 'USD' },
        });
      } finally {
        abort.abort();
      }
    });

    it('fails with a normal problem+json 404 before the stream opens', async () => {
      const token = makeToken({ tenant: 't-none', scopes: [Scope.READ] });
      const res = await fetch(`${baseUrl}/v1/programs/NOPE/availability/stream`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toMatch(/problem\+json/);
      expect(((await res.json()) as { code: string }).code).toBe('PROGRAM_NOT_FOUND');
    });

    it('requires authentication', async () => {
      const res = await fetch(`${baseUrl}/v1/programs/ANY/availability/stream`);
      expect(res.status).toBe(401);
      await res.body?.cancel();
    });
  });

  describe('GET /metrics (management port)', () => {
    it('exposes business and HTTP metrics with bounded labels', async () => {
      const key = await givenProgram(app, { limitMinor: 100n });
      const auth = `Bearer ${makeToken({ tenant: key.tenantId, scopes: [Scope.WRITE] })}`;
      const reserve = (invoiceId: string, amountMinor: string) =>
        request(http(app))
          .post(`/v1/programs/${key.programId}/reservations`)
          .set('Authorization', auth)
          .send({ invoiceId, amount: { amountMinor, currency: 'USD' } });
      await reserve('INV-M1', '60').expect(201);
      await reserve('INV-M2', '60').expect(409);

      const res = await request(http(management)).get('/metrics').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
      expect(res.text).toMatch(/capacity_reservations_total\{result="created"\} \d+/);
      expect(res.text).toMatch(/capacity_insufficient_capacity_rejections_total \d+/);
      expect(res.text).toContain('route="/v1/programs/:programId/reservations"');
      expect(res.text).toContain('process_cpu_seconds_total'); // default Node metrics
      expect(res.text).not.toContain(key.tenantId); // no high-cardinality / identifying labels
    });

    it('is not exposed on the public API port', async () => {
      await request(http(app)).get('/metrics').expect(404);
    });
  });
});
