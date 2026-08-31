# Access Desk Development Process

## Scope

This process keeps a demo-sized project production-shaped without copying the
large autonomous-release protocol of the Spine TS framework repository. It
governs planning, multi-agent coordination, implementation, review, and
verification. It does not authorize commits, pushes, deployments, external
messages, or production mutations.

## Change classification

Classify work before editing:

- **Micro:** local documentation, configuration, or behavior-preserving cleanup
  with no domain or public-contract change.
- **Standard:** one bounded behavior slice with local contracts, handlers,
  projections, UI, or tests.
- **High-risk:** new bounded context; Event Storming replacement; public/wire
  contract; tenant/security boundary; Scheduling-process `Any` intake;
  same-server command delivery; delivery strategy or Process Manager inbox
  durability; outbox/relay; persistence
  transaction/index; concurrency; idempotency; migration; or cross-context
  choreography.

Micro work may be done directly. Standard work should have one bounded
implementation owner and focused behavior tests. High-risk work starts with a
requirements/architecture pass and explicit acceptance criteria.

## Canonical change flow

1. Read only the relevant root references and source files.
2. State the behavior to change, affected bounded contexts, acceptance criteria,
   assumptions, exclusions, and failure modes.
3. For an Event Storming update, first replace the canonical current model
   snapshot — the aggregates, process managers, and their command→event
   transitions the board shows — before changing code.
4. Change shared target-command and integration Proto contracts first when the
   behavior crosses a context boundary.
5. Generate code; never patch generated output.
6. Implement one vertical behavior slice, including the projection/client
   effect needed to observe it.
7. Run deterministic focused checks before specialist review.
8. Run only the review lanes relevant to the changed risk, but record why an
   obvious lane is not applicable.
9. Return one consolidated correction batch to the current implementation
   owner; avoid rediscovering the same code in a new fixer.
10. Run the relevant completion verification once the change converges and
    report evidence and remaining limitations.

## Review lanes

Apply lanes based on changed behavior:

- **Style and maintainability:** ownership, naming, duplication, TypeScript
  structure, test quality, and forbidden context coupling.
- **Documentation:** reference accuracy, user-facing behavior, limitations,
  links, and claims versus implementation.
- **TypeScript/API/Proto:** exported types, generated/runtime agreement, schema
  evolution, message compatibility, registry composition, and accidental public
  API.
- **Performance/reliability:** concurrency, transaction boundaries, retry,
  idempotency, ordering, replay, cleanup, shutdown, bounded work, Process
  Manager reconstruction, and crash recovery.
- **Security:** tenant isolation, actor trust, authorization, `Any` allowlisting,
  payload limits and unpacking, fixed same-server routing, sensitive logging,
  session handling, resource exhaustion, and dependencies. This is required for
  a release and for any changed trust boundary.

## Verification ladder

Use the cheapest evidence that proves the current step, then broaden at
convergence:

1. generation or schema validation for changed Proto;
2. targeted typecheck/lint for the affected package;
3. deterministic unit tests;
4. affected-context BlackBox tests;
5. choreography and crash/replay tests for integration/scheduling changes;
6. gateway/browser tests for auth, subscriptions, and UI changes;
7. workspace verification profile once repository scripts exist.

Do not use arbitrary sleeps for domain-time tests. Use an injected clock and
bounded eventual assertions only for truly asynchronous propagation.

Completion reports must name the commands run, outcomes, untested boundaries,
and any follow-up decision. A passing local BlackBox test must not be described
as proof of cross-process, browser, authentication, or production Datastore
behavior.

## Repository hygiene

- Preserve `PRD.md` and unrelated `.idea`/worktree changes.
- Do not commit, push, branch, tag, or modify remotes without explicit user
  authorization.
- Do not fetch/install/upgrade dependencies merely to inspect APIs. Use installed
  sources and the matching local Spine TS checkout first; request network or
  install permission only when implementation actually needs it.
- Never store credentials, provider tokens, production identifiers, or sensitive
  Event Storming artifacts in repository guidance.
