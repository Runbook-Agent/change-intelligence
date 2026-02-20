import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server';
import { ChangeEventStore } from '../store';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-idempotency-${randomUUID()}.db`);
}

describe('Idempotent Event Ingestion', () => {
  let server: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = await createServer({ dbPath });
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('POST with idempotencyKey returns 201 on first call', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: {
        service: 'api',
        changeType: 'deployment',
        summary: 'Deploy v1.0',
        idempotencyKey: 'key-1',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().id).toBeDefined();
  });

  it('POST with same idempotencyKey returns 200 with same event ID', async () => {
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: {
        service: 'api',
        changeType: 'deployment',
        summary: 'Deploy v1.0',
        idempotencyKey: 'key-2',
      },
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id;

    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: {
        service: 'api',
        changeType: 'deployment',
        summary: 'Deploy v1.0',
        idempotencyKey: 'key-2',
      },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(firstId);
  });

  it('POST with different idempotencyKey returns 201 with new ID', async () => {
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: {
        service: 'api',
        changeType: 'deployment',
        summary: 'Deploy v1.0',
        idempotencyKey: 'key-3',
      },
    });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: {
        service: 'api',
        changeType: 'deployment',
        summary: 'Deploy v2.0',
        idempotencyKey: 'key-4',
      },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(first.json().id);
  });

  it('POST without idempotencyKey always returns 201', async () => {
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { service: 'api', changeType: 'deployment', summary: 'Deploy v1' },
    });
    expect(first.statusCode).toBe(201);

    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/events',
      payload: { service: 'api', changeType: 'deployment', summary: 'Deploy v1' },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(first.json().id);
  });
});

describe('Store idempotency methods', () => {
  let store: ChangeEventStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = tmpDb();
    store = new ChangeEventStore(dbPath);
  });

  afterEach(() => {
    store.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  it('getByIdempotencyKey returns null for non-existent key', () => {
    expect(store.getByIdempotencyKey('nonexistent')).toBeNull();
  });

  it('getByIdempotencyKey returns the event for an existing key', () => {
    const event = store.insert({
      service: 'api',
      changeType: 'deployment',
      summary: 'test',
      idempotencyKey: 'my-key',
    });

    const found = store.getByIdempotencyKey('my-key');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(event.id);
    expect(found!.idempotencyKey).toBe('my-key');
  });

  it('insert stores idempotencyKey correctly', () => {
    const event = store.insert({
      service: 'api',
      changeType: 'deployment',
      summary: 'test',
      idempotencyKey: 'store-key',
    });
    expect(event.idempotencyKey).toBe('store-key');

    const fetched = store.get(event.id);
    expect(fetched!.idempotencyKey).toBe('store-key');
  });

  it('insert without idempotencyKey leaves it undefined', () => {
    const event = store.insert({
      service: 'api',
      changeType: 'deployment',
      summary: 'test',
    });
    expect(event.idempotencyKey).toBeUndefined();
  });
});
