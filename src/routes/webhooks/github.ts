/**
 * GitHub Webhook — Receives deployment, push, and PR events
 *
 * Verifies X-Hub-Signature-256 and converts to ChangeEvents.
 */

import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { unauthorizedError, internalError } from '../../errors';

export async function githubWebhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/v1/webhooks/github', async (request, reply) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    // Verify signature if secret is configured
    if (secret) {
      const signature = request.headers['x-hub-signature-256'] as string | undefined;
      if (!signature) {
        return unauthorizedError(reply, 'Missing signature');
      }

      const body = JSON.stringify(request.body);
      const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return unauthorizedError(reply, 'Invalid signature');
      }
    }

    const eventType = request.headers['x-github-event'] as string;
    const payload = request.body as Record<string, unknown>;

    try {
      const event = parseGitHubEvent(eventType, payload);
      if (event) {
        const stored = fastify.store.insert(event);
        fastify.webhookDispatcher.dispatch(stored, fastify.log);
        return reply.status(201).send({ id: stored.id, message: 'Event ingested' });
      }
      return reply.send({ message: `Ignored event type: ${eventType}` });
    } catch (error) {
      fastify.log.error(error, 'Failed to process GitHub webhook');
      return internalError(reply, 'Failed to process GitHub webhook');
    }
  });
}

function parseGitHubEvent(
  eventType: string,
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  switch (eventType) {
    case 'deployment':
    case 'deployment_status':
      return parseDeploymentEvent(payload);
    case 'push':
      return parsePushEvent(payload);
    case 'pull_request':
      return parsePullRequestEvent(payload);
    default:
      return null;
  }
}

function parseDeploymentEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const deployment = payload.deployment as Record<string, unknown> || {};
  const repo = payload.repository as Record<string, unknown> || {};
  const sender = payload.sender as Record<string, unknown> || {};

  const environment = (deployment.environment as string) || 'production';
  const repoName = (repo.name as string) || 'unknown';

  return {
    service: repoName,
    changeType: 'deployment',
    source: 'github',
    initiator: (sender.type as string) === 'Bot' ? 'automation' : 'human',
    initiatorIdentity: sender.login as string,
    status: mapDeploymentStatus(payload),
    environment,
    commitSha: deployment.sha as string,
    repository: repo.full_name as string,
    summary: `Deployment to ${environment} for ${repoName}`,
    metadata: { github_event: 'deployment', deployment_id: deployment.id },
  };
}

function parsePushEvent(payload: Record<string, unknown>): Record<string, unknown> | null {
  const ref = payload.ref as string || '';
  const mainBranches = ['refs/heads/main', 'refs/heads/master', 'refs/heads/production'];

  if (!mainBranches.includes(ref)) return null;

  const repo = payload.repository as Record<string, unknown> || {};
  const sender = payload.sender as Record<string, unknown> || {};
  const headCommit = payload.head_commit as Record<string, unknown> || {};
  const commits = (payload.commits as unknown[]) || [];

  return {
    service: repo.name as string || 'unknown',
    changeType: 'deployment',
    source: 'github',
    initiator: (sender.type as string) === 'Bot' ? 'automation' : 'human',
    initiatorIdentity: sender.login as string,
    status: 'completed',
    environment: 'production',
    commitSha: headCommit.id as string,
    repository: repo.full_name as string,
    branch: ref.replace('refs/heads/', ''),
    summary: `Push to ${ref.replace('refs/heads/', '')}: ${headCommit.message || `${commits.length} commits`}`,
    metadata: { github_event: 'push', commit_count: commits.length },
  };
}

function parsePullRequestEvent(payload: Record<string, unknown>): Record<string, unknown> | null {
  const action = payload.action as string;
  if (action !== 'closed') return null;

  const pr = payload.pull_request as Record<string, unknown> || {};
  if (!pr.merged) return null;

  const repo = payload.repository as Record<string, unknown> || {};
  const sender = payload.sender as Record<string, unknown> || {};

  return {
    service: repo.name as string || 'unknown',
    changeType: 'deployment',
    source: 'github',
    initiator: 'human',
    initiatorIdentity: sender.login as string,
    status: 'completed',
    environment: 'production',
    commitSha: pr.merge_commit_sha as string,
    prNumber: String(pr.number),
    prUrl: pr.html_url as string,
    repository: repo.full_name as string,
    branch: pr.base as Record<string, unknown> ? (pr.base as Record<string, unknown>).ref as string : 'main',
    summary: `PR #${pr.number} merged: ${pr.title}`,
    filesChanged: [],
    metadata: { github_event: 'pull_request', pr_number: pr.number },
  };
}

function mapDeploymentStatus(payload: Record<string, unknown>): string {
  const deploymentStatus = payload.deployment_status as Record<string, unknown> | undefined;
  if (!deploymentStatus) return 'in_progress';
  const state = deploymentStatus.state as string;
  switch (state) {
    case 'success': return 'completed';
    case 'failure': case 'error': return 'failed';
    case 'inactive': return 'rolled_back';
    default: return 'in_progress';
  }
}
