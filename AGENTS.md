# AGENTS.md — Context for AI Agents Working on This Codebase

This file captures architectural decisions, implementation gotchas, and design rationale for the Change Intelligence Service. It exists so that any AI agent (or human) picking up this codebase can get up to speed without re-deriving context from scratch.

## What This Service Does

The Change Intelligence Service answers three questions during incident response:

1. **"What changed recently?"** — Ingests change events (deployments, config changes, infra modifications) via webhooks and a REST API, stores them in SQLite.
2. **"Which change caused this?"** — Correlates stored changes with an incident using a weighted scoring model that combines time proximity, service graph relationships, blast radius risk, and change type.
3. **"What will break if we change this?"** — Predicts blast radius by traversing a service dependency graph to find upstream consumers.

It is a **standalone, independently deployable Fastify service**. It is NOT part of the RunbookAI CLI — the CLI treats it as an optional external provider via an HTTP adapter. If the service isn't running, the CLI works fine without it.

## Relationship to RunbookAI CLI

The CLI integration lives in the RunbookAI repo (not this repo):

| CLI file | What it does |
|----------|--------------|
| `src/providers/change-intelligence/adapter.ts` | HTTP client with **inlined types** (no shared package) |
| `src/utils/config.ts` | `providers.changeIntelligence` config schema |
| `src/tools/registry.ts` | 4 agent tools gated behind `enabled: true` |
| `src/cli/runtime-tools.ts` | Filters tools out when service is disabled |
| `src/agent/investigation-orchestrator.ts` | Wires `correlate_changes` into triage |
| `src/integrations/hook-handlers.ts` | Detects mutations and auto-registers change events |
| `src/mcp/server.ts` | 2 MCP tools for Claude Code |
| `src/cli.tsx` | `runbook changes` CLI subcommands |

**Key design decision:** Types are inlined in the CLI adapter, not shared via a package. This means zero new dependencies for CLI users and no version coupling between the two repos. If you change a type in this service, you must manually update the adapter types in the CLI repo.

## Architecture

```
Webhook Ingestion ──► SQLite Store ◄── Query API (REST)
(GitHub, AWS)         (changes.db)     (Fastify)
       │                   │
       ▼                   ▼
Change Correlator    Blast Radius Analyzer
(weighted scoring)   (graph BFS traversal)
       │                   │
       └───── Service Dependency Graph ─────┘
              (in-memory, loaded from YAML)
```

**Stack:** Fastify 5, better-sqlite3, Zod, TypeScript (strict). No external databases, message queues, or cache layers.

## File Map

```
src/
├── backstage-client.ts ← Backstage catalog client + entity→graph conversion.
├── types.ts            ← All domain types. THE canonical source of truth.
├── store.ts            ← SQLite store with FTS5. Pattern: better-sqlite3 + WAL mode.
├── service-graph.ts    ← In-memory dependency graph. Extracted from CLI's graph-store.ts.
├── graph-loader.ts     ← YAML/JSON graph loading + graph merge logic.
├── correlator.ts       ← Incident correlation with weighted scoring.
├── blast-radius.ts     ← Impact prediction via upstream graph traversal.
├── server.ts           ← Fastify setup, decorations, entry point.
├── routes/
│   ├── events.ts       ← CRUD + query for change events.
│   ├── correlate.ts    ← POST /api/v1/correlate
│   ├── blast-radius.ts ← POST /api/v1/blast-radius
│   ├── velocity.ts     ← GET /api/v1/velocity/:service
│   ├── graph.ts        ← Graph import, list, dependencies, Backstage sync.
│   └── webhooks/
│       ├── github.ts   ← GitHub deployment/push/PR → ChangeEvent
│       ├── aws.ts      ← AWS CodePipeline/ECS/Lambda → ChangeEvent
│       ├── agent.ts    ← Coding agent (Claude Code, Copilot, Cursor) → ChangeEvent
│       ├── gitlab.ts   ← GitLab push/MR/deployment/pipeline → ChangeEvent
│       ├── terraform.ts← Terraform Cloud run notifications → ChangeEvent
│       └── kubernetes.ts← K8s events (forwarded from cluster agents) → ChangeEvent
└── __tests__/
    ├── store.test.ts        (19 tests)
    ├── correlator.test.ts   (6 tests)
    ├── blast-radius.test.ts (7 tests)
    ├── routes.test.ts       (17 tests)
    └── webhooks.test.ts     (21 tests)
```

## Critical Implementation Details

### 1. ImpactPath `hops` includes the source node

In `service-graph.ts`, `getUpstreamImpact()` and `getDownstreamImpact()` build paths starting with `[serviceId]` and append each hop. So a 1-edge traversal produces `hops = 2` (source + neighbor), not 1.

**Consequence in blast-radius.ts:** Direct dependents are identified by `path.hops <= 2`, not `path.hops === 1`. If you change the traversal logic, update the blast radius classification.

### 2. Criticality uses weakest-link semantics

`mergeCriticality()` in `service-graph.ts` picks the **least critical** edge along a path, not the most critical. The logic is `order[a] >= order[b] ? a : b` where `{critical: 0, degraded: 1, optional: 2}`.

This means a critical→optional chain has criticality `optional`, because the weakest link determines the path's effective criticality. This was a bug that was caught during testing — the original implementation picked the most critical (min), which made every path through a critical service show as critical regardless of downstream edges.

### 3. Store velocity uses two separate queries

`getVelocity()` in `store.ts` runs two queries: one with `GROUP BY change_type` for type counts, and a separate one for raw timestamps to compute average intervals. Originally this was a single query which produced incorrect counts.

### 4. FTS5 search tokenization

The `search()` method wraps each word in `"word"*` (prefix match) joined by `OR`. Single-character tokens are filtered out. The FTS5 virtual table indexes `summary` and `service` fields, synced via INSERT/DELETE/UPDATE triggers.

### 5. Velocity trend uses inclusive upper bound

`getVelocityTrend()` uses `timestamp <= ?` for the period end (not `<`). This ensures events at exactly the period boundary are included.

### 6. Graph merge precedence

In `graph-loader.ts`, `mergeGraph()` gives precedence to config-defined nodes/edges. If a node ID or edge (source→target) already exists in the base graph, the incoming graph's version is silently dropped. Each node/edge carries `metadata.source: 'config' | 'discovered' | 'inferred'` to track its origin.

### 7. Fastify decorations

The server extends Fastify with four decorations: `store`, `serviceGraph`, `correlator`, `blastRadiusAnalyzer`. All route handlers access these via `fastify.store`, etc. The TypeScript module augmentation is in `server.ts`.

### 8. GitHub webhook verification is optional

If `GITHUB_WEBHOOK_SECRET` is not set, signature verification is skipped entirely. When set, it uses HMAC-SHA256 with `timingSafeEqual` to prevent timing attacks.

### 9. Auto-blast-radius on event creation

When a change event is POSTed to `/api/v1/events`, the server automatically computes blast radius if the service graph has nodes. The prediction is attached to the stored event.

## Correlation Scoring Model

| Factor | Weight | Method |
|--------|--------|--------|
| Time proximity | 40% | `e^(-t/30)` — exponential decay, half-life ~30min |
| Service overlap | 35% | Direct match=1.0, 1-hop graph neighbor=0.7, 2-hop=0.4 |
| Change risk | 15% | Blast radius risk: critical=1.0, high=0.8, medium=0.5, low=0.2 |
| Change type | 10% | deployment=1.0, config_change=0.9, feature_flag=0.8, db_migration=0.85, infra_modification=0.7, code_change=0.65, rollback=0.6, scaling=0.5, security_patch=0.4 |

The correlator expands affected services to 2-hop graph neighbors before querying the store. This means a change to service C will still be found if the incident affects service A and A→B→C exists in the graph.

## Blast Radius Risk Levels

| Level | Condition |
|-------|-----------|
| `critical` | Any impact path has criticality `critical` |
| `high` | >10 downstream services OR >3 direct dependents |
| `medium` | >3 downstream OR >1 direct, OR `db_migration` with any dependents |
| `low` | Everything else |

## Service Graph Population — Three Layers

1. **Config-driven (implemented):** YAML file loaded on startup via `CHANGE_INTEL_GRAPH_PATH`. This is the primary mechanism today.
2. **Backstage catalog import (implemented):** `POST /api/v1/graph/import/backstage` fetches entities from a Backstage instance and converts them to our graph model. Supports cursor-based pagination, optional filters (namespaces, lifecycles, types, systems), and non-destructive merge via `mergeGraph()`.
3. **Auto-discovery (stubbed):** `POST /api/v1/graph/discover` returns 501. Future: AWS/K8s service enumeration + dependency inference.
4. **Change event inference (stubbed):** `GET /api/v1/graph/suggestions` returns empty. Future: co-deployment and co-failure pattern analysis to suggest edges.

## Domain Types Quick Reference

- **ChangeType:** `deployment`, `config_change`, `infra_modification`, `feature_flag`, `db_migration`, `code_change`, `rollback`, `scaling`, `security_patch`
- **ChangeSource:** `github`, `gitlab`, `aws_codepipeline`, `aws_ecs`, `aws_lambda`, `kubernetes`, `claude_hook`, `agent_hook`, `manual`, `terraform`
- **ChangeInitiator:** `human`, `agent`, `automation`, `unknown`
- **ChangeStatus:** `in_progress`, `completed`, `failed`, `rolled_back`

The `agent` initiator is the key differentiator — this service is designed to track changes made by AI agents (Claude, Copilot, etc.) alongside human and CI/CD changes.

## Database Schema

Single table `change_events` with indexes on: `timestamp`, `service`, `change_type`, `environment`, `status`, `commit_sha`. JSON columns stored as TEXT: `additional_services`, `files_changed`, `config_keys`, `blast_radius`, `tags`, `metadata`. WAL mode enabled for concurrent reads.

FTS5 virtual table `change_events_fts` on `summary` + `service`, kept in sync via triggers.

## Testing Patterns

- **Store tests:** Create temp DB files, clean up in `afterEach`. Never share state between tests.
- **Correlator/blast-radius tests:** Build graph fixtures (chain: A→B→C, hub-and-spoke) in-memory, seed store with test events at known timestamps.
- **Route tests:** Use Fastify's `inject()` — no real HTTP server. Create server with in-memory DB (`:memory:` or temp file), seed data, assert responses.
- **Framework:** Vitest with `globals: true` and `node` environment.

## API Routes (all under `/api/v1/`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/events` | Create change event (auto-computes blast radius) |
| GET | `/events` | Query with filters (services, change_types, sources, environment, since, until, initiator, status, q, limit) |
| GET | `/events/:id` | Get by ID |
| PATCH | `/events/:id` | Update fields |
| DELETE | `/events/:id` | Delete |
| POST | `/correlate` | Correlate changes with incident |
| POST | `/blast-radius` | Predict blast radius |
| GET | `/velocity/:service` | Change velocity (single window or trend) |
| POST | `/graph/import` | Import graph (JSON config or export format) |
| POST | `/graph/import/backstage` | Import from Backstage service catalog |
| GET | `/graph/services` | List all services in graph |
| GET | `/graph/dependencies/:service` | Dependencies + dependents for a service |
| POST | `/graph/discover` | Auto-discovery (stub, returns 501) |
| GET | `/graph/suggestions` | Inferred relationships (stub, returns []) |
| POST | `/webhooks/github` | GitHub webhook |
| POST | `/webhooks/aws` | AWS EventBridge webhook |
| POST | `/webhooks/agent` | Coding agent webhook (Claude Code, Copilot, Cursor) |
| POST | `/webhooks/gitlab` | GitLab webhook (push, MR, deployment, pipeline) |
| POST | `/webhooks/terraform` | Terraform Cloud run notifications |
| POST | `/webhooks/kubernetes` | Kubernetes events (forwarded from cluster agents) |
| GET | `/health` | Health check with store + graph stats |

## Stubbed Features (Not Yet Implemented)

These are designed but not built. The endpoints exist and return appropriate stub responses:

1. **Auto-discovery** (`POST /graph/discover`): Should enumerate AWS services (ECS, Lambda, RDS, ElastiCache) and K8s resources, infer dependencies from ALB target groups, security groups, service mesh config.
2. **Relationship inference** (`GET /graph/suggestions`): Should analyze co-deployment patterns (services deployed within 5min of each other >3 times) and co-failure patterns to suggest graph edges. Inferred edges should carry `metadata.inferred: true` and a confidence score.
3. **Additional webhooks**: PagerDuty.
4. **Event TTL**: `pruneOlderThan(days)` exists in the store but no cron/scheduler calls it.

## Common Pitfalls

- **Changing traversal in service-graph.ts?** Update the `hops <= 2` check in `blast-radius.ts` and the hop distance checks in `correlator.ts`.
- **Adding a new ChangeType or ChangeSource?** Update `types.ts`, the Zod schemas in route handlers, and the `CHANGE_TYPE_SCORES` map in `correlator.ts`.
- **Adding a new webhook?** Follow the pattern in `routes/webhooks/github.ts`: parse provider payload into a `ChangeEvent`-shaped object, call `fastify.store.insert()`, register the route plugin in `server.ts`.
- **Modifying the store schema?** Update `initSchema()`, `insert()`, `update()` field map, `rowToEvent()`, and all query methods that reference the changed columns.
- **JSON columns:** `additional_services`, `files_changed`, `config_keys`, `blast_radius`, `tags`, `metadata` are stored as JSON strings. Always `JSON.stringify()` on write, `JSON.parse()` on read. The `rowToEvent()` method handles this.
