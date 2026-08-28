# Welcome, Agents

## Orientation

This repository is **Access Desk**, a production-shaped Spine TS demonstration
for organization-scoped resource access requests, approvals, scheduling, and
audit.

For substantive implementation, review, or documentation work, start by reading
the smallest relevant set:

- `references/architecture.md` for the canonical architecture and domain
  invariants.
- `references/event-storming.md` for the current interpreted Event Storming
  model.
- `references/spine-ts.md` for the supported Spine TS package baseline,
  framework behavior, and source-of-truth lookup order.
- `references/development.md` for change classification, delivery flow, review
  lanes, and verification.
- `PRD.md` for rough product background. Do not edit it unless the user's
  current prompt explicitly asks.

Repository-local task skills live under `.agents/skills/`.

## Progress Communication

For an active substantive task, send a concise user-facing update after every
subagent completion, verification result, review result, authorized Git
history operation, or real blocker. State the outcome, the next action, and
whether work continues. Treat subagent notifications as visible milestones,
not internal-only events, and do not wait silently while useful work can still
proceed.

## Commit and History Safety

Do not commit, push, tag, rebase, merge, cherry-pick, create branches, or
otherwise write to Git history unless the user's current prompt explicitly asks
for it.

Authorization does not carry over between turns or sessions. When in doubt,
leave changes unstaged, show the diff or summarize it, and let the user decide.

When moving or renaming tracked files, use `git mv` so file history is
preserved.

## Safety Rules

- Preserve unrelated changes and dirty-worktree content. `PRD.md` and
  `.idea/**` may contain user-owned work.
- Do not add secrets, credentials, provider tokens, service-account keys,
  production identifiers, or sensitive Event Storming artifacts.
- Do not deploy, mutate production or cloud resources, change infrastructure,
  or contact external systems unless the current task explicitly requires and
  authorizes it.
- Do not add analytics, telemetry, tracking, or hidden background work without
  an explicit product requirement.
- Do not update dependencies outside a dedicated implementation or upgrade
  task. Keep every `@spine-event-engine/*` dependency on the exact compatible
  `2.0.0-snapshot.2` family until a verified upgrade is approved.
- Never invent a Spine API. Inspect installed package declarations and
  documentation, then the matching Spine TS checkout or examples.
- Do not manually edit generated Protobuf sources, handler registries,
  TypeRegistry output, manifests, declarations, build output, or coverage
  output. Change authored sources and regenerate.

## Model Allocation and Existing Roles

Use Standard speed. Keep Fast mode disabled and do not use Max or Ultra
reasoning in the normal delivery cycle. The root orchestrator defaults to
`gpt-5.6-sol` with `medium` reasoning.

Use only the roles configured in `.codex/config.toml` and
`.codex/agents/*.toml`; do not invent, rename, merge, or replace project roles:

- `requirements_splitter`: `gpt-5.6-sol` / `high`, only for
  architecture-significant requirements, Event Storming reconciliation,
  public or serialized contracts, domain semantics, or a demonstrated
  architectural block.
- `implementer`: `gpt-5.6-terra` / `medium`, for ordinary TypeScript
  implementation, fixes, bounded refactoring, and correction batches.
- `style_maintainability_reviewer`: `gpt-5.6-terra` / `high`.
- `documentation_reviewer`: `gpt-5.6-luna` / `medium`.
- `typescript_api_docs_reviewer`: `gpt-5.6-terra` / `high`.
- `performance_reliability_reviewer`: `gpt-5.6-terra` / `high`.
- `security_reviewer`: `gpt-5.6-terra` / `high`, as the final security lane
  when the change affects trust boundaries or release readiness.

Deterministic builds, tests, typechecking, linting, log triage, and repository
scans are orchestrator-dispatched functions, not new agent identities. When the
execution surface supports delegating such a function without creating a
project role, use `gpt-5.6-luna` / `low`, or `medium` when classification or
version-specific judgment is required.

Always set the model and reasoning explicitly when dispatching a subagent; do
not allow the parent profile to become an accidental default. Before accepting
child work, confirm its configured role and expected profile. Record actual
runtime metadata when the surface exposes it; lack of child self-introspection
alone does not invalidate a result. Redispatch when a required field was
omitted, the wrong role was selected, or a visible fallback or profile mismatch
occurred.

At the beginning of multi-agent work, confirm that the selected execution
surface supports the required profiles and explicit child dispatch. Escalate to
`gpt-5.6-sol` / `high` only for high-risk architecture or correctness ambiguity,
or after a lower-cost profile cannot establish the answer. Run one such
architecture pass for an approved work wave and repeat it only after a material
contract change or a demonstrated architectural blocker.

## Multi-Agent Work

Subagents are configured in `.codex/config.toml` and `.codex/agents/`. The
project sets no lower numerical concurrency cap than the execution surface;
use available capacity only where ownership and dependency boundaries make the
work independent. Subagents must not spawn further agents.

- Use the requirements splitter only for new bounded contexts, public or wire
  contracts, domain semantics, tenancy, scheduling, delivery strategy,
  persistence, concurrency, idempotency, migration, or a demonstrated
  architectural block.
- Give one implementer ownership of a bounded writable slice. Only one
  production-code writer may own overlapping files at a time.
- Keep shared Proto modules, registries, workspace manifests, integration
  envelopes, and root references under one explicit writer.
- Parallelize only independent read-only discovery, documentation or API
  verification, test analysis, and bounded specialist review lanes.
- Use separate worktrees only for genuinely independent write-heavy streams.
- Return confirmed findings to the current implementation owner while that
  context is available; do not create a fresh fixer merely to rediscover it.
- Collect one complete applicable review wave, then return one consolidated
  correction batch to the existing implementation owner.
- Preserve unrelated user changes and dirty-worktree content throughout agent
  work.

## Implementation and Review Cycle

1. Classify the change as micro, standard, or high-risk using
   `references/development.md`. Record behavior-focused acceptance criteria and
   assumptions in proportion to that class.
2. Use deep requirements or architecture planning only for a new subsystem or
   bounded context, public or serialized contracts, domain semantics,
   transaction/concurrency/idempotency behavior, or a demonstrated
   architectural block.
3. The root orchestrator may implement a micro task directly. Standard and
   high-risk tasks use one bounded implementation owner and focused behavior
   tests.
4. Run deterministic mechanical checks before specialist review. Persist or
   summarize scripts-first evidence before asking a reviewer to classify an
   ordinary failure.
5. Invoke only configured review concerns relevant to the changed behavior.
   Record a disposition for every applicable concern; an N/A disposition needs
   a concrete reason.
6. Collect the complete review wave, aggregate accepted findings, and send one
   correction batch to the current implementation owner. Re-review only
   concerns substantively affected by the correction; deterministic or
   record-only fixes do not reopen unrelated lanes.
7. Run the cheapest relevant preflight before expensive integration or broad
   verification. Use repository scripts that actually exist, and run the broad
   profile once after convergence rather than as a diagnostic loop.
8. Keep reviewer inputs concern-specific. Run deterministic documentation,
   generated-output, and coverage checks before asking an agent to reason about
   those results.
9. Record acceptance evidence, resolved findings, remaining limitations, and
   the next action, then continue automatically while the task remains in
   scope.

Keep narrow TSDoc and behavior claims current with each runtime slice. Defer
broad documentation and all-example execution until affected interfaces are
stable unless a changed public interface requires earlier updates. Do not stop
for routine implementation choices; stop only for a real authorization,
high-risk ambiguity, safety, or external-state blocker.

## Verification and Quality

Never mark a non-trivial change complete without fresh verification. Choose the
smallest command that proves the touched behavior, then broaden when shared
behavior, generated contracts, persistence, or context choreography changes.

The application workspace has not yet established a stable root command set.
Use the scripts in the current `package.json` and the nearest package README
once scaffolding exists; do not invent commands. Follow the verification ladder
in `references/development.md`, including Proto generation/schema checks,
targeted typecheck/lint, unit tests, affected-context Spine `BlackBox` tests,
integration/scheduler recovery tests, and gateway/browser tests as applicable.

A local `BlackBox` pass proves one local bounded context only. It does not
prove browser behavior, cross-process delivery, authentication, or production
Datastore behavior.

If verification cannot be run, state the reason and the unverified boundary in
the final response.

## Code Review

For reviews, lead with findings ordered by severity and include file/line
references. Focus on correctness, regressions, domain-invariant violations,
tenant/security risks, wire compatibility, delivery/replay hazards, and missing
tests.

Skip routine review of generated or vendored files, including:

- generated Protobuf, handler-registry, TypeRegistry, manifest, and declaration
  output;
- `dist/**`, `coverage/**`, and other build artifacts;
- dependency/vendor directories;
- IDE metadata such as `.idea/**`.

Do not skip authored `.proto` files, `spine-proto.json`, workspace manifests,
Datastore indexes, integration envelopes, gateway authorization, or
bounded-context import boundaries.

## Asking Questions

Ask at most one clarification question at a time. Prefer a reasonable,
documented assumption when the answer would not materially change the next
implementation step.
