import type { ChangeEvent, EvidenceLink } from './types';

const METADATA_URL_KEYS = [
  'url',
  'run_url',
  'pipeline_url',
  'deployment_url',
  'workflow_url',
  'compare_url',
  'mr_url',
  'pr_url',
] as const;

function readMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  if (!metadata) return undefined;
  const value = metadata[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasHttpPrefix(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function inferRepoBaseUrl(event: ChangeEvent): string | undefined {
  if (!event.repository) return undefined;

  if (hasHttpPrefix(event.repository)) {
    return event.repository.replace(/\.git$/, '').replace(/\/$/, '');
  }

  // repository can be org/repo in webhook payloads
  if (event.repository.includes('/')) {
    if (event.source === 'gitlab') return `https://gitlab.com/${event.repository}`;
    return `https://github.com/${event.repository}`;
  }

  return undefined;
}

function inferCommitUrl(event: ChangeEvent): string | undefined {
  if (!event.commitSha) return undefined;
  const repoBase = inferRepoBaseUrl(event);
  if (!repoBase) return undefined;

  if (event.source === 'gitlab') {
    return `${repoBase}/-/commit/${event.commitSha}`;
  }

  return `${repoBase}/commit/${event.commitSha}`;
}

function dedupeEvidence(evidence: EvidenceLink[]): EvidenceLink[] {
  const seen = new Set<string>();
  const deduped: EvidenceLink[] = [];

  for (const item of evidence) {
    const key = `${item.type}|${item.url || ''}|${item.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

export function extractEventEvidence(event: ChangeEvent): EvidenceLink[] {
  const evidence: EvidenceLink[] = [
    {
      type: 'event',
      label: `Change event ${event.id}`,
      url: `/api/v1/events/${event.id}`,
      eventId: event.id,
      source: event.source,
      timestamp: event.timestamp,
    },
  ];

  if (event.prUrl) {
    evidence.push({
      type: 'pull_request',
      label: `PR ${event.prNumber || ''}`.trim(),
      url: event.prUrl,
      eventId: event.id,
      source: event.source,
      timestamp: event.timestamp,
    });
  }

  const commitUrl = inferCommitUrl(event);
  if (commitUrl) {
    evidence.push({
      type: 'commit',
      label: event.commitSha ? `Commit ${event.commitSha.slice(0, 12)}` : 'Commit',
      url: commitUrl,
      eventId: event.id,
      source: event.source,
      timestamp: event.timestamp,
    });
  }

  if (event.canonicalUrl) {
    evidence.push({
      type: 'other',
      label: 'Canonical change URL',
      url: event.canonicalUrl,
      eventId: event.id,
      source: event.source,
      timestamp: event.timestamp,
    });
  }

  const metadata = event.metadata || {};
  for (const key of METADATA_URL_KEYS) {
    const value = readMetadataString(metadata, key);
    if (!value || !hasHttpPrefix(value)) continue;

    const type: EvidenceLink['type'] =
      key === 'run_url' && event.source === 'terraform'
        ? 'terraform_run'
        : key.includes('pipeline')
          ? 'pipeline_run'
          : key.includes('deploy') || key.includes('workflow')
            ? 'deployment_run'
            : key === 'mr_url' || key === 'pr_url'
              ? 'pull_request'
              : 'other';

    evidence.push({
      type,
      label: `Metadata ${key}`,
      url: value,
      eventId: event.id,
      source: event.source,
      timestamp: event.timestamp,
      details: { metadataKey: key },
    });
  }

  return dedupeEvidence(evidence);
}

export function inferEventCanonicalUrl(event: ChangeEvent): string | undefined {
  if (event.canonicalUrl) return event.canonicalUrl;
  if (event.prUrl) return event.prUrl;

  const commitUrl = inferCommitUrl(event);
  if (commitUrl) return commitUrl;

  const metadata = event.metadata || {};
  for (const key of METADATA_URL_KEYS) {
    const value = readMetadataString(metadata, key);
    if (value && hasHttpPrefix(value)) return value;
  }

  return undefined;
}
