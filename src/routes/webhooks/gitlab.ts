/**
 * GitLab Webhook — Receives push, merge request, deployment, and pipeline events
 *
 * Verifies X-Gitlab-Token header against GITLAB_WEBHOOK_SECRET (simple string match).
 */

import type { FastifyInstance } from 'fastify';

const MAIN_BRANCHES = ['main', 'master', 'production'];

export async function gitlabWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/webhooks/gitlab', async (request, reply) => {
    const secret = process.env.GITLAB_WEBHOOK_SECRET;

    // Verify token if secret is configured
    if (secret) {
      const token = request.headers['x-gitlab-token'] as string | undefined;
      if (!token || token !== secret) {
        return reply.status(401).send({ error: 'Invalid token' });
      }
    }

    const eventType = request.headers['x-gitlab-event'] as string;
    const payload = request.body as Record<string, unknown>;

    try {
      const event = parseGitLabEvent(eventType, payload);
      if (event) {
        const stored = fastify.store.insert(event as any);
        return reply.status(201).send({ id: stored.id, message: 'Event ingested' });
      }
      return reply.send({ message: `Ignored event: ${eventType}` });
    } catch (error) {
      fastify.log.error(error, 'Failed to process GitLab webhook');
      return reply.status(500).send({ error: 'Failed to process webhook' });
    }
  });
}

function parseGitLabEvent(
  eventType: string,
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  switch (eventType) {
    case 'Push Hook':
      return parsePushHook(payload);
    case 'Merge Request Hook':
      return parseMergeRequestHook(payload);
    case 'Deployment Hook':
      return parseDeploymentHook(payload);
    case 'Pipeline Hook':
      return parsePipelineHook(payload);
    default:
      return null;
  }
}

function parsePushHook(payload: Record<string, unknown>): Record<string, unknown> | null {
  const ref = (payload.ref as string) || '';
  const branch = ref.replace('refs/heads/', '');

  if (!MAIN_BRANCHES.includes(branch)) return null;

  const project = (payload.project as Record<string, unknown>) || {};
  const username = payload.user_username as string || payload.user_name as string || 'unknown';
  const commits = (payload.commits as unknown[]) || [];
  const lastCommit = commits.length > 0 ? (commits[commits.length - 1] as Record<string, unknown>) : {};

  return {
    service: project.name as string || 'unknown',
    changeType: 'deployment',
    source: 'gitlab',
    initiator: 'human',
    initiatorIdentity: username,
    status: 'completed',
    environment: 'production',
    commitSha: (payload.after as string) || (lastCommit.id as string),
    repository: project.path_with_namespace as string,
    branch,
    summary: `Push to ${branch}: ${commits.length} commit(s)`,
    metadata: { gitlab_event: 'Push Hook', commit_count: commits.length },
  };
}

function parseMergeRequestHook(payload: Record<string, unknown>): Record<string, unknown> | null {
  const attrs = (payload.object_attributes as Record<string, unknown>) || {};
  const action = attrs.action as string;
  const state = attrs.state as string;

  if (action !== 'merge' && state !== 'merged') return null;

  const project = (payload.project as Record<string, unknown>) || {};
  const user = (payload.user as Record<string, unknown>) || {};

  return {
    service: project.name as string || 'unknown',
    changeType: 'deployment',
    source: 'gitlab',
    initiator: 'human',
    initiatorIdentity: user.username as string || 'unknown',
    status: 'completed',
    environment: 'production',
    commitSha: attrs.merge_commit_sha as string,
    repository: project.path_with_namespace as string,
    branch: attrs.target_branch as string || 'main',
    summary: `MR !${attrs.iid} merged: ${attrs.title}`,
    metadata: { gitlab_event: 'Merge Request Hook', mr_iid: attrs.iid },
  };
}

function parseDeploymentHook(payload: Record<string, unknown>): Record<string, unknown> {
  const project = (payload.project as Record<string, unknown>) || {};
  const status = mapGitLabStatus(payload.status as string);
  const environment = (payload.environment as string) || 'production';

  return {
    service: project.name as string || 'unknown',
    changeType: 'deployment',
    source: 'gitlab',
    initiator: 'human',
    initiatorIdentity: payload.user_url ? extractUsernameFromUrl(payload.user_url as string) : 'unknown',
    status,
    environment,
    commitSha: payload.commit_url ? '' : undefined,
    repository: project.path_with_namespace as string,
    summary: `Deployment to ${environment}: ${status}`,
    metadata: {
      gitlab_event: 'Deployment Hook',
      deployment_id: payload.deployment_id,
      environment,
    },
  };
}

function parsePipelineHook(payload: Record<string, unknown>): Record<string, unknown> | null {
  const attrs = (payload.object_attributes as Record<string, unknown>) || {};
  const ref = (attrs.ref as string) || '';

  if (!MAIN_BRANCHES.includes(ref)) return null;

  const project = (payload.project as Record<string, unknown>) || {};
  const user = (payload.user as Record<string, unknown>) || {};
  const status = mapGitLabStatus(attrs.status as string);

  return {
    service: project.name as string || 'unknown',
    changeType: 'deployment',
    source: 'gitlab',
    initiator: 'human',
    initiatorIdentity: user.username as string || 'unknown',
    status,
    environment: 'production',
    commitSha: attrs.sha as string,
    repository: project.path_with_namespace as string,
    branch: ref,
    summary: `Pipeline #${attrs.id} on ${ref}: ${status}`,
    metadata: { gitlab_event: 'Pipeline Hook', pipeline_id: attrs.id },
  };
}

function mapGitLabStatus(status: string): string {
  switch (status) {
    case 'success':
    case 'created':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'rolled_back';
    default:
      return 'in_progress';
  }
}

function extractUsernameFromUrl(url: string): string {
  const parts = url.split('/');
  return parts[parts.length - 1] || 'unknown';
}
