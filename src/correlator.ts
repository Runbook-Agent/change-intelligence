/**
 * ChangeCorrelator — Correlates change events with incidents
 *
 * Scoring model:
 * - Time proximity (40%): exponential decay, half-life ~30min
 * - Service overlap (35%): direct=1.0, 1-hop neighbor=0.7, 2-hop=0.4
 * - Change risk (15%): blast radius risk level
 * - Change type (10%): deployment=1.0, config=0.9, etc.
 */

import type { ChangeCorrelation, ChangeEvent } from './types';
import type { ChangeEventStore } from './store';
import type { ServiceGraph } from './service-graph';

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
    }
  ): ChangeCorrelation[] {
    const windowMinutes = options?.windowMinutes ?? 120;
    const maxResults = options?.maxResults ?? 20;
    const minScore = options?.minScore ?? 0.1;
    const incidentTimestamp = new Date(incidentTime).getTime();

    // Expand affected services via graph (1-hop and 2-hop neighbors)
    const expandedServices = this.expandServices(affectedServices);

    // Get recent changes for all relevant services
    const changes = this.store.getRecentForServices(
      Array.from(expandedServices.keys()),
      windowMinutes
    );

    // Score each change
    const correlations: ChangeCorrelation[] = [];

    for (const change of changes) {
      const { score, reasons, serviceOverlap, timeDelta } = this.scoreChange(
        change,
        affectedServices,
        expandedServices,
        incidentTimestamp
      );

      if (score >= minScore) {
        correlations.push({
          changeEvent: change,
          correlationScore: Math.round(score * 1000) / 1000,
          correlationReasons: reasons,
          serviceOverlap,
          timeDeltaMinutes: Math.round(timeDelta * 10) / 10,
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
    incidentTimestamp: number
  ): {
    score: number;
    reasons: string[];
    serviceOverlap: string[];
    timeDelta: number;
  } {
    const reasons: string[] = [];
    const serviceOverlap: string[] = [];

    // Time proximity (40%)
    const changeTimestamp = new Date(change.timestamp).getTime();
    const timeDeltaMinutes = Math.abs(incidentTimestamp - changeTimestamp) / 60_000;
    const timeScore = Math.exp(-timeDeltaMinutes / 30);
    if (timeDeltaMinutes < 15) {
      reasons.push(`Very recent change (${Math.round(timeDeltaMinutes)}min ago)`);
    } else if (timeDeltaMinutes < 60) {
      reasons.push(`Recent change (${Math.round(timeDeltaMinutes)}min ago)`);
    }

    // Service overlap (35%)
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
      }
    }

    // Change risk (15%)
    const riskLevel = change.blastRadius?.riskLevel || 'low';
    const riskScore = RISK_SCORES[riskLevel] || 0.2;
    if (riskLevel === 'critical' || riskLevel === 'high') {
      reasons.push(`${riskLevel} risk change`);
    }

    // Change type (10%)
    const typeScore = CHANGE_TYPE_SCORES[change.changeType] || 0.5;
    if (change.changeType === 'deployment' || change.changeType === 'config_change') {
      reasons.push(`High-impact change type: ${change.changeType}`);
    }

    // Weighted sum
    const score =
      timeScore * 0.4 +
      serviceScore * 0.35 +
      riskScore * 0.15 +
      typeScore * 0.1;

    return { score, reasons, serviceOverlap, timeDelta: timeDeltaMinutes };
  }
}
