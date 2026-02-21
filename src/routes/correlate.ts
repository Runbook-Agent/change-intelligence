/**
 * Correlation Route — Correlate changes with incidents
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError } from '../errors';
import { rankChangeSetsForIncident } from '../change-sets';

const CorrelateSchema = z.object({
  affected_services: z.array(z.string()).min(1),
  incident_time: z.string().optional(),
  incident_environment: z.string().optional(),
  window_minutes: z.number().optional(),
  max_results: z.number().optional(),
  min_score: z.number().optional(),
  include_change_sets: z.boolean().optional(),
});

export async function correlateRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/correlate', async (request, reply) => {
    const parsed = CorrelateSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const {
      affected_services,
      incident_time,
      incident_environment,
      window_minutes,
      max_results,
      min_score,
      include_change_sets,
    } = parsed.data;
    const incidentTime = incident_time || new Date().toISOString();

    const correlations = fastify.correlator.correlateWithIncident(
      affected_services,
      incidentTime,
      {
        windowMinutes: window_minutes,
        maxResults: max_results,
        minScore: min_score,
        incidentEnvironment: incident_environment,
      }
    );

    const changeSets = include_change_sets === false
      ? []
      : rankChangeSetsForIncident(
          correlations,
          fastify.serviceGraph,
          fastify.blastRadiusAnalyzer,
          { maxResults: 5 }
        );

    return reply.send({
      correlations,
      changeSets,
      change_sets: changeSets,
      query: {
        affectedServices: affected_services,
        incidentTime,
        incidentEnvironment: incident_environment,
        windowMinutes: window_minutes || 120,
      },
    });
  });
}
