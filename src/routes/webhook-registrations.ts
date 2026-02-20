/**
 * Webhook Registration Routes — CRUD for webhook subscriptions
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError, notFoundError } from '../errors';

const RegisterWebhookSchema = z.object({
  url: z.string().url(),
  secret: z.string().optional(),
  services: z.array(z.string()).optional(),
  changeTypes: z.array(z.string()).optional(),
  environments: z.array(z.string()).optional(),
});

export async function webhookRegistrationRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/webhooks/register — Register a webhook
  fastify.post('/api/v1/webhooks/register', async (request, reply) => {
    const parsed = RegisterWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const registration = fastify.webhookRegistrationStore.create(parsed.data);
    return reply.status(201).send(registration);
  });

  // GET /api/v1/webhooks/registrations — List all registrations
  fastify.get('/api/v1/webhooks/registrations', async (_request, reply) => {
    const registrations = fastify.webhookRegistrationStore.list();
    return reply.send({ registrations });
  });

  // DELETE /api/v1/webhooks/registrations/:id — Remove a registration
  fastify.delete('/api/v1/webhooks/registrations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = fastify.webhookRegistrationStore.delete(id);
    if (!deleted) {
      return notFoundError(reply, 'Webhook registration', id);
    }
    return reply.status(204).send();
  });
}
