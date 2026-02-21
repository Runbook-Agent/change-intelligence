import type {
  ChangeAuthorType,
  ChangeCorrelation,
  ChangeEvent,
  ChangeSet,
  ConfidenceBreakdown,
  EvidenceLink,
  ReadinessDelta,
  TriageCandidate,
} from './types';
import type { ServiceGraph } from './service-graph';
import type { BlastRadiusAnalyzer } from './blast-radius';
import { extractEventEvidence } from './provenance';

const RUNBOOK_PATTERN = /(runbook|playbook|docs\/runbooks?|oncall)/i;
const MONITORING_PATTERN = /(alert|monitor|grafana|dashboard|prometheus|slo|sl[io])/i;

function toUniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function toIso(value: string): string {
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? new Date(0).toISOString() : new Date(ts).toISOString();
}

function hashKey(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getMetadataString(event: ChangeEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function inferAuthorType(event: ChangeEvent): ChangeAuthorType {
  if (event.authorType) return event.authorType;
  if (event.initiator === 'agent') return 'autonomous_agent';
  if (event.initiator === 'human') return 'human';
  return 'ai_assisted';
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

function deriveChangeSetKey(
  event: ChangeEvent,
  bucketMinutes: number
): { key: string; titleHint: string; confidence: number } {
  if (event.changeSetId) {
    return {
      key: `explicit:${event.changeSetId}`,
      titleHint: `Change set ${event.changeSetId}`,
      confidence: 1,
    };
  }

  for (const metaKey of [
    'pipeline_id',
    'pipeline_run_id',
    'workflow_run_id',
    'run_id',
    'deployment_id',
    'session_id',
    'parent_event_id',
  ]) {
    const metaValue = getMetadataString(event, metaKey);
    if (metaValue) {
      return {
        key: `run:${event.source}:${metaValue}`,
        titleHint: `${event.source} run ${metaValue}`,
        confidence: 0.92,
      };
    }
  }

  if (event.prNumber && event.repository) {
    return {
      key: `pr:${event.repository}:${event.prNumber}`,
      titleHint: `PR ${event.prNumber}`,
      confidence: 0.9,
    };
  }

  if (event.commitSha && event.repository) {
    return {
      key: `commit:${event.repository}:${event.commitSha}`,
      titleHint: `Commit ${event.commitSha.slice(0, 8)}`,
      confidence: 0.86,
    };
  }

  const ts = new Date(event.timestamp).getTime();
  const bucket = Number.isNaN(ts) ? 0 : Math.floor(ts / (bucketMinutes * 60_000));
  const scope = event.repository || event.service;
  return {
    key: `bucket:${event.environment}:${scope}:${bucket}`,
    titleHint: `${scope} ${bucketMinutes}m batch`,
    confidence: 0.62,
  };
}

function computeReadinessDelta(events: ChangeEvent[], services: string[], graph: ServiceGraph): ReadinessDelta {
  const filePaths = events.flatMap(e => e.filesChanged || []);
  const hasFileSignals = filePaths.length > 0;

  const runbookUpdated = !hasFileSignals
    ? 'unknown'
    : filePaths.some(path => RUNBOOK_PATTERN.test(path))
      ? 'updated'
      : 'missing';

  const monitoringUpdated = !hasFileSignals
    ? 'unknown'
    : filePaths.some(path => MONITORING_PATTERN.test(path))
      ? 'updated'
      : 'missing';

  const ownershipKnown = services.length === 0
    ? 'unknown'
    : services.every(service => {
      const node = graph.getService(service);
      return Boolean(node?.team || node?.owner);
    })
      ? 'updated'
      : 'missing';

  const notes: string[] = [];
  if (runbookUpdated === 'missing') notes.push('No runbook/playbook updates detected');
  if (monitoringUpdated === 'missing') notes.push('No monitoring or alerting config updates detected');
  if (ownershipKnown === 'missing') notes.push('One or more touched services are missing owner/team metadata');

  return { runbookUpdated, monitoringUpdated, ownershipKnown, notes };
}

export function groupEventsIntoChangeSets(
  events: ChangeEvent[],
  graph: ServiceGraph,
  options?: { bucketMinutes?: number }
): ChangeSet[] {
  const bucketMinutes = options?.bucketMinutes ?? 15;
  const grouped = new Map<
    string,
    { events: ChangeEvent[]; titleHint: string; confidence: number; key: string }
  >();

  for (const event of events) {
    const grouping = deriveChangeSetKey(event, bucketMinutes);
    const existing = grouped.get(grouping.key);
    if (existing) {
      existing.events.push(event);
      existing.confidence = Math.max(existing.confidence, grouping.confidence);
      continue;
    }

    grouped.set(grouping.key, {
      key: grouping.key,
      events: [event],
      titleHint: grouping.titleHint,
      confidence: grouping.confidence,
    });
  }

  const changeSets: ChangeSet[] = [];

  for (const group of grouped.values()) {
    const sortedEvents = [...group.events].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const services = toUniqueSorted(
      sortedEvents.flatMap(event => [event.service, ...(event.additionalServices || [])])
    );
    const repositories = toUniqueSorted(
      sortedEvents
        .map(event => event.repository)
        .filter((value): value is string => Boolean(value))
    );
    const changeTypes = toUniqueSorted(sortedEvents.map(event => event.changeType)) as ChangeSet['changeTypes'];
    const initiators = toUniqueSorted(sortedEvents.map(event => event.initiator)) as ChangeSet['initiators'];
    const authorTypes = toUniqueSorted(sortedEvents.map(inferAuthorType)) as ChangeSet['authorTypes'];
    const environments = toUniqueSorted(sortedEvents.map(event => event.environment));

    const evidence = dedupeEvidence(
      sortedEvents.flatMap(event => extractEventEvidence(event))
    ).slice(0, 25);

    const readinessDelta = computeReadinessDelta(sortedEvents, services, graph);
    const first = sortedEvents[0];
    const last = sortedEvents[sortedEvents.length - 1];
    const id = first.changeSetId || `cs_${hashKey(group.key)}`;

    changeSets.push({
      id,
      key: group.key,
      title: group.titleHint,
      summary:
        sortedEvents.length === 1
          ? sortedEvents[0].summary
          : `${sortedEvents.length} related changes across ${services.length} service(s)`,
      eventCount: sortedEvents.length,
      eventIds: sortedEvents.map(event => event.id),
      events: sortedEvents,
      services,
      repositories,
      environment: environments.length === 1 ? environments[0] : 'mixed',
      windowStart: toIso(first.timestamp),
      windowEnd: toIso(last.timestamp),
      changeTypes,
      initiators,
      authorTypes,
      evidence,
      readinessDelta,
      confidence: Math.round(group.confidence * 1000) / 1000,
    });
  }

  return changeSets.sort(
    (a, b) => new Date(b.windowEnd).getTime() - new Date(a.windowEnd).getTime()
  );
}

function aggregateConfidence(correlations: ChangeCorrelation[], score: number): ConfidenceBreakdown {
  if (correlations.length === 0) {
    const fallback = Math.max(0, Math.min(1, score));
    return {
      overall: fallback,
      factors: {
        timeProximity: fallback,
        serviceAdjacency: fallback,
        changeRisk: fallback,
        changeType: fallback,
        environmentMatch: fallback,
      },
    };
  }

  const totals = {
    timeProximity: 0,
    serviceAdjacency: 0,
    changeRisk: 0,
    changeType: 0,
    environmentMatch: 0,
  };

  for (const correlation of correlations) {
    totals.timeProximity += correlation.confidence.factors.timeProximity;
    totals.serviceAdjacency += correlation.confidence.factors.serviceAdjacency;
    totals.changeRisk += correlation.confidence.factors.changeRisk;
    totals.changeType += correlation.confidence.factors.changeType;
    totals.environmentMatch += correlation.confidence.factors.environmentMatch;
  }

  const count = correlations.length;
  return {
    overall: Math.round(score * 1000) / 1000,
    factors: {
      timeProximity: Math.round((totals.timeProximity / count) * 1000) / 1000,
      serviceAdjacency: Math.round((totals.serviceAdjacency / count) * 1000) / 1000,
      changeRisk: Math.round((totals.changeRisk / count) * 1000) / 1000,
      changeType: Math.round((totals.changeType / count) * 1000) / 1000,
      environmentMatch: Math.round((totals.environmentMatch / count) * 1000) / 1000,
    },
  };
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function dominantChangeType(changeSet: ChangeSet): string | undefined {
  const counts = new Map<string, number>();
  for (const event of changeSet.events) {
    counts.set(event.changeType, (counts.get(event.changeType) || 0) + 1);
  }

  let winner: string | undefined;
  let max = 0;
  for (const [changeType, count] of counts.entries()) {
    if (count > max) {
      max = count;
      winner = changeType;
    }
  }

  return winner;
}

export function rankChangeSetsForIncident(
  correlations: ChangeCorrelation[],
  graph: ServiceGraph,
  blastRadiusAnalyzer?: BlastRadiusAnalyzer,
  options?: { maxResults?: number; bucketMinutes?: number }
): TriageCandidate[] {
  const maxResults = options?.maxResults ?? 3;
  const changeSets = groupEventsIntoChangeSets(
    correlations.map(c => c.changeEvent),
    graph,
    { bucketMinutes: options?.bucketMinutes }
  );
  const correlationByEventId = new Map(correlations.map(c => [c.changeEvent.id, c]));

  const candidates = changeSets.map(changeSet => {
    const related = changeSet.eventIds
      .map(id => correlationByEventId.get(id))
      .filter((value): value is ChangeCorrelation => Boolean(value));

    const maxScore = related.reduce((max, item) => Math.max(max, item.correlationScore), 0);
    const avgScore = related.length === 0
      ? 0
      : related.reduce((sum, item) => sum + item.correlationScore, 0) / related.length;
    const score = Math.round((maxScore * 0.65 + avgScore * 0.35) * 1000) / 1000;

    const whyRelevant = uniqueStrings([
      ...related.flatMap(item => item.whyRelevant),
      ...changeSet.readinessDelta.notes,
    ]).slice(0, 10);

    const evidence = dedupeEvidence([
      ...changeSet.evidence,
      ...related.flatMap(item => item.evidence),
    ]).slice(0, 25);

    const confidence = aggregateConfidence(related, score);
    const suggestedBlastRadius = blastRadiusAnalyzer
      ? blastRadiusAnalyzer.predict(
          changeSet.services,
          dominantChangeType(changeSet),
          { maxDepth: 3 }
        )
      : undefined;

    return {
      changeSet,
      score,
      whyRelevant,
      confidence,
      evidence,
      suggestedBlastRadius,
    };
  });

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
