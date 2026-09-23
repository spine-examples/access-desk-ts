---
name: write-tests
description: >
  Add or change server-side tests under `packages/*/server/test`. Use whenever
  writing a `BlackBox` test for an aggregate, projection, or process manager,
  laying out a context's test files and `given/` helpers, asserting an emitted
  event or a business rejection, or deciding between an isolated and an
  integration test. `packages/resources/server/test` is the reference layout.
---

# Write Tests

Mirror `packages/resources/server/test`. See `references/spine-ts.md` for
`BlackBox` mechanics.

## File layout — one file per entity, plus one process integration

Mirror the model's domain directories under `test/`. For example, access-request
tests live under `test/access/request/`, resource tests under `test/resource/`,
and organization tests under `test/organization/`:

- `<entity>-aggregate.test.ts` — every command handler, its emitted event, and
  each `@Throws` rejection and business rule.
- `<entity>-projection.test.ts` — the state built for each subscribed event (add
  and remove/clear).
- `<process>-process.test.ts` — each process-manager handler observed through the
  facts it emits and the rejections it throws (a PM has no queryable state).
- `<process>-process.integration.test.ts` — the whole choreography end to end,
  **exactly two cases**: the happy path (drive it, read the result back through
  client queries) and one alternate path (a compensation, or a second flow such
  as renewal).

Do **not** keep per-flow or per-scenario files (e.g. a separate "decision" or
"extension" file). Aggregate rules live in the aggregate test; end-to-end flow
lives in the one integration test. Remove the rest.

`describe` naming: `describe("<Entity> should", () => describe("handle
'<Command|Event>', and", () => it("emit '<Event>' …" | "reject … with
'<Rejection>'")))`.

## `given/` — entity and context fixtures

Each domain directory has a `given/` directory with one fixture file per entity.
Keep the context fixture under `test/given/`:

- `<context>-context.ts` — context loading, BlackBox setup, shared identifiers,
  and common reads.

## Reuse the local helpers

Reuse these instead of re-implementing them per test:

- `src/proto/equals.ts` — `equals(schema, a, b)` for value-message equality
  (a production helper, also handy in assertions).
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

## Isolate vs. integrate

- **Aggregate / projection tests post the entity's own commands directly**,
  bypassing the process manager, so the handler is exercised alone with an
  already-valid input. Drive a projection by posting the aggregate command that
  emits the event it subscribes to.
- **Integration tests post the entry command** and let the full choreography run,
  waiting with bounded `box.eventually(...)` for asynchronous delivery.

## Runner

`vitest.config.ts` sets `fileParallelism: false` and 30s timeouts because each
`BlackBox` test starts its own in-process server — keep them. Give every query a
fixed id and reach for `box.eventually` only for genuinely asynchronous reads.
