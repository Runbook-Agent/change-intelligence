/**
 * OpenAPI Route — Serves the API specification
 */

import type { FastifyInstance } from 'fastify';
import { openapiSpec } from '../openapi';

export async function openapiRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/openapi.json', async (_request, reply) => {
    return reply.header('Content-Type', 'application/json').send(openapiSpec);
  });
}
