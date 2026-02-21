/**
 * ChangeCorrelator — Correlates change events with incidents.
 *
 * Scoring model:
 * - Time proximity (35%): exponential decay, half-life ~30min
 * - Service overlap (30%): direct=1.0, 1-hop neighbor=0.7, 2-hop=0.4
 * - Change risk (15%): blast radius risk level
 * - Change type (10%): deployment=1.0, config=0.9, etc.
 * - Environment match (10%): same env=1.0, unknown=0.5, mismatch=0.2
 */

import type { ChangeCorrelation, ChangeEvent, ConfidenceBreakdown, EvidenceLink } from './types';
import type { ChangeEventStore } from './store';
import type { ServiceGraph } from './service-graph';
import { extractEventEvidence } from './provenance';

const CHANGE_TYPE_SCORES: Record<string, number> = {
  deployment: 1.0,
  config_change: 0.9,
  feature_flag: 0.8,
  db_migration: 0.85,
  infra_modification: 0.7,
  code_change: 0.65,
  rollback: 0.6,
  scaling: 0.5,
  security_patch: 0.4,
};

const RISK_SCORES: Record<string, number> = {
  critical: 1.0,
  high: 0.8,
  medium: 0.5,
  low: 0.2,
};

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function dedupeEvidence(evidence: EvidenceLink[]): EvidenceLink[] {
  const seen = new Set<string>();
  const result: EvidenceLink[] = [];

  for (const item of evidence) {
    const key = `${item.type}|${item.url || ''}|${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

export class ChangeCorrelator {
  constructor(
    private store: ChangeEventStore,
    private graph: ServiceGraph
  ) {}

  correlateWithIncident(
    affectedServices: string[],
    incidentTime: string,
    options?: {
      windowMinutes?: number;
      maxResults?: number;
      minScore?: number;
      incidentEnvironment?: string;
    }
  ): ChangeCorrelation[] {
    const windowMinutes = options?.windowMinutes ?? 120;
    const maxResults = options?.maxResults ?? 20;
    const minScore = options?.minScore ?? 0.1;
    const incidentTimestamp = new Date(incidentTime).getTime();

    // Expand affected services via graph (1-hop and 2-hop neighbors)
    const expandedServices = this.expandServices(affectedServices);

    // Get recent changes for all relevant services
    const changes = expandedServices.size === 0
      ? this.store.query({
          since: new Date(Date.now() - windowMinutes * 60_000).toISOString(),
          limit: 200,
        })
      : this.store.getRecentForServices(
          Array.from(expandedServices.keys()),
          windowMinutes
        );

    // Score each change
    const correlations: ChangeCorrelation[] = [];

    for (const change of changes) {
      const scored = this.scoreChange(
        change,
        affectedServices,
        expandedServices,
        incidentTimestamp,
        options?.incidentEnvironment
      );

      if (scored.score >= minScore) {
        correlations.push({
          changeEvent: change,
          correlationScore: round(scored.score),
          correlationReasons: unique(scored.reasons),
          whyRelevant: unique(scored.reasons),
          serviceOverlap: unique(scored.serviceOverlap),
          timeDeltaMinutes: Math.round(scored.timeDelta * 10) / 10,
          confidence: scored.confidence,
          evidence: dedupeEvidence(scored.evidence).slice(0, 20),
        });
      }
    }

    // Sort by score descending
    correlations.sort((a, b) => b.correlationScore - a.correlationScore);
    return correlations.slice(0, maxResults);
  }

  private expandServices(services: string[]): Map<string, number> {
    const expanded = new Map<string, number>();

    for (const svc of services) {
      expanded.set(svc, 0); // hop distance 0 = direct match

      // 1-hop upstream (services that depend on this one)
      const upstream = this.graph.getUpstreamImpact(svc, 1);
      for (const path of upstream) {
        if (!expanded.has(path.affected)) {
          expanded.set(path.affected, 1);
        }
      }

      // 1-hop downstream (services this one depends on)
      const downstream = this.graph.getDownstreamImpact(svc, 1);
      for (const path of downstream) {
        if (!expanded.has(path.affected)) {
          expanded.set(path.affected, 1);
        }
      }

      // 2-hop
      const upstream2 = this.graph.getUpstreamImpact(svc, 2);
      for (const path of upstream2) {
        if (!expanded.has(path.affected)) {
          expanded.set(path.affected, 2);
        }
      }

      const downstream2 = this.graph.getDownstreamImpact(svc, 2);
      for (const path of downstream2) {
        if (!expanded.has(path.affected)) {
          expanded.set(path.affected, 2);
        }
      }
    }

    return expanded;
  }

  private scoreChange(
    change: ChangeEvent,
    directServices: string[],
    expandedServices: Map<string, number>,
    incidentTimestamp: number,
    incidentEnvironment?: string
  ): {
    score: number;
    reasons: string[];
    serviceOverlap: string[];
    timeDelta: number;
    confidence: ConfidenceBreakdown;
    evidence: EvidenceLink[];
  } {
    const reasons: string[] = [];
    const serviceOverlap: string[] = [];
    const evidence: EvidenceLink[] = extractEventEvidence(change);

    // Time proximity (35%)
    const changeTimestamp = new Date(change.timestamp).getTime();
    const timeDeltaMinutes = Math.abs(incidentTimestamp - changeTimestamp) / 60_000;
    const timeScore = Math.exp(-timeDeltaMinutes / 30);
    if (timeDeltaMinutes < 15) {
      reasons.push(`Very recent change (${Math.round(timeDeltaMinutes)}min from incident)`);
    } else if (timeDeltaMinutes < 60) {
      reasons.push(`Recent change (${Math.round(timeDeltaMinutes)}min from incident)`);
    }

    // Service overlap (30%)
    let serviceScore = 0;
    const allChangeServices = [change.service, ...(change.additionalServices || [])];

    for (const svc of allChangeServices) {
      if (directServices.includes(svc)) {
        serviceScore = Math.max(serviceScore, 1.0);
        serviceOverlap.push(svc);
        reasons.push(`Direct service match: ${svc}`);
      } else {
        const hops = expandedServices.get(svc);
        if (hops === 1) {
          serviceScore = Math.max(serviceScore, 0.7);
          serviceOverlap.push(svc);
          reasons.push(`1-hop graph neighbor: ${svc}`);
        } else if (hops === 2) {
          serviceScore = Math.max(serviceScore, 0.4);
          serviceOverlap.push(svc);
          reasons.push(`2-hop graph neighbor: ${svc}`);
        }

        if (hops !== undefined && hops > 0) {
          const path = this.findShortestPath(directServices, svc);
          if (path) {
            evidence.push({
              type: 'graph_path',
              label: `Graph adjacency path (${path.length - 1} hop): ${path.join(' -> ')}`,
              source: 'service_graph',
              eventId: change.id,
              details: {
                path,
                hops: path.length - 1,
              },
            });
          }
        }
      }
    }

    // Change risk (15%)
    const riskLevel = change.blastRadius?.riskLevel || 'low';
    const riskScore = RISK_SCORES[riskLevel] || 0.2;
    if (riskLevel === 'critical' || riskLevel === 'high') {
      reasons.push(`${riskLevel} blast-radius risk`);
    }

    // Change type (10%)
    const typeScore = CHANGE_TYPE_SCORES[change.changeType] || 0.5;
    if (change.changeType === 'deployment' || change.changeType === 'config_change') {
      reasons.push(`High-impact change type: ${change.changeType}`);
    }

    // Environment match (10%)
    const environmentScore = this.getEnvironmentScore(
      change.environment,
      incidentEnvironment,
      reasons
    );

    // Weighted sum
    const score =
      timeScore * 0.35 +
      serviceScore * 0.30 +
      riskScore * 0.15 +
      typeScore * 0.10 +
      environmentScore * 0.10;

    return {
      score,
      reasons,
      serviceOverlap,
      timeDelta: timeDeltaMinutes,
      confidence: {
        overall: round(score),
        factors: {
          timeProximity: round(timeScore),
          serviceAdjacency: round(serviceScore),
          changeRisk: round(riskScore),
          changeType: round(typeScore),
          environmentMatch: round(environmentScore),
        },
      },
      evidence,
    };
  }

  private getEnvironmentScore(
    eventEnvironment: string,
    incidentEnvironment: string | undefined,
    reasons: string[]
  ): number {
    if (!incidentEnvironment) return 0.5;

    if (eventEnvironment === incidentEnvironment) {
      reasons.push(`Environment match: ${eventEnvironment}`);
      return 1;
    }

    reasons.push(`Environment mismatch (event=${eventEnvironment}, incident=${incidentEnvironment})`);
    return 0.2;
  }

  private findShortestPath(startServices: string[], target: string): string[] | null {
    let bestPath: string[] | null = null;

    for (const start of startServices) {
      const directPath = this.graph.findPath(start, target);
      if (directPath && (!bestPath || directPath.length < bestPath.length)) {
        bestPath = directPath;
      }

      const reversePath = this.graph.findPath(target, start);
      if (reversePath && (!bestPath || reversePath.length < bestPath.length)) {
        bestPath = reversePath;
      }
    }

    return bestPath;
  }
}
