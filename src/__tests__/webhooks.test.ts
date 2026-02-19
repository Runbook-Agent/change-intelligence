import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from '../server';
import type { FastifyInstance } from 'fastify';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

function tmpDb() {
  return join(tmpdir(), `test-webhooks-${randomUUID()}.db`);
}

describe('Webhooks', () => {
  let server: FastifyInstance;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tmpDb();
    server = await createServer({
      dbPath,
      graphData: {
        services: [
          { id: 'api', name: 'API', type: 'service', tier: 'critical', tags: [] },
          { id: 'db', name: 'Database', type: 'database', tags: [] },
        ],
        dependencies: [
          { source: 'api', target: 'db', type: 'database', criticality: 'critical' },
        ],
      },
    });
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(dbPath)) unlinkSync(dbPath);
  });

  // ─── Agent Webhook ─────────────────────────────────────────────────

  describe('Agent Webhook', () => {
    it('ingests a Claude Code event with claude_hook source', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/agent',
        payload: {
          agent: 'claude-code',
          action: 'commit',
          service: 'api',
          summary: 'Refactored auth module',
        },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();

      // Verify stored event
      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${body.id}` });
      const data = event.json();
      expect(data.source).toBe('claude_hook');
      expect(data.initiator).toBe('agent');
      expect(data.changeType).toBe('code_change');
      expect(data.environment).toBe('development');
    });

    it('ingests a generic agent event with agent_hook source', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/agent',
        payload: {
          agent: 'copilot',
          action: 'file_edit',
          service: 'api',
          summary: 'Added error handling',
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.source).toBe('agent_hook');
      expect(data.initiatorIdentity).toBe('copilot');
    });

    it('returns 400 for invalid payload', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/agent',
        payload: { agent: 'test' }, // missing required fields
      });
      expect(res.statusCode).toBe(400);
    });

    it('stores tool_calls in metadata', async () => {
      const toolCalls = [{ tool: 'read_file', args: { path: 'src/main.ts' } }];
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/agent',
        payload: {
          agent: 'claude-code',
          action: 'refactor',
          service: 'api',
          summary: 'Refactored main module',
          tool_calls: toolCalls,
          reasoning: 'Needed cleaner separation of concerns',
          confidence: 0.85,
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.metadata.tool_calls).toEqual(toolCalls);
      expect(data.metadata.reasoning).toBe('Needed cleaner separation of concerns');
      expect(data.metadata.confidence).toBe(0.85);
    });

    it('auto-computes blast radius', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/agent',
        payload: {
          agent: 'claude-code',
          action: 'commit',
          service: 'api',
          summary: 'Updated API handler',
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.blastRadius).toBeDefined();
    });

    it('maps deployment action to deployment change type', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/agent',
        payload: {
          agent: 'cursor',
          action: 'deployment',
          service: 'api',
          summary: 'Deployed via Cursor',
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      expect(event.json().changeType).toBe('deployment');
    });

    it('appends auto-tags', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/agent',
        payload: {
          agent: 'Claude-Code',
          action: 'commit',
          service: 'api',
          summary: 'test',
          tags: ['my-tag'],
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const tags = event.json().tags;
      expect(tags).toContain('my-tag');
      expect(tags).toContain('agent');
      expect(tags).toContain('claude-code');
    });
  });

  // ─── GitLab Webhook ────────────────────────────────────────────────

  describe('GitLab Webhook', () => {
    it('ingests a push to main', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/gitlab',
        headers: { 'x-gitlab-event': 'Push Hook' },
        payload: {
          ref: 'refs/heads/main',
          after: 'abc123',
          user_username: 'jdoe',
          project: { name: 'my-api', path_with_namespace: 'team/my-api' },
          commits: [{ id: 'abc123', message: 'fix bug' }],
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.source).toBe('gitlab');
      expect(data.changeType).toBe('deployment');
      expect(data.status).toBe('completed');
      expect(data.initiatorIdentity).toBe('jdoe');
      expect(data.repository).toBe('team/my-api');
    });

    it('ignores push to non-main branch', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/gitlab',
        headers: { 'x-gitlab-event': 'Push Hook' },
        payload: {
          ref: 'refs/heads/feature/foo',
          project: { name: 'my-api', path_with_namespace: 'team/my-api' },
          commits: [],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toContain('Ignored');
    });

    it('ingests a merged merge request', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/gitlab',
        headers: { 'x-gitlab-event': 'Merge Request Hook' },
        payload: {
          object_attributes: {
            action: 'merge',
            state: 'merged',
            iid: 42,
            title: 'Add caching layer',
            target_branch: 'main',
            merge_commit_sha: 'def456',
          },
          project: { name: 'my-api', path_with_namespace: 'team/my-api' },
          user: { username: 'jdoe' },
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.summary).toContain('MR !42');
      expect(data.commitSha).toBe('def456');
    });

    it('ingests a deployment event', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/gitlab',
        headers: { 'x-gitlab-event': 'Deployment Hook' },
        payload: {
          status: 'success',
          environment: 'staging',
          deployment_id: 100,
          project: { name: 'my-api', path_with_namespace: 'team/my-api' },
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.status).toBe('completed');
      expect(data.environment).toBe('staging');
    });

    it('ingests a pipeline event on main', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/gitlab',
        headers: { 'x-gitlab-event': 'Pipeline Hook' },
        payload: {
          object_attributes: { id: 999, ref: 'main', status: 'failed', sha: 'ghi789' },
          project: { name: 'my-api', path_with_namespace: 'team/my-api' },
          user: { username: 'jdoe' },
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      expect(event.json().status).toBe('failed');
    });

    it('rejects invalid token when secret is configured', async () => {
      // Temporarily set the env var
      process.env.GITLAB_WEBHOOK_SECRET = 'my-secret';
      try {
        const res = await server.inject({
          method: 'POST',
          url: '/api/v1/webhooks/gitlab',
          headers: {
            'x-gitlab-event': 'Push Hook',
            'x-gitlab-token': 'wrong-secret',
          },
          payload: {
            ref: 'refs/heads/main',
            project: { name: 'my-api', path_with_namespace: 'team/my-api' },
            commits: [],
          },
        });
        expect(res.statusCode).toBe(401);
      } finally {
        delete process.env.GITLAB_WEBHOOK_SECRET;
      }
    });
  });

  // ─── Terraform Webhook ─────────────────────────────────────────────

  describe('Terraform Webhook', () => {
    it('ingests a completed run', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/terraform',
        payload: {
          workspace_name: 'infra-production',
          run_created_by: 'alice',
          run_id: 'run-abc',
          run_url: 'https://app.terraform.io/run/run-abc',
          organization_name: 'my-org',
          notifications: [
            { trigger: 'run:completed', run_status: 'applied' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.source).toBe('terraform');
      expect(data.changeType).toBe('infra_modification');
      expect(data.status).toBe('completed');
      expect(data.environment).toBe('production');
      expect(data.initiator).toBe('human');
      expect(data.initiatorIdentity).toBe('alice');
      expect(data.metadata.run_id).toBe('run-abc');
    });

    it('maps errored run to failed status', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/terraform',
        payload: {
          workspace_name: 'infra-staging',
          notifications: [
            { trigger: 'run:errored', run_status: 'errored' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.status).toBe('failed');
      expect(data.environment).toBe('staging');
      expect(data.initiator).toBe('automation');
    });

    it('infers environment from workspace name', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/terraform',
        payload: {
          workspace_name: 'app-dev-us-east',
          run_created_by: 'bob',
          notifications: [
            { trigger: 'run:applying', run_status: 'applying' },
          ],
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      expect(event.json().environment).toBe('development');
      expect(event.json().status).toBe('in_progress');
    });
  });

  // ─── Kubernetes Webhook ────────────────────────────────────────────

  describe('Kubernetes Webhook', () => {
    it('ingests a Deployment update with image version extraction', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/kubernetes',
        payload: {
          kind: 'Deployment',
          name: 'api',
          namespace: 'production',
          action: 'update',
          image: 'myregistry.io/api:v2.1.0',
          previous_image: 'myregistry.io/api:v2.0.0',
          cluster: 'prod-us-east',
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.source).toBe('kubernetes');
      expect(data.changeType).toBe('deployment');
      expect(data.newVersion).toBe('v2.1.0');
      expect(data.previousVersion).toBe('v2.0.0');
      expect(data.environment).toBe('production');
      expect(data.metadata.cluster).toBe('prod-us-east');
    });

    it('maps ConfigMap to config_change', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/kubernetes',
        payload: {
          kind: 'ConfigMap',
          name: 'api-config',
          namespace: 'staging',
          action: 'update',
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.changeType).toBe('config_change');
      expect(data.environment).toBe('staging');
    });

    it('maps HPA scale to scaling', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/kubernetes',
        payload: {
          kind: 'HorizontalPodAutoscaler',
          name: 'api-hpa',
          namespace: 'production',
          action: 'scale',
          replicas: 5,
          previous_replicas: 3,
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      const data = event.json();
      expect(data.changeType).toBe('scaling');
      expect(data.metadata.replicas).toBe(5);
      expect(data.metadata.previous_replicas).toBe(3);
    });

    it('maps delete action to rollback', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/kubernetes',
        payload: {
          kind: 'Deployment',
          name: 'old-service',
          namespace: 'default',
          action: 'delete',
        },
      });
      expect(res.statusCode).toBe(201);

      const event = await server.inject({ method: 'GET', url: `/api/v1/events/${res.json().id}` });
      expect(event.json().changeType).toBe('rollback');
    });

    it('returns 400 for invalid payload', async () => {
      const res = await server.inject({
        method: 'POST',
        url: '/api/v1/webhooks/kubernetes',
        payload: { kind: 'Deployment' }, // missing required fields
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
