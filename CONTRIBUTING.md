# Contributing

Thanks for your interest in contributing to the Change Intelligence Service.

## Getting started

```bash
git clone git@github.com:Runbook-Agent/change-intelligence.git
cd change-intelligence
npm install
npm test
```

Requires **Node.js 20+**.

## Development workflow

1. Create a branch from `main`
2. Make your changes
3. Run `npm test` and `npm run typecheck`
4. Open a PR against `main`

## Code structure

```
src/
├── types.ts            Domain types (ChangeEvent, BlastRadiusPrediction, etc.)
├── store.ts            SQLite store (better-sqlite3 + FTS5)
├── service-graph.ts    In-memory service dependency graph
├── graph-loader.ts     YAML/JSON graph loading and merge
├── correlator.ts       Change-to-incident correlation scoring
├── blast-radius.ts     Graph-based impact prediction
├── server.ts           Fastify server setup and entry point
├── routes/
│   ├── events.ts       CRUD + query endpoints
│   ├── correlate.ts    Correlation endpoint
│   ├── blast-radius.ts Prediction endpoint
│   ├── velocity.ts     Velocity metrics endpoint
│   ├── graph.ts        Graph management endpoints
│   └── webhooks/
│       ├── github.ts   GitHub webhook handler
│       └── aws.ts      AWS EventBridge handler
└── __tests__/
    ├── store.test.ts
    ├── correlator.test.ts
    ├── blast-radius.test.ts
    └── routes.test.ts
```

## Guidelines

### Writing code

- **TypeScript strict mode** is on. No `any` unless truly unavoidable.
- **Zod** for all request validation. Never trust raw input.
- **Parameterized queries** for all SQL. Never interpolate user input.
- Keep dependencies minimal. This service intentionally has a small footprint.

### Writing tests

- Tests live in `src/__tests__/`.
- Use temp SQLite files (cleaned up in `afterEach`) — never share state between tests.
- Route tests use Fastify's `inject()` — no real HTTP server needed.
- Aim for behavioral tests over implementation tests.

### Adding a new route

1. Create `src/routes/your-route.ts` exporting an async Fastify plugin function
2. Register it in `src/server.ts`
3. Add Zod validation for the request body
4. Add tests in `src/__tests__/routes.test.ts`

### Adding a new webhook

1. Create `src/routes/webhooks/provider.ts`
2. Parse the provider-specific payload into a `ChangeEvent`-shaped object
3. Call `fastify.store.insert()` with the parsed data
4. Add signature verification if the provider supports it
5. Register in `src/server.ts`

## Commit messages

Use a short imperative subject line describing the change:

```
Add Kubernetes webhook handler
Fix correlation scoring for multi-service changes
Update blast radius risk thresholds
```

## Reporting issues

Open an issue at https://github.com/Runbook-Agent/change-intelligence/issues with:

- What you expected
- What happened
- Steps to reproduce
- Node.js version and OS
