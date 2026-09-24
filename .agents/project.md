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

| Context    | Owns                                                                                                                                    | Tenancy                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| Identity   | Global users, registration, auth identity                                                                                               | Global / single-tenant   |
| Resources  | Organizations, membership, resources, policy, managers, requests, approvals, grants, extensions, revocation, scheduling, audit projections | Org-scoped (multitenant) |

Resources owns the whole request-and-approval domain. What earlier drafts split
into separate Access, Scheduling, and Audit contexts is now internal to
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
  app/                                # composition root: complete registry + (later) Server assembly, gateway, fan-out
  web/                                # React + Vite browser client (later iterations)
```

- **`<context>/model`** — `@access-desk/<context>-model`, `spine-proto.json` `mode: "model"`.
  Canonical `.proto` under `proto/accessdesk/<context>/` plus the generated
  `ProtoModule`; pure wire contracts, no behavior. Resources subdivides its protos
  into per-area folders (`organization/`, `resource/`, `access/request/`), each its
  own sub-package under `accessdesk.resources.*`, with shared `identifiers.proto`
  and `values.proto` at the top level (filename conventions in the `protobuf-style` skill).
- **`<context>/server`** — `@access-desk/<context>-server`, `spine-proto.json`
  `mode: "application"`. Its `src/` and `test/` directories mirror the model's
  domain folders; only the context factory, public index, and context-wide test
  helpers remain at their roots. It holds decorated handlers (aggregates,
  projections, process managers), its `create<Context>Context()` factory, and
  BlackBox tests. It is an _application_ package because
  `spine-proto handlers` discovers decorated classes only in the package that runs it.
- **`app`** — `@access-desk/app`, `mode: "application"`, composes **both** context
  models into the complete application `TypeRegistry`; will assemble the `Server`
  (`Server.add(ctx)` per context), the gateway, and the Identity→tenant fan-out.
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
- `pnpm run test` — builds, then a single central `vitest run` from the root.
- `pnpm run verify` — build → typecheck → typecheck:tests → lint → test. **This is the gate.**
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
- **They import the context from compiled `dist/`** (`await import("../dist/src/index.js")`)
  because vitest cannot execute Spine's standard decorators from raw TypeScript source.
- The **root `vitest.config.ts`** is the only vitest config: it includes all packages'
  `test/**`, and externalizes `dist` (`server.deps.external`) so the handler registry's
  classes keep the same identity as the classes the context registers (otherwise the
  registry lookup fails with "missing metadata").
- Multitenant BlackBox: pass `{ tenant }` to `BlackBox.from`; assert the immediate
  command ack directly and use `box.eventually(...)` only for async read-side visibility.

## Dependencies

- One exact Spine family pinned at **`@spine-event-engine/* 2.0.0-snapshot.11`** with
  `@bufbuild/protobuf 2.12.1`. Never invent an API. Keep the whole family on one
  version; upgrade it together in a dedicated task.

## Conventions

**Documentation is domain-only.** Proto message and field comments state the
business meaning in plain language. They do not describe handlers, routing,
storage, queries, generated code, or other implementation mechanics. Keep them
short; see the `protobuf-style` skill.

Message-copying rules live in the `spine-handlers` skill and
`references/spine-ts.md`.
