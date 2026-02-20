/**
 * WebhookDispatcher — Dispatches events to registered webhook URLs
 */

import { createHmac } from 'crypto';
import type { ChangeEvent } from './types';
import type { WebhookRegistrationStore, WebhookRegistration } from './webhook-store';

export class WebhookDispatcher {
  private store: WebhookRegistrationStore;

  constructor(store: WebhookRegistrationStore) {
    this.store = store;
  }

  dispatch(event: ChangeEvent, logger?: { error: (...args: unknown[]) => void }): void {
    setImmediate(() => {
      this.deliverToAll(event, logger);
    });
  }

  private async deliverToAll(event: ChangeEvent, logger?: { error: (...args: unknown[]) => void }): Promise<void> {
    let registrations;
    try {
      registrations = this.store.getActive();
    } catch {
      // Store may be closed during shutdown; silently skip
      return;
    }

    for (const reg of registrations) {
      if (!this.matchesFilters(event, reg)) continue;

      try {
        await this.deliver(event, reg);
      } catch (error) {
        if (logger) {
          logger.error({ error, webhookId: reg.id, url: reg.url }, 'Webhook delivery failed');
        }
      }
    }
  }

  private matchesFilters(event: ChangeEvent, reg: WebhookRegistration): boolean {
    if (reg.services.length > 0 && !reg.services.includes(event.service)) return false;
    if (reg.changeTypes.length > 0 && !reg.changeTypes.includes(event.changeType)) return false;
    if (reg.environments.length > 0 && !reg.environments.includes(event.environment)) return false;
    return true;
  }

  private async deliver(event: ChangeEvent, reg: WebhookRegistration): Promise<void> {
    const body = JSON.stringify({ event, timestamp: new Date().toISOString() });

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (reg.secret) {
      const signature = createHmac('sha256', reg.secret).update(body).digest('hex');
      headers['X-Webhook-Signature'] = `sha256=${signature}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      await fetch(reg.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
