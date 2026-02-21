/**
 * BlastRadiusAnalyzer — Predicts impact of changes using the service graph.
 *
 * Risk levels:
 * - critical: any critical impact path
 * - high: >10 downstream OR >3 direct dependents
 * - medium: >3 downstream OR >1 direct dependent
 * - low: otherwise
 */

import type { BlastRadiusPrediction, EvidenceLink } from './types';
import type { ServiceGraph, ImpactPath } from './service-graph';

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function dedupeEvidence(evidence: EvidenceLink[]): EvidenceLink[] {
  const seen = new Set<string>();
  const result: EvidenceLink[] = [];

  for (const item of evidence) {
    const key = `${item.type}|${item.label}|${item.url || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

export class BlastRadiusAnalyzer {
  constructor(private graph: ServiceGraph) {}

  predict(
    targetServices: string[],
    changeType?: string,
    options?: { maxDepth?: number }
  ): BlastRadiusPrediction {
    const maxDepth = options?.maxDepth ?? 3;
    const directServices = new Set<string>();
    const downstreamServices = new Set<string>();
    const highConfidenceDependents = new Set<string>();
    const possibleDependents = new Set<string>();
    const allImpactPaths: ImpactPath[] = [];
    const evidence: EvidenceLink[] = [];
    let criticalPathAffected = false;

    for (const service of targetServices) {
      // Get upstream impact — services that depend on the target
      const upstreamPaths = this.graph.getUpstreamImpact(service, maxDepth);

      for (const path of upstreamPaths) {
        // hops includes the source node, so 1-edge hop = hops of 2
        if (path.hops <= 2) {
          directServices.add(path.affected);
        } else {
          downstreamServices.add(path.affected);
        }

        if (this.isHighConfidencePath(path)) {
          highConfidenceDependents.add(path.affected);
        } else {
          possibleDependents.add(path.affected);
        }

        if (path.criticality === 'critical') {
          criticalPathAffected = true;
        }

        evidence.push({
          type: 'graph_path',
          label: `Impact path ${path.path.join(' -> ')}`,
          source: 'service_graph',
          details: {
            from: path.source,
            to: path.affected,
            hops: path.hops - 1,
            criticality: path.criticality,
            confidence: path.confidence,
            edgeSources: path.edgeSources,
          },
        });

        allImpactPaths.push(path);
      }
    }

    // Remove targets from all dependent buckets
    for (const svc of targetServices) {
      directServices.delete(svc);
      downstreamServices.delete(svc);
      highConfidenceDependents.delete(svc);
      possibleDependents.delete(svc);
    }
    // Remove direct services from downstream to avoid double counting
    for (const svc of directServices) {
      downstreamServices.delete(svc);
    }

    const riskLevel = this.computeRiskLevel(
      directServices.size,
      downstreamServices.size,
      criticalPathAffected,
      changeType
    );

    const rationale = this.buildRationale(
      targetServices,
      directServices,
      downstreamServices,
      highConfidenceDependents,
      possibleDependents,
      criticalPathAffected,
      riskLevel,
      changeType
    );

    const impactPaths = allImpactPaths.map(p => ({
      from: p.source,
      to: p.affected,
      hops: p.hops,
      criticality: p.criticality,
      confidence: p.confidence,
      edgeSources: p.edgeSources,
      path: p.path,
    }));

    return {
      directServices: Array.from(directServices),
      downstreamServices: Array.from(downstreamServices),
      highConfidenceDependents: Array.from(highConfidenceDependents),
      possibleDependents: Array.from(possibleDependents),
      criticalPathAffected,
      riskLevel,
      impactPaths,
      confidenceSummary: {
        highConfidenceCount: highConfidenceDependents.size,
        possibleCount: possibleDependents.size,
      },
      evidence: dedupeEvidence(evidence).slice(0, 40),
      rationale,
    };
  }

  private isHighConfidencePath(path: ImpactPath): boolean {
    if (path.confidence < 0.75) return false;
    // Treat inferred edges as uncertain unless confidence is very high
    if (path.edgeSources.includes('inferred') && path.confidence < 0.9) return false;
    return true;
  }

  private computeRiskLevel(
    directCount: number,
    downstreamCount: number,
    criticalPath: boolean,
    changeType?: string
  ): 'low' | 'medium' | 'high' | 'critical' {
    if (criticalPath) return 'critical';
    if (downstreamCount > 10 || directCount > 3) return 'high';
    if (downstreamCount > 3 || directCount > 1) return 'medium';

    // Some change types are inherently riskier
    if (changeType === 'db_migration' && directCount > 0) return 'medium';

    return 'low';
  }

  private buildRationale(
    targets: string[],
    direct: Set<string>,
    downstream: Set<string>,
    highConfidenceDependents: Set<string>,
    possibleDependents: Set<string>,
    criticalPath: boolean,
    riskLevel: string,
    changeType?: string
  ): string[] {
    const rationale: string[] = [];

    rationale.push(
      `Change targets ${targets.length} service(s): ${targets.join(', ')}`
    );

    if (direct.size > 0) {
      rationale.push(
        `${direct.size} direct dependent(s): ${Array.from(direct).join(', ')}`
      );
    }

    if (downstream.size > 0) {
      rationale.push(
        `${downstream.size} downstream service(s) in the impact path`
      );
    }

    if (highConfidenceDependents.size > 0) {
      rationale.push(
        `${highConfidenceDependents.size} high-confidence dependent(s): ${dedupe(Array.from(highConfidenceDependents)).join(', ')}`
      );
    }

    if (possibleDependents.size > 0) {
      rationale.push(
        `${possibleDependents.size} possible dependent(s) via uncertain edges`
      );
    }

    if (criticalPath) {
      rationale.push('At least one critical dependency path is affected');
    }

    if (direct.size === 0 && downstream.size === 0) {
      rationale.push('No known dependents in the service graph — isolated change');
    }

    if (changeType) {
      rationale.push(`Change type: ${changeType}`);
    }

    rationale.push(`Overall risk level: ${riskLevel}`);

    return rationale;
  }
}
