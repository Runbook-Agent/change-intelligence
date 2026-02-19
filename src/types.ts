/**
 * Change Intelligence Service — Domain Types
 *
 * Canonical source of truth for all change event types.
 */

export type ChangeType =
  | 'deployment'
  | 'config_change'
  | 'infra_modification'
  | 'feature_flag'
  | 'db_migration'
  | 'code_change'
  | 'rollback'
  | 'scaling'
  | 'security_patch';

export type ChangeSource =
  | 'github'
  | 'gitlab'
  | 'aws_codepipeline'
  | 'aws_ecs'
  | 'aws_lambda'
  | 'kubernetes'
  | 'claude_hook'
  | 'agent_hook'
  | 'manual'
  | 'terraform';

export type ChangeInitiator = 'human' | 'agent' | 'automation' | 'unknown';
export type ChangeStatus = 'in_progress' | 'completed' | 'failed' | 'rolled_back';

export interface ChangeEvent {
  id: string;
  timestamp: string;
  service: string;
  additionalServices: string[];
  changeType: ChangeType;
  source: ChangeSource;
  initiator: ChangeInitiator;
  initiatorIdentity?: string;
  status: ChangeStatus;
  environment: string;
  commitSha?: string;
  prNumber?: string;
  prUrl?: string;
  repository?: string;
  branch?: string;
  summary: string;
  diff?: string;
  filesChanged?: string[];
  configKeys?: string[];
  previousVersion?: string;
  newVersion?: string;
  blastRadius?: BlastRadiusPrediction;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BlastRadiusPrediction {
  directServices: string[];
  downstreamServices: string[];
  criticalPathAffected: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  impactPaths: {
    from: string;
    to: string;
    hops: number;
    criticality: string;
    path: string[];
  }[];
  rationale: string[];
}

export interface ChangeCorrelation {
  changeEvent: ChangeEvent;
  correlationScore: number;
  correlationReasons: string[];
  serviceOverlap: string[];
  timeDeltaMinutes: number;
}

export interface ChangeVelocityMetric {
  service: string;
  windowStart: string;
  windowEnd: string;
  changeCount: number;
  changeTypes: Partial<Record<ChangeType, number>>;
  averageIntervalMinutes: number;
}

export interface ChangeQueryOptions {
  services?: string[];
  changeTypes?: ChangeType[];
  sources?: ChangeSource[];
  environment?: string;
  since?: string;
  until?: string;
  initiator?: ChangeInitiator;
  status?: ChangeStatus;
  query?: string;
  limit?: number;
}
