/**
 * Triage Route — One-call incident triage.
 *
 * Returns top change sets with evidence, why-relevant factors, and
 * suggested blast radius previews.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { validationError } from '../errors';
import { rankChangeSetsForIncident } from '../change-sets';

const TriageSchema = z.object({
  incident_time: z.string().optional(),
  incident_environment: z.string().optional(),
  window_minutes: z.number().int().min(1).max(1440).optional(),
  suspected_services: z.array(z.string()).optional(),
  symptom_tags: z.array(z.string()).optional(),
  max_change_sets: z.number().int().min(1).max(20).optional(),
});

function deriveAffectedServices(
  recentEvents: import('../types').ChangeEvent[],
  limit: number = 5
): string[] {
  const counts = new Map<string, number>();
  for (const event of recentEvents) {
    const services = [event.service, ...(event.additionalServices || [])];
    for (const service of services) {
      counts.set(service, (counts.get(service) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([service]) => service);
}

export async function triageRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/triage', async (request, reply) => {
    const parsed = TriageSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, parsed.error.issues);
    }

    const incidentTime = parsed.data.incident_time || new Date().toISOString();
    const windowMinutes = parsed.data.window_minutes || 120;
    const symptomTags = parsed.data.symptom_tags || [];
    const maxChangeSets = parsed.data.max_change_sets || 3;

    const since = new Date(new Date(incidentTime).getTime() - windowMinutes * 60_000).toISOString();
    const recentEvents = fastify.store.query({ since, until: incidentTime, limit: 250 });
    const affectedServices = parsed.data.suspected_services && parsed.data.suspected_services.length > 0
      ? parsed.data.suspected_services
      : deriveAffectedServices(recentEvents);

    const correlations = fastify.correlator.correlateWithIncident(
      affectedServices,
      incidentTime,
      {
        windowMinutes,
        maxResults: 250,
        minScore: 0.05,
        incidentEnvironment: parsed.data.incident_environment,
      }
    );

    const topChangeSets = rankChangeSetsForIncident(
      correlations,
      fastify.serviceGraph,
      fastify.blastRadiusAnalyzer,
      { maxResults: maxChangeSets }
    );

    return reply.send({
      incidentTime,
      affectedServices,
      windowMinutes,
      symptomTags,
      topChangeSets,
      correlations: correlations.slice(0, 20),
    });
  });
}
