---
name: write-tests
description: >
  Add or change server-side tests under `packages/*/server/test`. Use whenever
  writing a `BlackBox` test for an aggregate, projection, or process manager,
  laying out a context's test files and `given/`, asserting an emitted
  event or a business rejection, or deciding between an isolated and an
  integration test.
---

# Write Tests

Mirror `packages/resources/server/test`. See `references/spine-ts.md` for
`BlackBox` mechanics.

## File layout — one test file per implementation file

Mirror the model's domain directories under `test/`. For example, access-request
tests live under `test/access/request/`, resource tests under `test/resource/`,
and organization tests under `test/organization/`.

**Name each test file exactly after the `src/` file it exercises**, appending
`.test.ts` — `organization-view-projection.ts` →
`organization-view-projection.test.ts`, `access-request-process.ts` →
`access-request-process.test.ts`.

Each process manager also gets one `…-process.integration.test.ts` — the only
file that inserts `.integration` before `.test.ts`.
See **Integration tests** below for what it covers.

Do **not** keep per-flow or per-scenario files. Aggregate rules live
in the aggregate test; the end-to-end flow lives in the one integration test.

`describe` naming: `describe("<Entity> should", () => describe("handle
'<Command|Event>', and", () => it("emit '<Event>' …" | "reject … with
'<Rejection>'")))`.

## `given/` — fixtures

A **fixture** arranges domain state for a test and reads it back; it is specific
to one entity or context. Each domain directory has a `given/` with **one fixture
file per entity** — that entity's command posters, value builders, and read-model
reads. The context-wide fixture lives in `test/given/`:

- `<context>-context.ts` — context loading, BlackBox setup, shared identifiers,
  and common reads (`readAll`, `testActorContext`).

Fixtures are not helpers: a fixture knows the domain (it seeds an organization,
posts a request), whereas a helper (below) knows nothing about it.

## Helpers

A **helper** is a generic, domain-agnostic utility reused across every context —
it arranges no domain state. Reuse these instead of re-implementing them per test:

- `test/given/event-recording.ts` — `eventRecording(actorContext)` returns
  `{ recordEvents, expectRejection }`. Bind it once per context with that
  context's `testActorContext`:
  `const { recordEvents, expectRejection } = eventRecording(testActorContext);`.

## Observe outcomes through produced facts

A command handler's outcome is a produced **event**, and a `@Throws` rejection is
a produced event too — the command still acks `ok`. So never assert a business
rejection through the post outcome.

- **Assert an event:** `await recordEvents(scope, EventSchema)` **before** posting
  (this activates the subscription), then `recorder.waitFor(box, (e) => …)`.
- **Assert a rejection:** `expectRejection(box, scope, RejectionSchema, () => post…)`
  — it subscribes, runs the act (asserting the ack is `ok`), and returns the
  rejection.

## Isolate aggregates and projections

Aggregate and projection tests **post the entity's own commands directly**,
bypassing the process manager, so the handler is exercised alone with an
already-valid input. Drive a projection by posting the aggregate command that
emits the event it subscribes to. These isolated tests carry every
single-handler rule and rejection.

## Integration tests

Write an integration test only for a **process manager** — the choreography that
spans several entities. Aggregates and projections never get one; posting their
own commands directly already covers them fully.

An integration test posts the process's **entry command** and lets the real
choreography run — every command reaction, cross-entity fact, compensation, and
read-side projection — then reads the outcome back through client queries,
waiting with bounded `box.eventually(...)` for asynchronous delivery. It proves
what the isolated tests cannot: that the entities actually wire together end to
end.

Cover **complete process scenarios — one full run per distinct outcome** the
process can reach:

- the **happy path** — the process runs to its successful terminal fact;
- each **alternate outcome** — a compensation or rollback (e.g. a duplicate name
  deletes the half-created resource and reports failure), or a second successful
  flow (e.g. an extension/renewal instead of a first grant).

Keep it to the smallest set that reaches every distinct outcome — two in the
current model (happy path + one alternate). Do not re-test aggregate rules or
single-handler rejections here; those live in the isolated tests.

## Runner

`vitest.config.ts` sets `fileParallelism: false` and 30s timeouts because each
`BlackBox` test starts its own in-process server — keep them. Give every query a
fixed id and reach for `box.eventually` only for genuinely asynchronous reads.
