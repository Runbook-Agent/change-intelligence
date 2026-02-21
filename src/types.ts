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
export type ChangeAuthorType = 'human' | 'ai_assisted' | 'autonomous_agent';
export type TestSignal = 'passed' | 'failed' | 'partial' | 'unknown';

export interface EvidenceLink {
  type:
    | 'event'
    | 'pull_request'
    | 'commit'
    | 'deployment_run'
    | 'pipeline_run'
    | 'terraform_run'
    | 'kubernetes_rollout'
    | 'graph_path'
    | 'other';
  label: string;
  url?: string;
  source?: string;
  eventId?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
}

export interface ConfidenceBreakdown {
  overall: number;
  factors: {
    timeProximity: number;
    serviceAdjacency: number;
    changeRisk: number;
    changeType: number;
    environmentMatch: number;
  };
}

export interface ReadinessDelta {
  runbookUpdated: 'updated' | 'missing' | 'unknown';
  monitoringUpdated: 'updated' | 'missing' | 'unknown';
  ownershipKnown: 'updated' | 'missing' | 'unknown';
  notes: string[];
}

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
  authorType?: ChangeAuthorType;
  reviewModel?: string;
  humanReviewCount?: number;
  testSignal?: TestSignal;
  changeSetId?: string;
  canonicalUrl?: string;
  previousVersion?: string;
  newVersion?: string;
  blastRadius?: BlastRadiusPrediction;
  idempotencyKey?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface BlastRadiusPrediction {
  directServices: string[];
  downstreamServices: string[];
  highConfidenceDependents?: string[];
  possibleDependents?: string[];
  criticalPathAffected: boolean;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  impactPaths: {
    from: string;
    to: string;
    hops: number;
    criticality: string;
    path: string[];
    confidence?: number;
    edgeSources?: string[];
  }[];
  confidenceSummary?: {
    highConfidenceCount: number;
    possibleCount: number;
  };
  evidence?: EvidenceLink[];
  rationale: string[];
}

export interface ChangeCorrelation {
  changeEvent: ChangeEvent;
  correlationScore: number;
  correlationReasons: string[];
  whyRelevant: string[];
  serviceOverlap: string[];
  timeDeltaMinutes: number;
  confidence: ConfidenceBreakdown;
  evidence: EvidenceLink[];
}

export interface ChangeSet {
  id: string;
  key: string;
  title: string;
  summary: string;
  eventCount: number;
  eventIds: string[];
  events: ChangeEvent[];
  services: string[];
  repositories: string[];
  environment: string;
  windowStart: string;
  windowEnd: string;
  changeTypes: ChangeType[];
  initiators: ChangeInitiator[];
  authorTypes: ChangeAuthorType[];
  evidence: EvidenceLink[];
  readinessDelta: ReadinessDelta;
  confidence: number;
}

export interface TriageCandidate {
  changeSet: ChangeSet;
  score: number;
  whyRelevant: string[];
  confidence: ConfidenceBreakdown;
  evidence: EvidenceLink[];
  suggestedBlastRadius?: BlastRadiusPrediction;
}

export interface TriageResult {
  incidentTime: string;
  affectedServices: string[];
  windowMinutes: number;
  symptomTags: string[];
  topChangeSets: TriageCandidate[];
  correlations: ChangeCorrelation[];
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
  changeSetIds?: string[];
  query?: string;
  limit?: number;
}
