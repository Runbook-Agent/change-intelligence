/**
 * OpenAPI 3.1 Specification for Change Intelligence Service
 */

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Change Intelligence Service',
    version: '0.1.0',
    description:
      'Webhook ingestion, change correlation, blast radius analysis, and service graph management. Designed for use by AI agents, MCP clients, and automated workflows.',
  },
  servers: [{ url: '/api/v1', description: 'API v1' }],
  paths: {
    '/api/v1/health': {
      get: {
        operationId: 'getHealth',
        summary: 'Health check',
        description: 'Returns service health, event count, and graph stats. Use this to verify connectivity before making other calls.',
        responses: {
          '200': {
            description: 'Service is healthy',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/HealthResponse' } } },
          },
        },
      },
    },
    '/api/v1/events': {
      post: {
        operationId: 'createEvent',
        summary: 'Create a change event',
        description: 'Records a new change event. Include idempotencyKey to safely retry. Blast radius is auto-computed when a service graph is loaded.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateEventRequest' } } },
        },
        responses: {
          '201': { description: 'Event created', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangeEvent' } } } },
          '200': { description: 'Duplicate (idempotencyKey matched)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangeEvent' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
      get: {
        operationId: 'queryEvents',
        summary: 'Query change events',
        description: 'Filter events by service, type, environment, time window, and more. Use the q parameter for full-text search.',
        parameters: [
          { name: 'services', in: 'query', schema: { type: 'string' }, description: 'Comma-separated service names' },
          { name: 'change_types', in: 'query', schema: { type: 'string' }, description: 'Comma-separated change types' },
          { name: 'sources', in: 'query', schema: { type: 'string' }, description: 'Comma-separated sources' },
          { name: 'environment', in: 'query', schema: { type: 'string' } },
          { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'until', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'initiator', in: 'query', schema: { type: 'string', enum: ['human', 'agent', 'automation', 'unknown'] } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['in_progress', 'completed', 'failed', 'rolled_back'] } },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Full-text search query' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
        ],
        responses: {
          '200': { description: 'List of events', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ChangeEvent' } } } } },
        },
      },
    },
    '/api/v1/events/{id}': {
      get: {
        operationId: 'getEvent',
        summary: 'Get event by ID',
        description: 'Retrieve a single change event by its UUID.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Event found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangeEvent' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
      patch: {
        operationId: 'updateEvent',
        summary: 'Update an event',
        description: 'Partial update of status, summary, tags, or metadata.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateEventRequest' } } },
        },
        responses: {
          '200': { description: 'Event updated', content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangeEvent' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
      delete: {
        operationId: 'deleteEvent',
        summary: 'Delete an event',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'Deleted' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/events/batch': {
      post: {
        operationId: 'createEventsBatch',
        summary: 'Create events in batch',
        description: 'Atomically insert up to 1000 events. Supports per-event idempotencyKey. Returns 201 if any created, 200 if all duplicates.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchEventsRequest' } } },
        },
        responses: {
          '201': { description: 'Some or all events created', content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchEventsResponse' } } } },
          '200': { description: 'All events were duplicates', content: { 'application/json': { schema: { $ref: '#/components/schemas/BatchEventsResponse' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/correlate': {
      post: {
        operationId: 'correlateChanges',
        summary: 'Correlate changes with an incident',
        description: 'Given affected services and an incident time, find the most likely causal changes ranked by correlation score.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CorrelateRequest' } } },
        },
        responses: {
          '200': { description: 'Correlation results', content: { 'application/json': { schema: { $ref: '#/components/schemas/CorrelateResponse' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/blast-radius': {
      post: {
        operationId: 'predictBlastRadius',
        summary: 'Predict blast radius of a change',
        description: 'Predicts which services are impacted by a change to the given services, using the service dependency graph.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/BlastRadiusRequest' } } },
        },
        responses: {
          '200': { description: 'Blast radius prediction', content: { 'application/json': { schema: { $ref: '#/components/schemas/BlastRadiusPrediction' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/velocity/{service}': {
      get: {
        operationId: 'getChangeVelocity',
        summary: 'Get change velocity for a service',
        description: 'Returns change frequency metrics. Use periods > 0 to get a multi-period trend.',
        parameters: [
          { name: 'service', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'window_minutes', in: 'query', schema: { type: 'integer', default: 60 } },
          { name: 'periods', in: 'query', schema: { type: 'integer', default: 0 }, description: '0 = single window, > 0 = trend with N periods' },
        ],
        responses: {
          '200': { description: 'Velocity metrics or trend' },
        },
      },
    },
    '/api/v1/graph/import': {
      post: {
        operationId: 'importGraph',
        summary: 'Import service graph',
        description: 'Import services and dependencies from a JSON config object. Merges with existing graph.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GraphImportRequest' } } },
        },
        responses: {
          '200': { description: 'Graph imported' },
          '400': { description: 'Invalid graph data', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/graph/import/backstage': {
      post: {
        operationId: 'importGraphFromBackstage',
        summary: 'Import graph from Backstage catalog',
        description: 'Fetches entities from a Backstage catalog API and imports them as services and dependencies.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['base_url'], properties: { base_url: { type: 'string', format: 'uri' }, token: { type: 'string' }, filters: { type: 'object' } } } } },
        },
        responses: {
          '200': { description: 'Backstage import complete' },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
          '502': { description: 'Backstage API error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/graph/services': {
      get: {
        operationId: 'listServices',
        summary: 'List all services in the graph',
        description: 'Returns all services currently loaded in the service dependency graph.',
        responses: {
          '200': { description: 'List of services' },
        },
      },
    },
    '/api/v1/graph/dependencies/{service}': {
      get: {
        operationId: 'getServiceDependencies',
        summary: 'Get dependencies and dependents',
        description: 'Returns both upstream dependencies and downstream dependents for a service.',
        parameters: [{ name: 'service', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': { description: 'Dependencies and dependents' },
          '404': { description: 'Service not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/graph/discover': {
      post: {
        operationId: 'discoverServices',
        summary: 'Auto-discover services (not implemented)',
        description: 'Placeholder for future auto-discovery. Returns 501.',
        responses: {
          '501': { description: 'Not implemented', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/graph/suggestions': {
      get: {
        operationId: 'getGraphSuggestions',
        summary: 'Get inferred relationship suggestions (not implemented)',
        description: 'Placeholder for future ML-based relationship suggestions.',
        responses: {
          '200': { description: 'Empty suggestions array' },
        },
      },
    },
    '/api/v1/webhooks/github': {
      post: {
        operationId: 'handleGithubWebhook',
        summary: 'GitHub webhook receiver',
        description: 'Receives deployment, push, and pull_request events from GitHub. Verifies X-Hub-Signature-256 if GITHUB_WEBHOOK_SECRET is set.',
        responses: {
          '201': { description: 'Event ingested' },
          '200': { description: 'Event ignored' },
          '401': { description: 'Invalid signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/webhooks/gitlab': {
      post: {
        operationId: 'handleGitlabWebhook',
        summary: 'GitLab webhook receiver',
        description: 'Receives push, merge request, deployment, and pipeline events from GitLab. Verifies X-GitLab-Token if GITLAB_WEBHOOK_SECRET is set.',
        responses: {
          '201': { description: 'Event ingested' },
          '200': { description: 'Event ignored' },
          '401': { description: 'Invalid token', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/webhooks/agent': {
      post: {
        operationId: 'handleAgentWebhook',
        summary: 'Coding agent webhook receiver',
        description: 'Receives events from Claude Code, Copilot, Cursor, and other coding agents. Bearer token auth via AGENT_WEBHOOK_SECRET.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/AgentWebhookPayload' } } },
        },
        responses: {
          '201': { description: 'Event ingested' },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/webhooks/aws': {
      post: {
        operationId: 'handleAwsWebhook',
        summary: 'AWS EventBridge webhook receiver',
        description: 'Receives CodePipeline, ECS, and Lambda state change events from AWS EventBridge.',
        responses: {
          '201': { description: 'Event ingested' },
          '200': { description: 'Event ignored' },
        },
      },
    },
    '/api/v1/webhooks/terraform': {
      post: {
        operationId: 'handleTerraformWebhook',
        summary: 'Terraform Cloud webhook receiver',
        description: 'Receives run notification events from Terraform Cloud/Enterprise. Verifies HMAC-SHA512 via X-TFE-Notification-Signature.',
        responses: {
          '201': { description: 'Event ingested' },
          '200': { description: 'Event ignored' },
          '401': { description: 'Invalid signature', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/webhooks/kubernetes': {
      post: {
        operationId: 'handleKubernetesWebhook',
        summary: 'Kubernetes event webhook receiver',
        description: 'Receives forwarded K8s events from cluster-side agents. Bearer token auth via K8S_WEBHOOK_SECRET.',
        responses: {
          '201': { description: 'Event ingested' },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
          '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/webhooks/register': {
      post: {
        operationId: 'registerWebhook',
        summary: 'Register a webhook subscription',
        description: 'Register a URL to receive POST notifications when change events match your filters. Optionally provide a secret for HMAC-SHA256 signature verification.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookRegistrationRequest' } } },
        },
        responses: {
          '201': { description: 'Registration created', content: { 'application/json': { schema: { $ref: '#/components/schemas/WebhookRegistration' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/webhooks/registrations': {
      get: {
        operationId: 'listWebhookRegistrations',
        summary: 'List webhook registrations',
        description: 'Returns all registered webhook subscriptions.',
        responses: {
          '200': { description: 'List of registrations' },
        },
      },
    },
    '/api/v1/webhooks/registrations/{id}': {
      delete: {
        operationId: 'deleteWebhookRegistration',
        summary: 'Delete a webhook registration',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '204': { description: 'Deleted' },
          '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/StructuredError' } } } },
        },
      },
    },
    '/api/v1/openapi.json': {
      get: {
        operationId: 'getOpenApiSpec',
        summary: 'Get OpenAPI specification',
        description: 'Returns this OpenAPI 3.1 spec as JSON. Useful for agent tool discovery.',
        responses: {
          '200': { description: 'OpenAPI spec', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
  },
  components: {
    schemas: {
      ChangeEvent: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          timestamp: { type: 'string', format: 'date-time' },
          service: { type: 'string' },
          additionalServices: { type: 'array', items: { type: 'string' } },
          changeType: { type: 'string', enum: ['deployment', 'config_change', 'infra_modification', 'feature_flag', 'db_migration', 'code_change', 'rollback', 'scaling', 'security_patch'] },
          source: { type: 'string', enum: ['github', 'gitlab', 'aws_codepipeline', 'aws_ecs', 'aws_lambda', 'kubernetes', 'claude_hook', 'agent_hook', 'manual', 'terraform'] },
          initiator: { type: 'string', enum: ['human', 'agent', 'automation', 'unknown'] },
          initiatorIdentity: { type: 'string' },
          status: { type: 'string', enum: ['in_progress', 'completed', 'failed', 'rolled_back'] },
          environment: { type: 'string' },
          commitSha: { type: 'string' },
          prNumber: { type: 'string' },
          prUrl: { type: 'string' },
          repository: { type: 'string' },
          branch: { type: 'string' },
          summary: { type: 'string' },
          diff: { type: 'string' },
          filesChanged: { type: 'array', items: { type: 'string' } },
          configKeys: { type: 'array', items: { type: 'string' } },
          previousVersion: { type: 'string' },
          newVersion: { type: 'string' },
          blastRadius: { $ref: '#/components/schemas/BlastRadiusPrediction' },
          idempotencyKey: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', additionalProperties: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CreateEventRequest: {
        type: 'object',
        required: ['service', 'summary'],
        properties: {
          service: { type: 'string' },
          changeType: { type: 'string', default: 'deployment' },
          summary: { type: 'string' },
          additionalServices: { type: 'array', items: { type: 'string' } },
          source: { type: 'string' },
          initiator: { type: 'string' },
          initiatorIdentity: { type: 'string' },
          status: { type: 'string' },
          environment: { type: 'string' },
          commitSha: { type: 'string' },
          prNumber: { type: 'string' },
          prUrl: { type: 'string' },
          repository: { type: 'string' },
          branch: { type: 'string' },
          diff: { type: 'string' },
          filesChanged: { type: 'array', items: { type: 'string' } },
          configKeys: { type: 'array', items: { type: 'string' } },
          previousVersion: { type: 'string' },
          newVersion: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', additionalProperties: true },
          timestamp: { type: 'string', format: 'date-time' },
          idempotencyKey: { type: 'string', description: 'Unique key for idempotent ingestion. If a matching key exists, the existing event is returned with HTTP 200.' },
        },
      },
      UpdateEventRequest: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          summary: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', additionalProperties: true },
          blastRadius: {},
        },
      },
      BatchEventsRequest: {
        type: 'object',
        required: ['events'],
        properties: {
          events: { type: 'array', items: { $ref: '#/components/schemas/CreateEventRequest' }, minItems: 1, maxItems: 1000 },
        },
      },
      BatchEventsResponse: {
        type: 'object',
        properties: {
          results: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                index: { type: 'integer' },
                id: { type: 'string' },
                status: { type: 'string', enum: ['created', 'duplicate'] },
                event: { $ref: '#/components/schemas/ChangeEvent' },
              },
            },
          },
          stats: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              created: { type: 'integer' },
              duplicates: { type: 'integer' },
            },
          },
        },
      },
      BlastRadiusPrediction: {
        type: 'object',
        properties: {
          directServices: { type: 'array', items: { type: 'string' } },
          downstreamServices: { type: 'array', items: { type: 'string' } },
          criticalPathAffected: { type: 'boolean' },
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          impactPaths: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                from: { type: 'string' },
                to: { type: 'string' },
                hops: { type: 'integer' },
                criticality: { type: 'string' },
                path: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          rationale: { type: 'array', items: { type: 'string' } },
        },
      },
      BlastRadiusRequest: {
        type: 'object',
        required: ['services'],
        properties: {
          services: { type: 'array', items: { type: 'string' }, minItems: 1 },
          change_type: { type: 'string' },
          max_depth: { type: 'integer' },
        },
      },
      CorrelateRequest: {
        type: 'object',
        required: ['affected_services'],
        properties: {
          affected_services: { type: 'array', items: { type: 'string' }, minItems: 1 },
          incident_time: { type: 'string', format: 'date-time' },
          window_minutes: { type: 'number' },
          max_results: { type: 'number' },
          min_score: { type: 'number' },
        },
      },
      CorrelateResponse: {
        type: 'object',
        properties: {
          correlations: { type: 'array', items: { $ref: '#/components/schemas/ChangeCorrelation' } },
          query: { type: 'object' },
        },
      },
      ChangeCorrelation: {
        type: 'object',
        properties: {
          changeEvent: { $ref: '#/components/schemas/ChangeEvent' },
          correlationScore: { type: 'number' },
          correlationReasons: { type: 'array', items: { type: 'string' } },
          serviceOverlap: { type: 'array', items: { type: 'string' } },
          timeDeltaMinutes: { type: 'number' },
        },
      },
      GraphImportRequest: {
        type: 'object',
        properties: {
          services: { type: 'array', items: { type: 'object' } },
          dependencies: { type: 'array', items: { type: 'object' } },
        },
      },
      AgentWebhookPayload: {
        type: 'object',
        required: ['agent', 'action', 'service', 'summary'],
        properties: {
          agent: { type: 'string', description: 'Agent name (e.g. claude-code, copilot, cursor)' },
          action: { type: 'string', description: 'Action type (commit, file_edit, refactor, deployment, config_change)' },
          service: { type: 'string' },
          summary: { type: 'string' },
          session_id: { type: 'string' },
          parent_event_id: { type: 'string' },
          repository: { type: 'string' },
          branch: { type: 'string' },
          commit_sha: { type: 'string' },
          environment: { type: 'string' },
          files_changed: { type: 'array', items: { type: 'string' } },
          tool_calls: { type: 'array', items: {} },
          reasoning: { type: 'string' },
          diff: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          change_type: { type: 'string' },
          additional_services: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          metadata: { type: 'object', additionalProperties: true },
        },
      },
      WebhookRegistrationRequest: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', format: 'uri' },
          secret: { type: 'string', description: 'Shared secret for HMAC-SHA256 signature in X-Webhook-Signature header' },
          services: { type: 'array', items: { type: 'string' }, description: 'Filter: only dispatch for these services (empty = all)' },
          changeTypes: { type: 'array', items: { type: 'string' }, description: 'Filter: only dispatch for these change types (empty = all)' },
          environments: { type: 'array', items: { type: 'string' }, description: 'Filter: only dispatch for these environments (empty = all)' },
        },
      },
      WebhookRegistration: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          url: { type: 'string', format: 'uri' },
          secret: { type: 'string' },
          services: { type: 'array', items: { type: 'string' } },
          changeTypes: { type: 'array', items: { type: 'string' } },
          environments: { type: 'array', items: { type: 'string' } },
          active: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      StructuredError: {
        type: 'object',
        properties: {
          error: { type: 'string', description: 'Machine-readable snake_case error code' },
          message: { type: 'string', description: 'Human-readable error description' },
          hint: { type: 'string', description: 'Recovery action hint for AI agents' },
          status: { type: 'integer' },
          details: { description: 'Additional error context (e.g. validation issues)' },
        },
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          version: { type: 'string' },
          store: { type: 'object', properties: { totalEvents: { type: 'integer' } } },
          graph: { type: 'object', properties: { services: { type: 'integer' }, edges: { type: 'integer' } } },
        },
      },
    },
  },
} as const;
