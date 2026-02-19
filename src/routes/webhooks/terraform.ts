/**
 * Terraform Cloud Webhook — Receives run notification events
 *
 * Verifies HMAC-SHA512 via X-TFE-Notification-Signature header against TERRAFORM_WEBHOOK_SECRET.
 */

import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';

export async function terraformWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/webhooks/terraform', async (request, reply) => {
    const secret = process.env.TERRAFORM_WEBHOOK_SECRET;

    // Verify HMAC signature if secret is configured
    if (secret) {
      const signature = request.headers['x-tfe-notification-signature'] as string | undefined;
      if (!signature) {
        return reply.status(401).send({ error: 'Missing signature' });
      }

      const body = JSON.stringify(request.body);
      const expected = createHmac('sha512', secret).update(body).digest('hex');

      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return reply.status(401).send({ error: 'Invalid signature' });
      }
    }

    const payload = request.body as Record<string, unknown>;

    try {
      const notifications = (payload.notifications as Record<string, unknown>[]) || [];

      if (notifications.length === 0) {
        return reply.send({ message: 'No notifications in payload' });
      }

      const notification = notifications[0];
      const event = parseTerraformNotification(notification, payload);

      if (event) {
        const stored = fastify.store.insert(event as any);
        return reply.status(201).send({ id: stored.id, message: 'Event ingested' });
      }

      return reply.send({ message: 'Ignored notification' });
    } catch (error) {
      fastify.log.error(error, 'Failed to process Terraform webhook');
      return reply.status(500).send({ error: 'Failed to process webhook' });
    }
  });
}

function parseTerraformNotification(
  notification: Record<string, unknown>,
  payload: Record<string, unknown>
): Record<string, unknown> {
  const trigger = notification.trigger as string || '';
  const runStatus = notification.run_status as string || '';
  const workspaceName = (payload.workspace_name as string) || 'unknown';
  const runCreatedBy = payload.run_created_by as string | undefined;

  const status = mapTerraformStatus(trigger, runStatus);
  const environment = inferEnvironmentFromWorkspace(workspaceName);

  const metadata: Record<string, unknown> = {
    terraform_trigger: trigger,
    run_status: runStatus,
  };
  if (payload.run_id) metadata.run_id = payload.run_id;
  if (payload.run_url) metadata.run_url = payload.run_url;
  if (payload.organization_name) metadata.organization_name = payload.organization_name;

  return {
    service: workspaceName,
    changeType: 'infra_modification',
    source: 'terraform',
    initiator: runCreatedBy ? 'human' : 'automation',
    initiatorIdentity: runCreatedBy || undefined,
    status,
    environment,
    summary: `Terraform run on ${workspaceName}: ${trigger} (${runStatus})`,
    metadata,
  };
}

function mapTerraformStatus(trigger: string, _runStatus: string): string {
  switch (trigger) {
    case 'run:completed':
      return 'completed';
    case 'run:errored':
      return 'failed';
    default:
      return 'in_progress';
  }
}

function inferEnvironmentFromWorkspace(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('prod')) return 'production';
  if (lower.includes('stag')) return 'staging';
  if (lower.includes('dev')) return 'development';
  return 'production';
}
