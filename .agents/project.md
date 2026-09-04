# Project

This document describes how the repository is physically organized and how to work
in it. For the domain and architecture see `references/architecture.md`;
for the Spine TS API contract see `references/spine-ts.md`.

## What it is

A demo-sized access request & approval application built with production-shaped
architecture on **Spine TS** (event-sourced, CQRS, bounded contexts).
Runtime baseline: **Node ≥ 24, pnpm 11.9, strict TypeScript, ESM**.

## Bounded contexts

Five contexts (`references/architecture.md`):

| Context    | Owns                                                    | Tenancy                  |
| ---------- | ------------------------------------------------------- | ------------------------ |
| Identity   | Global users, registration, auth identity               | Global / single-tenant   |
| Resources  | Organizations, membership, resources, policy, approvers | Org-scoped (multitenant) |
| Access     | Requests, approvals, grants, extensions, revocation     | Org-scoped (multitenant) |
| Scheduling | Durable dispatch of allowlisted commands                | Org-scoped (multitenant) |
| Audit      | Immutable, redacted audit projections                   | Org-scoped (multitenant) |

**Organization = tenant:** every tenant-scoped message carries one `OrganizationId`
as the `TenantId`. `CreateOrganization` is issued in the tenant scope of the org it
creates, which the framework establishes on the first command.

## Workspace layout

Each context is **two packages** under `packages/<context>/`:

```text
packages/
  identity/    { model, server }      # global / single-tenant
  resources/   { model, server }
  access/      { model, server }
  scheduling/  { model, server }
  audit/       { model, server }
  app/                                # composition root: complete registry + (later) Server assembly, gateway, fan-out
  web/                                # React + Vite browser client (later iterations)
```

- **`<context>/model`** — `@access-desk/<context>-model`, `spine-proto.json` `mode: "model"`.
  Owns canonical `.proto` under `proto/access_desk/<context>/` and the generated
  `ProtoModule`. Pure wire contracts, no behavior.
- **`<context>/server`** — `@access-desk/<context>-server`, `spine-proto.json`
  `mode: "application"`. Holds the context's decorated handlers (aggregates,
  projections, process managers) in `src/`, its `create<Context>Context()` factory,
  and its BlackBox tests in `test/`. It is an _application_ package because
  `spine-proto handlers` discovers decorated classes only in the package that runs it.
- **`app`** — `@access-desk/app`, `mode: "application"`, composes **all five** context
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

## Testing model

- BlackBox tests (`@spine-event-engine/testing`) exercise one built context through a
  local server and the public client. They live in `packages/<ctx>/server/test/*.blackbox.test.ts`.
- **They import the context from compiled `dist/`** (`await import("../dist/src/index.js")`)
  because vitest cannot execute Spine's standard decorators from raw TypeScript source.
- The **root `vitest.config.ts`** is the only vitest config: it includes all packages'
  `test/**`, and externalizes `dist` (`server.deps.external`) so the handler registry's
  classes keep the same identity as the classes the context registers (otherwise the
  registry lookup fails with "missing metadata").
- Multitenant BlackBox: pass `{ tenant }` to `BlackBox.from`; assert the immediate
  command ack directly and use `box.eventually(...)` only for async read-side visibility.

## Dependencies & the local patch

- One exact Spine family pinned at **`@spine-event-engine/* 2.0.0-snapshot.2`** with
  `@bufbuild/protobuf 2.12.1`. Never invent an API.
