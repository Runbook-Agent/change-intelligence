/**
 * WebhookRegistrationStore — Manages webhook registration persistence
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface WebhookRegistration {
  id: string;
  url: string;
  secret?: string;
  services: string[];
  changeTypes: string[];
  environments: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export class WebhookRegistrationStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_registrations (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        secret TEXT,
        services TEXT DEFAULT '[]',
        change_types TEXT DEFAULT '[]',
        environments TEXT DEFAULT '[]',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
  }

  create(registration: {
    url: string;
    secret?: string;
    services?: string[];
    changeTypes?: string[];
    environments?: string[];
  }): WebhookRegistration {
    const now = new Date().toISOString();
    const id = randomUUID();

    const record: WebhookRegistration = {
      id,
      url: registration.url,
      secret: registration.secret,
      services: registration.services || [],
      changeTypes: registration.changeTypes || [],
      environments: registration.environments || [],
      active: true,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(`
      INSERT INTO webhook_registrations
      (id, url, secret, services, change_types, environments, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.url,
      record.secret || null,
      JSON.stringify(record.services),
      JSON.stringify(record.changeTypes),
      JSON.stringify(record.environments),
      record.active ? 1 : 0,
      record.createdAt,
      record.updatedAt,
    );

    return record;
  }

  list(): WebhookRegistration[] {
    const rows = this.db.prepare('SELECT * FROM webhook_registrations ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToRegistration(row));
  }

  get(id: string): WebhookRegistration | null {
    const row = this.db.prepare('SELECT * FROM webhook_registrations WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToRegistration(row);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM webhook_registrations WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getActive(): WebhookRegistration[] {
    const rows = this.db.prepare('SELECT * FROM webhook_registrations WHERE active = 1').all() as Record<string, unknown>[];
    return rows.map(row => this.rowToRegistration(row));
  }

  private rowToRegistration(row: Record<string, unknown>): WebhookRegistration {
    return {
      id: row.id as string,
      url: row.url as string,
      secret: row.secret as string | undefined,
      services: JSON.parse((row.services as string) || '[]'),
      changeTypes: JSON.parse((row.change_types as string) || '[]'),
      environments: JSON.parse((row.environments as string) || '[]'),
      active: (row.active as number) === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
