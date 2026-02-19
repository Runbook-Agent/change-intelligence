/**
 * BlastRadiusAnalyzer — Predicts impact of changes using the service graph
 *
 * Risk levels:
 * - critical: any critical impact path
 * - high: >10 downstream OR >3 direct dependents
 * - medium: >3 downstream OR >1 direct dependent
 * - low: otherwise
 */

import type { BlastRadiusPrediction } from './types';
import type { ServiceGraph, ImpactPath } from './service-graph';

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
    const allImpactPaths: ImpactPath[] = [];
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

        if (path.criticality === 'critical') {
          criticalPathAffected = true;
        }

        allImpactPaths.push(path);
      }
    }

    // Remove targets from downstream
    for (const svc of targetServices) {
      directServices.delete(svc);
      downstreamServices.delete(svc);
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
      criticalPathAffected,
      riskLevel,
      changeType
    );

    const impactPaths = allImpactPaths.map(p => ({
      from: p.source,
      to: p.affected,
      hops: p.hops,
      criticality: p.criticality,
      path: p.path,
    }));

    return {
      directServices: Array.from(directServices),
      downstreamServices: Array.from(downstreamServices),
      criticalPathAffected,
      riskLevel,
      impactPaths,
      rationale,
    };
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
