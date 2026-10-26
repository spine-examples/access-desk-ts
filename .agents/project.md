# Project

This document describes how the repository is physically organized and how to work
in it. For the domain and architecture see `references/architecture.md`;
for the Spine TS API contract see `references/spine-ts.md`.

## What it is

A demo-sized access request & approval application built with production-shaped
architecture on **Spine TS** (event-sourced, CQRS, bounded contexts).
Runtime baseline: **Node ≥ 24, pnpm 11.9, strict TypeScript, ESM**.

## Bounded contexts

Two contexts (`references/architecture.md`):

| Context    | Owns                                                                                                                                        | Tenancy                  |
| ---------- |---------------------------------------------------------------------------------------------------------------------------------------------| ------------------------ |
| Identity   | People, the accounts they sign in with, their email addresses, and the organization each belongs to | Global / single-tenant   |
| Resources  | Organizations, membership, resources, policy, managers, requests, approvals, grants, extensions, revocation, audit projections | Org-scoped (multitenant) |

Resources owns the whole request-and-approval domain. What earlier drafts split
into separate Access and Audit contexts is now internal to
Resources; the request-and-approval process reads Resources' own read models
directly rather than mirroring them.

**Organization = tenant:** every tenant-scoped message carries one `OrganizationId`
as the `TenantId`. `CreateOrganization` is issued in the tenant scope of the org it
creates, which the framework establishes on the first command.

## Workspace layout

Each context is **two packages** under `packages/<context>/`:

```text
packages/
  identity/    { model, server }      # global / single-tenant
  resources/   { model, server }
  app/                                # composition root: complete registry, organization setup, gateway
  web/                                # React + Vite browser client (later iterations)
  testing/                            # what the tests of every package share
```

- **`<context>/model`** — `@access-desk/<context>-model`, `spine-proto.json` `mode: "model"`.
  Canonical `.proto` under `proto/accessdesk/<context>/` plus the generated
  `ProtoModule`; pure wire contracts, no behavior. Resources subdivides its protos
  into per-area folders (`organization/`, `resource/`, `access/request/`, `access/grant/`),
  each its own sub-package under `accessdesk.resources.*`, with shared `identifiers.proto`
  and `values.proto` at the top level (filename conventions in the `protobuf-style` skill).
- **`<context>/server`** — `@access-desk/<context>-server`, `spine-proto.json`
  `mode: "application"`. Its `src/` and `test/` directories mirror the model's
  domain folders; only the context factory, public index, and context-wide test
  helpers remain at their roots. It holds decorated handlers (aggregates,
  projections, process managers), its `create<Context>Context()` factory, and
  BlackBox tests. It is an _application_ package because
  `spine-proto handlers` discovers decorated classes only in the package that runs it.
- **`app`** — `@access-desk/app`, `mode: "application"`, composes **both** context
  models into the complete application `TypeRegistry`. It runs as two programs:
  `src/server/` is the application server, which hosts both contexts;
  `src/gateway/` is the browser-facing gateway
  (sign-in, sessions, authorization), which reaches the server over the
  network. The gateway's own endpoints live in `src/gateway/routes/`, and
  are only for signing in and the session; everything else passes through
  as Spine requests judged by `src/gateway/policy.ts`.
  `pnpm --dir packages/app run server` and `run gateway` start each.
  Every program is configured in one `.env` in the repository root.
- **`web`** — `@access-desk/web`, the React/Vite client.

**Dependency rule:** a `server` may depend on another context's `model` (wire
contracts) but **never** on another context's `server` (behavior) — the pnpm graph
enforces that contexts interact only through published facts. Each context owns
its cross-context contracts in its own `model` and declares `External<T>`
receptors internally.

## The Spine Proto pipeline

Generation is dependency-first and reproducible from scripts (never hand-edited):

1. `generate:models` — each `model` runs `spine-proto generate` → its `ProtoModule` + `spine-proto-manifest.json`.
2. `generate:contexts` — each `server` runs `spine-proto compose` (its own registry) then `spine-proto handlers`
   (its handler registry, discovered from that package's `src`).
3. `generate:app` — `app` runs `spine-proto compose` → the complete `TypeRegistry`.

`pnpm run generate` runs all three in order. Generated output lives in each package's
`generated/` (git-ignored) plus the committed `spine-proto-manifest.json`.

## Commands (root `package.json`)

- `pnpm install`
- `pnpm run generate` — the pipeline above.
- `pnpm run build` — `pnpm -r run build` (each package generates then `tsc -b`).
- `pnpm run typecheck` — per-package `tsc -b`.
- `pnpm run lint` — per-package `eslint src test` (type-aware).
- `pnpm run test` — builds, then a single central `vitest run` from the root, with
  every test keeping its data in memory.
- `pnpm run test:postgresql` — the same tests, each in throwaway PostgreSQL
  databases made on the server of `ACCESS_DESK_DATABASE_HOST` and the rest,
  from the database `ACCESS_DESK_TEST_DATABASE` names. Needs the database
  server running.
- `pnpm run verify` — build → typecheck → typecheck:tests → lint → test. **This is the gate.**
  It runs the tests in memory only; run `pnpm run test:postgresql` as well after
  a change to storage, delivery, or anything PostgreSQL keeps.
- `pnpm run postgres:start` / `postgres:stop` / `postgres:delete` — the
  development PostgreSQL server in Docker (the `postgres` service of
  `deploy/compose.yaml`), configured from the root `.env`. `start` makes the
  databases the settings name that are missing, with
  `deploy/postgres/initdb/01-databases.sh`. `delete` also deletes its data.
- `pnpm --dir packages/app run session-key` — prints a new key for
  `ACCESS_DESK_SESSION_KEY`.
- `pnpm run format` / `format:check`.

> After changing a `model` package's contracts, `tsc -b` (incremental) will **not**
> recompile dependent packages that consume it through `node_modules` — `verify`
> can go green against stale types. Force-rebuild the dependents (`tsc -b --force`,
> or delete `dist/` + `*.tsbuildinfo`) before trusting it. See
> `references/development.md`.

## Testing model

- BlackBox tests (`@spine-event-engine/testing`) exercise one built context through a
  local server and the public client. They live under the matching domain path in
  `packages/<ctx>/server/test/`.
- **Every test can run on either storage profile.** `ACCESS_DESK_TEST_STORAGE`
  (`memory` or `postgresql`) picks one: `pnpm run test` and `verify` name
  `memory`, `pnpm run test:postgresql` names `postgresql`, and a run that names
  none, such as one from an editor, takes it from `.env`. The
  `@access-desk/testing` package (`packages/testing`, TypeScript the tests import
  as it is, with no build) gives every BlackBox, server, and gateway storage of
  its own (`@access-desk/testing/storage`) and deletes it afterwards. On
  PostgreSQL that is a new database for each, and one for each tenant of a
  multitenant context, which must be listed up front. The application's server
  tests open Resources the way the server does, through `Storage.openResources`,
  for the organizations they work in (`acme` and `globex`).
- A process that reads a projection, such as the duplicate check of an access
  request, sees what the projection shows so far. A test waits for the view it
  depends on (`approveAndAwait` waits until a request shows approved) before its
  next command; PostgreSQL delivers more slowly than memory, so a missing wait
  shows up there first.
- **They import the context from compiled `dist/`** (`await import("../dist/src/index.js")`)
  because vitest cannot execute Spine's standard decorators from raw TypeScript source.
- The **root `vitest.config.ts`** is the only vitest config: it includes all packages'
  `test/**`, and externalizes `dist` (`server.deps.external`) so the handler registry's
  classes keep the same identity as the classes the context registers (otherwise the
  registry lookup fails with "missing metadata").
- Multitenant BlackBox: pass `{ tenant }` to `BlackBox.from`; assert the immediate
  command ack directly and use `box.eventually(...)` only for async read-side visibility.
- **Time comes from Spine's `Time`.** Every Resources decision that depends on
  the current time reads `Time.currentTime()` from
  `@spine-event-engine/core/time`. Time-dependent tests pass a `ManualClock`
  (`test/given/manual-clock.ts`, a `TimeProvider`) to `resourcesBlackBox(clock)`,
  which installs it with `Time.setProvider` until the boxes are closed, and move
  it forward instead of sleeping. The framework reads the same `Time` for
  signal timestamps and delivery leases, so a test moves the clock before it
  starts watching events. A jump of more than about thirty seconds while
  events are watched stops their delivery.

## Dependencies

- One exact Spine family pinned at **`@spine-event-engine/* 2.0.0-snapshot.24`** with
  `@bufbuild/protobuf 2.12.1`. PostgreSQL storage is
  `@spine-event-engine/storage-postgres`, which brings `pg 8.23.0`; the gateway
  and the tests use the same `pg`. Never invent an API. Keep the whole family on one
  version; upgrade it together in a dedicated task.

## Conventions

**Documentation is domain-only.** Proto message and field comments state the
business meaning in plain language. They do not describe handlers, routing,
storage, queries, generated code, or other implementation mechanics. Keep them
short; see the `protobuf-style` skill.

Message-copying rules live in the `spine-handlers` skill and
`references/spine-ts.md`.
