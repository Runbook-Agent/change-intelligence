# Change Intelligence Service

A standalone service that ingests change events (deployments, config changes, infra modifications) via webhooks and a REST API, then provides **change correlation** and **blast radius analysis** for incident triage.

Designed as an optional companion to [RunbookAI](https://github.com/Runbook-Agent/RunbookAI) — if configured, the CLI gains "what changed recently?" during investigations. If not configured, everything still works.

## Quick start

```bash
npm install
npm run dev
```

The service starts on `http://localhost:3001`. Verify with:

```bash
curl http://localhost:3001/api/v1/health
```

## Architecture

```
Webhook Ingestion ──► SQLite Store ◄── Query API
(GitHub, GitLab,      (changes.db)     (REST)
 AWS, Terraform,
 K8s, Agents)
       │                   │
       ▼                   ▼
Change Correlator    Blast Radius Analyzer
(time + service       (service graph
 graph scoring)        traversal)
```

**Stack:** Fastify, better-sqlite3 (FTS5), Zod, TypeScript.

No external databases, no message queues, no cache layers — a single binary that starts instantly with a local SQLite file.

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `CHANGE_INTEL_DB_PATH` | `changes.db` | SQLite database file path |
| `CHANGE_INTEL_GRAPH_PATH` | — | Path to a YAML service graph file |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC secret for GitHub webhook verification |
| `GITLAB_WEBHOOK_SECRET` | — | Token for GitLab webhook verification |
| `TERRAFORM_WEBHOOK_SECRET` | — | HMAC-SHA512 secret for Terraform Cloud webhook verification |
| `AGENT_WEBHOOK_SECRET` | — | Bearer token for coding agent webhook verification |
| `K8S_WEBHOOK_SECRET` | — | Bearer token for Kubernetes webhook verification |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |

## Service graph

The service graph powers correlation and blast radius. Define it in a YAML file:

```yaml
# graph.yaml
services:
  - id: api-gateway
    name: API Gateway
    type: service
    tier: critical
    team: platform
    tags: [api, public-facing]

  - id: user-service
    name: User Service
    type: service
    tier: high
    team: accounts

  - id: users-db
    name: Users Database
    type: database
    tier: critical
    team: accounts

dependencies:
  - source: api-gateway
    target: user-service
    type: sync
    criticality: critical

  - source: user-service
    target: users-db
    type: database
    criticality: critical
```

Load on startup with `CHANGE_INTEL_GRAPH_PATH=graph.yaml`, or import at runtime:

```bash
curl -X POST http://localhost:3001/api/v1/graph/import \
  -H 'Content-Type: application/json' \
  -d @graph.json
```

## API reference

### Events

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/events` | Create a change event |
| `GET` | `/api/v1/events` | Query events (filters: `services`, `change_types`, `sources`, `environment`, `since`, `until`, `initiator`, `status`, `q`, `limit`) |
| `GET` | `/api/v1/events/:id` | Get event by ID |
| `PATCH` | `/api/v1/events/:id` | Update event |
| `DELETE` | `/api/v1/events/:id` | Delete event |

### Analysis

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/correlate` | Correlate changes with an incident. Body: `{ affected_services, incident_time?, window_minutes? }` |
| `POST` | `/api/v1/blast-radius` | Predict blast radius. Body: `{ services, change_type? }` |
| `GET` | `/api/v1/velocity/:service` | Change velocity. Query: `window_minutes`, `periods` |

### Graph

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/graph/import` | Import service graph (JSON or YAML config format) |
| `POST` | `/api/v1/graph/import/backstage` | Import from a Backstage service catalog |
| `GET` | `/api/v1/graph/services` | List all services |
| `GET` | `/api/v1/graph/dependencies/:service` | Get dependencies and dependents |
| `POST` | `/api/v1/graph/discover` | Auto-discovery (stub — not yet implemented) |
| `GET` | `/api/v1/graph/suggestions` | Inferred relationships (stub) |

### Webhooks

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/webhooks/github` | GitHub webhook (deployment, push to main, merged PR) |
| `POST` | `/api/v1/webhooks/aws` | AWS EventBridge (CodePipeline, ECS, Lambda via CloudTrail) |
| `POST` | `/api/v1/webhooks/agent` | Coding agent events (Claude Code, Copilot, Cursor, etc.) |
| `POST` | `/api/v1/webhooks/gitlab` | GitLab webhook (push, merge request, deployment, pipeline) |
| `POST` | `/api/v1/webhooks/terraform` | Terraform Cloud run notifications |
| `POST` | `/api/v1/webhooks/kubernetes` | Kubernetes events (from cluster-side agents/controllers) |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Health check with store and graph stats |

## Examples

**Register a deployment:**

```bash
curl -X POST http://localhost:3001/api/v1/events \
  -H 'Content-Type: application/json' \
  -d '{
    "service": "user-service",
    "changeType": "deployment",
    "summary": "Deploy v2.3.1 — fix auth token refresh",
    "environment": "production",
    "commitSha": "abc1234",
    "source": "github",
    "initiator": "human"
  }'
```

**Correlate changes with an incident:**

```bash
curl -X POST http://localhost:3001/api/v1/correlate \
  -H 'Content-Type: application/json' \
  -d '{
    "affected_services": ["api-gateway", "user-service"],
    "window_minutes": 120
  }'
```

**Register a coding agent event:**

```bash
curl -X POST http://localhost:3001/api/v1/webhooks/agent \
  -H 'Content-Type: application/json' \
  -d '{
    "agent": "claude-code",
    "action": "commit",
    "service": "user-service",
    "summary": "Refactored auth token refresh logic",
    "repository": "team/user-service",
    "branch": "main",
    "files_changed": ["src/auth.ts", "src/token.ts"],
    "confidence": 0.9
  }'
```

**Import from Backstage catalog:**

```bash
curl -X POST http://localhost:3001/api/v1/graph/import/backstage \
  -H 'Content-Type: application/json' \
  -d '{
    "base_url": "https://backstage.example.com",
    "api_token": "your-backstage-token",
    "options": {
      "namespaces": ["default"],
      "lifecycles": ["production"]
    }
  }'
```

**Predict blast radius before deploying:**

```bash
curl -X POST http://localhost:3001/api/v1/blast-radius \
  -H 'Content-Type: application/json' \
  -d '{
    "services": ["users-db"],
    "change_type": "db_migration"
  }'
```

## Correlation scoring model

When correlating changes with an incident, each change is scored on four dimensions:

| Factor | Weight | Method |
|--------|--------|--------|
| Time proximity | 40% | Exponential decay: `e^(-t/30)` where t is minutes |
| Service overlap | 35% | Direct match = 1.0, 1-hop graph neighbor = 0.7, 2-hop = 0.4 |
| Change risk | 15% | Blast radius risk level: critical = 1.0, high = 0.8, medium = 0.5, low = 0.2 |
| Change type | 10% | deployment = 1.0, config_change = 0.9, feature_flag = 0.8, ... |

## [RunbookAI](https://github.com/Runbook-Agent/RunbookAI) CLI integration

Add to `.runbook/config.yaml`:

```yaml
providers:
  changeIntelligence:
    enabled: true
    baseUrl: http://localhost:3001
```

This unlocks:
- **Agent tools:** `query_change_events`, `correlate_changes`, `predict_blast_radius`, `get_change_velocity`
- **Investigation triage:** Automatic change correlation during `runbook investigate`
- **CLI commands:** `runbook changes list|register|correlate|blast-radius|velocity`
- **MCP tools:** `query_changes`, `predict_change_impact` (for Claude Code)

## Development

```bash
npm run dev          # Start with hot reload
npm test             # Run tests (vitest)
npm run test:watch   # Watch mode
npm run typecheck    # Type checking
npm run build        # Compile TypeScript
```

## License

MIT
