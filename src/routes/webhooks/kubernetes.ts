/**
 * Kubernetes Event Webhook — Receives forwarded K8s events
 *
 * NOT a K8s admission webhook. Receives events from cluster-side agents
 * (Argo CD notifications, Falco, custom operators, etc.).
 *
 * Bearer token auth via Authorization header, verified against K8S_WEBHOOK_SECRET.
 */

import type { FastifyInstance } from 'fastify';
import type { ChangeType } from '../../types';
import { z } from 'zod';
import { validationError, unauthorizedError, internalError } from '../../errors';

const K8sPayloadSchema = z.object({
  kind: z.string().min(1),
  name: z.string().min(1),
  namespace: z.string().min(1),
  action: z.string().min(1),
  cluster: z.string().optional(),
  image: z.string().optional(),
  previous_image: z.string().optional(),
  replicas: z.number().optional(),
  previous_replicas: z.number().optional(),
  reason: z.string().optional(),
  message: z.string().optional(),
  labels: z.record(z.string()).optional(),
  annotations: z.record(z.string()).optional(),
  resource_version: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function kubernetesWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/webhooks/kubernetes', async (request, reply) => {
    const secret = process.env.K8S_WEBHOOK_SECRET;

    // Verify bearer token if secret is configured
    if (secret) {
      const authHeader = request.headers.authorization as string | undefined;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return unauthorizedError(reply, 'Missing or invalid Authorization header');
      }
      const token = authHeader.slice(7);
      if (token !== secret) {
        return unauthorizedError(reply, 'Invalid token');
      }
    }

    const parsed = K8sPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const data = parsed.data;

    try {
      const changeType = mapK8sChangeType(data.kind, data.action) as ChangeType;
      const environment = inferEnvironmentFromNamespace(data.namespace);
      const newVersion = data.image ? extractImageTag(data.image) : undefined;
      const previousVersion = data.previous_image ? extractImageTag(data.previous_image) : undefined;

      const metadata: Record<string, unknown> = {
        ...data.metadata,
        kubernetes_kind: data.kind,
        kubernetes_action: data.action,
        namespace: data.namespace,
      };
      if (data.cluster) metadata.cluster = data.cluster;
      if (data.replicas !== undefined) metadata.replicas = data.replicas;
      if (data.previous_replicas !== undefined) metadata.previous_replicas = data.previous_replicas;
      if (data.labels) metadata.labels = data.labels;
      if (data.reason) metadata.reason = data.reason;
      if (data.message) metadata.message = data.message;
      if (data.resource_version) metadata.resource_version = data.resource_version;

      const event = fastify.store.insert({
        service: data.name,
        changeType,
        source: 'kubernetes',
        initiator: 'automation',
        status: 'completed',
        environment,
        newVersion,
        previousVersion,
        summary: `K8s ${data.kind} ${data.action}: ${data.name} in ${data.namespace}`,
        tags: ['kubernetes', data.kind.toLowerCase()],
        metadata,
      });

      return reply.status(201).send({ id: event.id, message: 'Event ingested' });
    } catch (error) {
      fastify.log.error(error, 'Failed to process Kubernetes webhook');
      return internalError(reply, 'Failed to process Kubernetes webhook');
    }
  });
}

function mapK8sChangeType(kind: string, action: string): string {
  if (action.toLowerCase() === 'delete') return 'rollback';

  switch (kind) {
    case 'Deployment':
    case 'StatefulSet':
    case 'DaemonSet':
    case 'Job':
    case 'CronJob':
      return 'deployment';
    case 'ConfigMap':
    case 'Secret':
      return 'config_change';
    case 'HorizontalPodAutoscaler':
      return action.toLowerCase() === 'scale' ? 'scaling' : 'config_change';
    default:
      return 'deployment';
  }
}

function inferEnvironmentFromNamespace(namespace: string): string {
  const lower = namespace.toLowerCase();
  if (lower === 'production' || lower === 'prod') return 'production';
  if (lower === 'staging' || lower === 'stag') return 'staging';
  return 'development';
}

function extractImageTag(image: string): string {
  const parts = image.split(':');
  return parts.length > 1 ? parts[parts.length - 1] : 'latest';
}
