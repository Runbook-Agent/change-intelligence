import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChangeEventStore } from '../store';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-changes-${randomUUID()}.db`);
}

describe('ChangeEventStore', () => {
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

  describe('insert + get', () => {
    it('inserts and retrieves an event', () => {
      const event = store.insert({
        service: 'api-gateway',
        changeType: 'deployment',
        summary: 'Deploy v2.3.1',
        environment: 'production',
        tags: ['release'],
      });

      expect(event.id).toBeDefined();
      expect(event.service).toBe('api-gateway');
      expect(event.changeType).toBe('deployment');

      const fetched = store.get(event.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.service).toBe('api-gateway');
      expect(fetched!.tags).toEqual(['release']);
    });

    it('returns null for non-existent ID', () => {
      expect(store.get('non-existent')).toBeNull();
    });
  });

  describe('update', () => {
    it('updates event fields', () => {
      const event = store.insert({
        service: 'user-service',
        changeType: 'deployment',
        summary: 'Deploy v1.0',
        status: 'in_progress',
      });

      const updated = store.update(event.id, { status: 'completed' });
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe('completed');
      expect(updated!.updatedAt).toBeDefined();
    });

    it('returns null for non-existent ID', () => {
      expect(store.update('non-existent', { status: 'completed' })).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes an event', () => {
      const event = store.insert({
        service: 'api',
        changeType: 'deployment',
        summary: 'test',
      });

      expect(store.delete(event.id)).toBe(true);
      expect(store.get(event.id)).toBeNull();
    });

    it('returns false for non-existent ID', () => {
      expect(store.delete('non-existent')).toBe(false);
    });
  });

  describe('query', () => {
    beforeEach(() => {
      store.insert({ service: 'api-gateway', changeType: 'deployment', summary: 'Deploy api', environment: 'production' });
      store.insert({ service: 'user-service', changeType: 'config_change', summary: 'Config update', environment: 'staging' });
      store.insert({ service: 'api-gateway', changeType: 'config_change', summary: 'Feature flag toggle', environment: 'production', source: 'github' });
    });

    it('queries by service', () => {
      const results = store.query({ services: ['api-gateway'] });
      expect(results.length).toBe(2);
    });

    it('queries by change type', () => {
      const results = store.query({ changeTypes: ['config_change'] });
      expect(results.length).toBe(2);
    });

    it('queries by environment', () => {
      const results = store.query({ environment: 'staging' });
      expect(results.length).toBe(1);
      expect(results[0].service).toBe('user-service');
    });

    it('queries by source', () => {
      const results = store.query({ sources: ['github'] });
      expect(results.length).toBe(1);
    });

    it('returns all with no filters', () => {
      const results = store.query({});
      expect(results.length).toBe(3);
    });

    it('respects limit', () => {
      const results = store.query({ limit: 1 });
      expect(results.length).toBe(1);
    });
  });

  describe('search (FTS)', () => {
    it('finds events by summary text', () => {
      store.insert({ service: 'payment-service', changeType: 'deployment', summary: 'Fix payment processing timeout issue' });
      store.insert({ service: 'user-service', changeType: 'deployment', summary: 'Add new user profile feature' });

      const results = store.search('payment timeout');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].service).toBe('payment-service');
    });

    it('returns empty for no match', () => {
      store.insert({ service: 'api', changeType: 'deployment', summary: 'test deploy' });
      const results = store.search('xyznonexistent');
      expect(results.length).toBe(0);
    });
  });

  describe('velocity', () => {
    it('computes velocity for a service', () => {
      store.insert({ service: 'api', changeType: 'deployment', summary: 'deploy 1' });
      store.insert({ service: 'api', changeType: 'config_change', summary: 'config 1' });
      store.insert({ service: 'other', changeType: 'deployment', summary: 'other deploy' });

      const velocity = store.getVelocity('api', 60);
      expect(velocity.service).toBe('api');
      expect(velocity.changeCount).toBe(2);
      expect(velocity.changeTypes.deployment).toBe(1);
      expect(velocity.changeTypes.config_change).toBe(1);
    });
  });

  describe('velocity trend', () => {
    it('computes multi-period trend', () => {
      store.insert({ service: 'api', changeType: 'deployment', summary: 'deploy 1' });

      const trend = store.getVelocityTrend('api', 60, 3);
      expect(trend.length).toBe(3);
      // The most recent period should have our event
      const lastPeriod = trend[trend.length - 1];
      expect(lastPeriod.changeCount).toBe(1);
    });
  });

  describe('prune', () => {
    it('prunes old events', () => {
      const oldTimestamp = new Date(Date.now() - 100 * 24 * 60 * 60_000).toISOString();
      store.insert({ service: 'api', changeType: 'deployment', summary: 'old deploy', timestamp: oldTimestamp });
      store.insert({ service: 'api', changeType: 'deployment', summary: 'new deploy' });

      const pruned = store.pruneOlderThan(30);
      expect(pruned).toBe(1);

      const all = store.query({});
      expect(all.length).toBe(1);
      expect(all[0].summary).toBe('new deploy');
    });
  });

  describe('stats', () => {
    it('returns correct statistics', () => {
      store.insert({ service: 'api', changeType: 'deployment', summary: 'a', source: 'github', environment: 'production' });
      store.insert({ service: 'db', changeType: 'db_migration', summary: 'b', source: 'manual', environment: 'staging' });

      const stats = store.getStats();
      expect(stats.total).toBe(2);
      expect(stats.byType.deployment).toBe(1);
      expect(stats.byType.db_migration).toBe(1);
      expect(stats.bySource.github).toBe(1);
      expect(stats.bySource.manual).toBe(1);
      expect(stats.byEnvironment.production).toBe(1);
      expect(stats.byEnvironment.staging).toBe(1);
    });

    it('returns zeros for empty store', () => {
      const stats = store.getStats();
      expect(stats.total).toBe(0);
    });
  });
});
