/**
 * ChangeEventStore — SQLite-backed storage for change events
 *
 * Uses better-sqlite3 with FTS5 for full-text search on summary + service fields.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type {
  ChangeEvent,
  ChangeQueryOptions,
  ChangeVelocityMetric,
  ChangeType,
} from './types';

export class ChangeEventStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS change_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        service TEXT NOT NULL,
        additional_services TEXT DEFAULT '[]',
        change_type TEXT NOT NULL,
        source TEXT NOT NULL,
        initiator TEXT NOT NULL DEFAULT 'unknown',
        initiator_identity TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        environment TEXT NOT NULL DEFAULT 'production',
        commit_sha TEXT,
        pr_number TEXT,
        pr_url TEXT,
        repository TEXT,
        branch TEXT,
        summary TEXT NOT NULL,
        diff TEXT,
        files_changed TEXT DEFAULT '[]',
        config_keys TEXT DEFAULT '[]',
        previous_version TEXT,
        new_version TEXT,
        blast_radius TEXT,
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ce_timestamp ON change_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ce_service ON change_events(service);
      CREATE INDEX IF NOT EXISTS idx_ce_change_type ON change_events(change_type);
      CREATE INDEX IF NOT EXISTS idx_ce_environment ON change_events(environment);
      CREATE INDEX IF NOT EXISTS idx_ce_status ON change_events(status);
      CREATE INDEX IF NOT EXISTS idx_ce_commit_sha ON change_events(commit_sha);

      CREATE VIRTUAL TABLE IF NOT EXISTS change_events_fts USING fts5(
        summary,
        service,
        content='change_events',
        content_rowid='rowid'
      );

      CREATE TRIGGER IF NOT EXISTS ce_ai AFTER INSERT ON change_events BEGIN
        INSERT INTO change_events_fts(rowid, summary, service)
        VALUES (NEW.rowid, NEW.summary, NEW.service);
      END;

      CREATE TRIGGER IF NOT EXISTS ce_ad AFTER DELETE ON change_events BEGIN
        INSERT INTO change_events_fts(change_events_fts, rowid, summary, service)
        VALUES('delete', OLD.rowid, OLD.summary, OLD.service);
      END;

      CREATE TRIGGER IF NOT EXISTS ce_au AFTER UPDATE ON change_events BEGIN
        INSERT INTO change_events_fts(change_events_fts, rowid, summary, service)
        VALUES('delete', OLD.rowid, OLD.summary, OLD.service);
        INSERT INTO change_events_fts(rowid, summary, service)
        VALUES (NEW.rowid, NEW.summary, NEW.service);
      END;
    `);
  }

  insert(event: Partial<ChangeEvent> & { service: string; changeType: string; summary: string }): ChangeEvent {
    const now = new Date().toISOString();
    const id = event.id || randomUUID();

    const full: ChangeEvent = {
      id,
      timestamp: event.timestamp || now,
      service: event.service,
      additionalServices: event.additionalServices || [],
      changeType: event.changeType as ChangeEvent['changeType'],
      source: (event.source as ChangeEvent['source']) || 'manual',
      initiator: (event.initiator as ChangeEvent['initiator']) || 'unknown',
      initiatorIdentity: event.initiatorIdentity,
      status: (event.status as ChangeEvent['status']) || 'completed',
      environment: event.environment || 'production',
      commitSha: event.commitSha,
      prNumber: event.prNumber,
      prUrl: event.prUrl,
      repository: event.repository,
      branch: event.branch,
      summary: event.summary,
      diff: event.diff,
      filesChanged: event.filesChanged,
      configKeys: event.configKeys,
      previousVersion: event.previousVersion,
      newVersion: event.newVersion,
      blastRadius: event.blastRadius,
      tags: event.tags || [],
      metadata: event.metadata || {},
      createdAt: event.createdAt || now,
      updatedAt: event.updatedAt || now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO change_events
      (id, timestamp, service, additional_services, change_type, source, initiator,
       initiator_identity, status, environment, commit_sha, pr_number, pr_url,
       repository, branch, summary, diff, files_changed, config_keys,
       previous_version, new_version, blast_radius, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      full.id,
      full.timestamp,
      full.service,
      JSON.stringify(full.additionalServices),
      full.changeType,
      full.source,
      full.initiator,
      full.initiatorIdentity || null,
      full.status,
      full.environment,
      full.commitSha || null,
      full.prNumber || null,
      full.prUrl || null,
      full.repository || null,
      full.branch || null,
      full.summary,
      full.diff || null,
      JSON.stringify(full.filesChanged || []),
      JSON.stringify(full.configKeys || []),
      full.previousVersion || null,
      full.newVersion || null,
      full.blastRadius ? JSON.stringify(full.blastRadius) : null,
      JSON.stringify(full.tags),
      JSON.stringify(full.metadata),
      full.createdAt,
      full.updatedAt,
    );

    return full;
  }

  get(id: string): ChangeEvent | null {
    const row = this.db.prepare('SELECT * FROM change_events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEvent(row);
  }

  update(id: string, updates: Partial<ChangeEvent>): ChangeEvent | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const setClauses: string[] = [];
    const params: unknown[] = [];

    const fieldMap: Record<string, string> = {
      timestamp: 'timestamp',
      service: 'service',
      additionalServices: 'additional_services',
      changeType: 'change_type',
      source: 'source',
      initiator: 'initiator',
      initiatorIdentity: 'initiator_identity',
      status: 'status',
      environment: 'environment',
      commitSha: 'commit_sha',
      prNumber: 'pr_number',
      prUrl: 'pr_url',
      repository: 'repository',
      branch: 'branch',
      summary: 'summary',
      diff: 'diff',
      filesChanged: 'files_changed',
      configKeys: 'config_keys',
      previousVersion: 'previous_version',
      newVersion: 'new_version',
      blastRadius: 'blast_radius',
      tags: 'tags',
      metadata: 'metadata',
    };

    const jsonFields = new Set([
      'additionalServices', 'filesChanged', 'configKeys', 'blastRadius', 'tags', 'metadata',
    ]);

    for (const [key, column] of Object.entries(fieldMap)) {
      if (key in updates) {
        setClauses.push(`${column} = ?`);
        const value = (updates as Record<string, unknown>)[key];
        params.push(jsonFields.has(key) ? JSON.stringify(value) : (value ?? null));
      }
    }

    if (setClauses.length === 0) return existing;

    setClauses.push('updated_at = ?');
    params.push(now);
    params.push(id);

    this.db.prepare(`UPDATE change_events SET ${setClauses.join(', ')} WHERE id = ?`).run(...params);
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM change_events WHERE id = ?').run(id);
    return result.changes > 0;
  }

  query(options: ChangeQueryOptions = {}): ChangeEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.services && options.services.length > 0) {
      const serviceConditions = options.services.map(() => 'service = ?');
      const additionalConditions = options.services.map(() => 'additional_services LIKE ?');
      conditions.push(
        `(${[...serviceConditions, ...additionalConditions].join(' OR ')})`
      );
      params.push(...options.services, ...options.services.map(s => `%"${s}"%`));
    }

    if (options.changeTypes && options.changeTypes.length > 0) {
      conditions.push(`change_type IN (${options.changeTypes.map(() => '?').join(',')})`);
      params.push(...options.changeTypes);
    }

    if (options.sources && options.sources.length > 0) {
      conditions.push(`source IN (${options.sources.map(() => '?').join(',')})`);
      params.push(...options.sources);
    }

    if (options.environment) {
      conditions.push('environment = ?');
      params.push(options.environment);
    }

    if (options.since) {
      conditions.push('timestamp >= ?');
      params.push(options.since);
    }

    if (options.until) {
      conditions.push('timestamp <= ?');
      params.push(options.until);
    }

    if (options.initiator) {
      conditions.push('initiator = ?');
      params.push(options.initiator);
    }

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }

    const limit = options.limit || 50;
    let sql = 'SELECT * FROM change_events';
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(row => this.rowToEvent(row));
  }

  search(query: string, limit: number = 20): ChangeEvent[] {
    const ftsTerms = query
      .split(/\s+/)
      .filter(t => t.length > 1)
      .map(t => `"${t}"*`)
      .join(' OR ');

    if (!ftsTerms) return [];

    const sql = `
      SELECT ce.*
      FROM change_events_fts fts
      JOIN change_events ce ON fts.rowid = ce.rowid
      WHERE change_events_fts MATCH ?
      ORDER BY bm25(change_events_fts)
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(ftsTerms, limit) as Record<string, unknown>[];
    return rows.map(row => this.rowToEvent(row));
  }

  getRecentForServices(services: string[], windowMinutes: number): ChangeEvent[] {
    const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
    return this.query({ services, since, limit: 100 });
  }

  getVelocity(service: string, windowMinutes: number): ChangeVelocityMetric {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60_000);

    // Get type counts
    const typeRows = this.db.prepare(`
      SELECT change_type, COUNT(*) as count
      FROM change_events
      WHERE service = ? AND timestamp >= ?
      GROUP BY change_type
    `).all(service, windowStart.toISOString()) as { change_type: string; count: number }[];

    const changeTypes: Partial<Record<ChangeType, number>> = {};
    let changeCount = 0;
    for (const row of typeRows) {
      changeTypes[row.change_type as ChangeType] = row.count;
      changeCount += row.count;
    }

    // Get timestamps for interval calculation
    const tsRows = this.db.prepare(`
      SELECT timestamp FROM change_events
      WHERE service = ? AND timestamp >= ?
      ORDER BY timestamp ASC
    `).all(service, windowStart.toISOString()) as { timestamp: string }[];

    const timestamps = tsRows.map(r => new Date(r.timestamp).getTime());

    let averageIntervalMinutes = 0;
    if (timestamps.length > 1) {
      const intervals: number[] = [];
      for (let i = 1; i < timestamps.length; i++) {
        intervals.push((timestamps[i] - timestamps[i - 1]) / 60_000);
      }
      averageIntervalMinutes = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    }

    return {
      service,
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
      changeCount,
      changeTypes,
      averageIntervalMinutes,
    };
  }

  getVelocityTrend(service: string, windowMinutes: number, periods: number): ChangeVelocityMetric[] {
    const metrics: ChangeVelocityMetric[] = [];
    const now = Date.now();

    for (let i = 0; i < periods; i++) {
      const periodEnd = new Date(now - i * windowMinutes * 60_000);
      const periodStart = new Date(periodEnd.getTime() - windowMinutes * 60_000);

      const rows = this.db.prepare(`
        SELECT change_type, COUNT(*) as count
        FROM change_events
        WHERE service = ? AND timestamp >= ? AND timestamp <= ?
        GROUP BY change_type
      `).all(service, periodStart.toISOString(), periodEnd.toISOString()) as { change_type: string; count: number }[];

      const changeTypes: Partial<Record<ChangeType, number>> = {};
      let changeCount = 0;
      for (const row of rows) {
        changeTypes[row.change_type as ChangeType] = row.count;
        changeCount += row.count;
      }

      metrics.push({
        service,
        windowStart: periodStart.toISOString(),
        windowEnd: periodEnd.toISOString(),
        changeCount,
        changeTypes,
        averageIntervalMinutes: changeCount > 1 ? windowMinutes / changeCount : 0,
      });
    }

    return metrics.reverse();
  }

  pruneOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const result = this.db.prepare('DELETE FROM change_events WHERE timestamp < ?').run(cutoff);
    return result.changes;
  }

  getStats(): {
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    byEnvironment: Record<string, number>;
  } {
    const total = (this.db.prepare('SELECT COUNT(*) as count FROM change_events').get() as { count: number }).count;

    const byType: Record<string, number> = {};
    const typeRows = this.db.prepare('SELECT change_type, COUNT(*) as count FROM change_events GROUP BY change_type').all() as { change_type: string; count: number }[];
    for (const row of typeRows) byType[row.change_type] = row.count;

    const bySource: Record<string, number> = {};
    const sourceRows = this.db.prepare('SELECT source, COUNT(*) as count FROM change_events GROUP BY source').all() as { source: string; count: number }[];
    for (const row of sourceRows) bySource[row.source] = row.count;

    const byEnvironment: Record<string, number> = {};
    const envRows = this.db.prepare('SELECT environment, COUNT(*) as count FROM change_events GROUP BY environment').all() as { environment: string; count: number }[];
    for (const row of envRows) byEnvironment[row.environment] = row.count;

    return { total, byType, bySource, byEnvironment };
  }

  close(): void {
    this.db.close();
  }

  private rowToEvent(row: Record<string, unknown>): ChangeEvent {
    return {
      id: row.id as string,
      timestamp: row.timestamp as string,
      service: row.service as string,
      additionalServices: JSON.parse((row.additional_services as string) || '[]'),
      changeType: row.change_type as ChangeEvent['changeType'],
      source: row.source as ChangeEvent['source'],
      initiator: row.initiator as ChangeEvent['initiator'],
      initiatorIdentity: row.initiator_identity as string | undefined,
      status: row.status as ChangeEvent['status'],
      environment: row.environment as string,
      commitSha: row.commit_sha as string | undefined,
      prNumber: row.pr_number as string | undefined,
      prUrl: row.pr_url as string | undefined,
      repository: row.repository as string | undefined,
      branch: row.branch as string | undefined,
      summary: row.summary as string,
      diff: row.diff as string | undefined,
      filesChanged: JSON.parse((row.files_changed as string) || '[]'),
      configKeys: JSON.parse((row.config_keys as string) || '[]'),
      previousVersion: row.previous_version as string | undefined,
      newVersion: row.new_version as string | undefined,
      blastRadius: row.blast_radius ? JSON.parse(row.blast_radius as string) : undefined,
      tags: JSON.parse((row.tags as string) || '[]'),
      metadata: JSON.parse((row.metadata as string) || '{}'),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
