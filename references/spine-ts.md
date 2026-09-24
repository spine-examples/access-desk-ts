# Spine TS Application Reference

## Source of truth

Access Desk consumes published Spine TS npm packages.

Use one exact compatible family. Do not use unqualified npm versions or mix
snapshots. Before relying on an API, inspect in this order:

1. the exact installed package's declarations, README, generated metadata, and
   runnable examples;
2. the matching local `spine-ts` checkout at the same snapshot/commit, using
   its references and examples.

Record the resolved package path and version/commit in implementation evidence.
If neither source establishes an API, treat it as a blocker; do not infer a call
from another Spine language, an older snapshot, or memory.

The most useful `spine-ts` sources are:

- `docs/USER_GUIDE.md`
- `packages/proto/{README.md,REFERENCE.md}`
- `packages/proto-tools/{README.md,REFERENCE.md}`
- `packages/core/{README.md,REFERENCE.md}`
- `packages/server/{README.md,REFERENCE.md}`
- `packages/storage-datastore/{README.md,REFERENCE.md}`
- `packages/auth/{README.md,REFERENCE.md}`
- `packages/client-web/{README.md,REFERENCE.md}`
- `packages/client-react/{README.md,REFERENCE.md}`
- `packages/testing/{README.md,REFERENCE.md}`

Do not copy `workspace:*` dependencies from examples. Replace them with exact
published versions.

## Expected packages

Use only packages required by the implemented slice. The anticipated family is:

| Responsibility                               | Package                                 |
| -------------------------------------------- | --------------------------------------- |
| Bounded contexts, entities, handlers, server | `@spine-event-engine/server`            |
| Spine Proto contracts/options                | `@spine-event-engine/proto`             |
| Model and handler generation                 | `@spine-event-engine/proto-tools`       |
| Type registry, type URLs, `Any` helpers      | `@spine-event-engine/core`              |
| Common storage contract                      | `@spine-event-engine/storage`           |
| Google Cloud Datastore adapter               | `@spine-event-engine/storage-datastore` |
| Gateway authentication primitives            | `@spine-event-engine/auth`              |
| Same-server command client                   | `@spine-event-engine/client-node`       |
| Browser client                               | `@spine-event-engine/client-web`        |
| React hooks/provider                         | `@spine-event-engine/client-react`      |
| Black-box tests                              | `@spine-event-engine/testing`           |

Application model and runtime code also use the exact compatible
`@bufbuild/protobuf` family selected by the snapshot. Verify peer/dependency
requirements rather than guessing versions.

## Workspace and model structure

Use a pnpm workspace with independently buildable context model packages. A
reasonable starting shape is:

```text
packages/
  identity/{model,server}/
  resources/{model,server}/
  app/
  web/
```

Each bounded context is two packages. Its `model` package owns canonical
`.proto` sources and an authored `spine-proto.json` in `mode: "model"`. Its
`server` package holds the decorated handlers and the `BoundedContext` factory
and is in `mode: "application"`, because `spine-proto handlers` discovers
decorated classes only in the package that runs it; each context therefore
composes its own model subset and generates its own handler registry. The
top-level `app` package is also `mode: "application"`: it composes the complete
application TypeRegistry from every context model and assembles the server. The
accompanying `spine-proto-manifest.json` is generated output, not an authored
file; commit it if the examples do, but never hand-edit it.

Generate dependencies first. From each affected `mode: "model"` package, in
dependency order, run generation from that package's working directory:

```sh
(cd packages/resources/model && spine-proto generate)
```

After the required model manifests exist, generate each affected context's
handlers from its `server` package, then compose the complete application
TypeRegistry from the `app` package:

```sh
(cd packages/resources/server && spine-proto compose)
(cd packages/resources/server && spine-proto handlers)
(cd packages/app && spine-proto compose)
```

Re-run generation in dependency order after a change: a model's `generate` after
its `.proto` or `spine-proto.json` changes; the affected `server`'s `compose` +
`handlers` (and the `app`'s `compose`) after any model manifest change; a
`server`'s `handlers` after its decorated handler source changes. Repository pnpm
scripts should expose this sequence. Generated sources, manifests, registries,
declarations, and build output are never hand-edited.

For one model to import another's `.proto` (e.g. Resources using Identity's
`PersonId`, or Access referencing Resources types), add the producer package to
the consumer model's `spine-proto.json` `dependencies` **and** to its
`package.json` `dependencies`, then `pnpm install`; declare
transitive proto deps too (Access declares both Resources and Identity).
Reference cross-package types by full proto path (`accessdesk.identity.PersonId`).
Authored helper TS (e.g. enum-option accessors) lives in a model's `src/`; add
`src/**/*.ts` to that package's tsconfig `include` and an `exports` subpath.

Keep the entity identifier as the first field of command and entity state when
the default target is correct. Use exact routing only when the first-field route
is not the domain target. Put query/sort `(column)` options only on fields
actually used by application queries.

Validation failures and domain rejections are different. Define generated
rejections for valid commands that violate business rules and let the framework
roll back the transition. Do not implement business rejection as arbitrary
transport exceptions. **A business rejection acks `ok`, not `error`** — command
delivery is deferred through the entity inbox, so a thrown generated rejection
fires asynchronously and never reaches the post outcome. Validation errors ack
`error` synchronously; business rejections do not.

**Declare every rejection a command handler may throw with `@Throws(Companion)`**
— the generated rejection companion, e.g. `@Throws(ResourceNameAlreadyUsed)`, on
the `@Assign`/`@Command` method. The runtime refuses an _undeclared_ thrown
rejection, so a handler's `@Throws` must list all of them. A declared rejection
becomes a first-class produced signal, so a client can **subscribe to the
rejection type directly**. Prove a rejection in BlackBox by subscribing to its type,
posting the offending command (which still acks `ok`), and asserting the rejection
is delivered. (`box.assertEvents()` does not include rejection events; subscribe.)

## Bounded contexts and handlers

Choose `BoundedContext.singleTenant()` or `.multitenant()` explicitly. Access
Desk uses a single-tenant Identity context and a multitenant Resources context.

Use generated handler metadata with bare `@Assign`, `@Command`, `@React`, and
`@Subscribe` decorators. Aggregates protect one consistency boundary;
Projections build query-side state; Process Managers coordinate domestic
multi-entity workflows. Application handlers return generated messages and do
not open or commit storage transactions manually.

**Decorator contract** (the first parameter is the trigger signal; the return
type is what the handler produces). Choosing wrongly costs real time, so pick
from this table rather than guessing:

| Decorator    | Trigger → produces             | Valid on      | The semantic that bites                                                                                |
| ------------ | ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------ |
| `@Assign`    | command → event(s)             | Aggregate, PM | **Only `@Assign` makes a command postable** (adds it to `acceptedCommandTypes`); must return ≥1 event. |
| `@Command`   | event **or** command → command | PM            | Command **reaction / substitution**. Does **not** register its trigger as a postable command.          |
| `@React`     | event → event(s)               | PM            | Domestic event reactor (produces events, never commands).                                              |
| `@Subscribe` | event → `void` (mutates state) | Projection    | Read-model / process state update; use `External<T>` on the parameter for a cross-context event.       |

Entity inbox replay uses the normal handler path, so effects must be replay-safe.
Process Manager outputs must not be the only irreplaceable source of a critical
public fact.

**Async handlers and read-side reads from a Process Manager.** A handler may be
`async` and return `Promise<Event>`; the runtime awaits it and the generator
accepts the async form. From inside a Process Manager handler, read a projection
with the protected `this.select(StateSchema, columns)` query
(`byId`/`where`/`mask`/`orderBy`/`limit`, then async `read()`/`findById()`/
`all()`). It is bound only during the handler, uses that signal's actor and
tenant, is read-only, and is eventually consistent — a best-effort cross-entity
check, not a lock. Pass `columns` as `{}` for an id-only read. Caveat:
`findById`/`byId` are typed `EntityQueryIdentifier<Schema>`, which resolves to
`never` for a message id whose generated field is optional (all of them), so
either cast the id (`findById(orgId as never)`) or `read()` and match in TS.

**Default event routing** targets by the event's `producerId` first (when it is
type-compatible with the consuming entity's id field), then falls back to the
event's first field. Custom routing is `.add(EntityClass, { eventRouting })` with
`EventRouting.create<Id>().route(Schema, (event) => [id, …])`. Custom
`commandRouting` (`.add(EntityClass, { commandRouting })` with
`CommandRouting.create<Id>().route(Schema, (command) => id)`) works the same way
and is needed when a command's target-entity id is **not** its first field.

**Message references and copying (`clone`).** protobuf-es never deep-copies a
nested message: both `create(Schema, { field: msg })` and `draft.field = msg`
store the _same_ reference as `msg`, and inbound signals (`this.id`, an event's or
command's fields) are framework-owned and must be treated as read-only.
`clone(schema, msg)` (from `@bufbuild/protobuf`) is the only call that yields an
independent copy. The decision is one question: _will this borrowed sub-message be
mutated in place after I attach it?_

- **No clone** when the value is read-only or emitted-then-forgotten: a command or
  event routing callback returning an id (`route(Schema, (c) => [c.orgId])` — the
  framework only reads it to compute the target key), a field read or comparison,
  producing an event/command with `create(...)` (the message is serialized and
  emitted, never mutated), or a one-shot `this.update` assignment
  (`draft.id = event.id ?? this.id`) that is assigned and then returned.
- **Clone** (or rebuild with `create`) only before you _mutate a borrowed
  sub-message in place_ — e.g. keeping an inbound `event.policy` in entity state
  and later bumping a field on it, or assigning a borrowed message into a `draft`
  and then mutating that same object. The clone severs the shared reference so the
  in-place edit cannot corrupt the inbound signal or committed state.

Prefer constructing fresh messages with `create(...)` over mutating borrowed ones;
do that consistently and `clone` is almost never needed. Copies of one-field id
messages are cheap — the choice is about correctness and clarity, not performance.
Note: `!` non-null assertions on optional proto fields fail lint
(`no-non-null-assertion`); guard with `=== undefined` instead, which also handles
the field-absent case the assertion silently ignores.

**Diagnosing a swallowed command error.** A failed post that is neither a
validation nor a transition error surfaces as a generic
`{ type: "COMMAND_POST_ERROR", message: "Command post failed." }` with the real
error and stack discarded (`ServiceValues.commandPostError` fallback). To see the
true cause, temporarily log in the `catch` of `#post` in
`@spine-event-engine/server/dist/services/spine-services.js` (revert after) — do
not commit or leave `node_modules` edits. This is how the single-field-id and
`UNSUPPORTED_COMMAND` causes above were found.

## External events

Mark a cross-context event receptor with direct first-parameter
`External<T>`. External commands are invalid. The built-in IntegrationBroker:

- exports only event types requested by another context;
- filters domestic and external origin to prevent loops;
- has no durable inbox, retry, replay, deduplication, cursor, fencing, or
  producer election;
- is therefore a best-effort typed context boundary, not the complete
  production delivery guarantee.

A single-tenant producer's event has no tenant, while a multitenant entity
handler requires one. Global Identity events therefore pass through the
documented durable tenant fan-out adapter, which derives tenant-scoped
integration facts. Do not wire a raw single-tenant Identity event directly to a
multitenant Resources handler.

## Protobuf Any and type registries

Use the Spine core `Any`/TypeRegistry helpers verified against this exact
snapshot. The server application composes the complete generated TypeRegistry;
do not depend on runtime package scanning or mutable global schema registration.

The stateful `Scheduling` Process Manager accepts only registered and
application-allowlisted **command** schemas. The allowlist maps `{type URL, purpose}`
to a fixed command schema and target route, independently of the payload.
Validate and unpack the command before the process sends it through the application-supplied,
tenant-aware same-server client. The stored `Any` must not carry credentials or
establish trusted tenant/actor identity, and cannot select an endpoint, context,
actor, or tenant. Unknown, incompatible, or unpacking-failed values fail closed
and never become arbitrary command execution.

**Reading Protobuf enum custom options** (the "enum with `EnumValueOptions`
extension" pattern): `getOption` from `@bufbuild/protobuf`,
`getOption(EnumSchema.values.find((v) => v.number === n), extension)`. Comparing
`v.number` (plain number) to an enum member trips
`@typescript-eslint/no-unsafe-enum-comparison`; assign the member to a `number`
local first. Pick an extension field number outside Spine's `73800`–`73971`
block (Spine leaves `EnumValueOptions` free).

## Datastore

Construct `DatastoreStorageFactory` with an application-owned configured Google
Datastore client. Multitenant contexts use Datastore native namespaces derived
reversibly from `TenantId`; a bounded-context name is diagnostic and does not
itself partition kinds.

When stored framework/application values contain `Any`, build the required
stringifier registry with the complete application TypeRegistry. Keep query
values typed; do not pre-stringify them in application code.

The adapter has a finite reconciliation ceiling and does not provide unlimited
scan semantics. Declare and deploy application composite indexes for actual
filter/order combinations. Exercise them with the Datastore-mode emulator and
use a disposable cloud project for any explicitly authorized cloud smoke test.

## Authentication and browser clients

Spine bounded contexts do not authenticate browser credentials. Build one
application gateway with `@spine-event-engine/auth`. It resolves a verified
session, authorizes the operation, reconstructs trusted `ActorContext` including
tenant, and forwards approved commands, queries, and subscriptions without
forwarding the credential.

Use `@spine-event-engine/client-web` for an explicit gRPC-Web or configured
Connect endpoint. The client does not probe/fallback between protocols and does
not retry commands. Use `@spine-event-engine/client-react` only for React query
and subscription lifecycle; it is not a cache, router, or authentication system.

Subscriptions are best-effort notices. Entity subscriptions need an
authoritative query for reconnect/gap recovery. Command validation remains
server-side.

The gateway, not a bounded context, performs OIDC/session/CSRF/origin controls
defined in the architecture. Internal Scheduling ingress uses a distinct trusted
principal and never reuses a browser session or accepts caller-provided tenant,
route, or actor claims.

## Testing boundaries

`BlackBox` tests one built bounded context through a local server and the public
client boundary. Use it for command outcomes, rejections, queries, and local
subscriptions. Use bounded `eventually()` only for genuinely asynchronous
visibility, not for immediate command results.

BlackBox alone does not prove browser behavior, cross-process delivery,
authentication, Datastore deployment, or multi-context choreography. Those need
separate integration and end-to-end tests listed in
`references/architecture.md`.

BlackBox tests import the context from compiled `dist/` (`await
import("../dist/src/index.js")`) because vitest cannot execute Spine's standard
decorators from raw TS source; the root `vitest.config.ts` externalizes `dist`
so handler classes keep the identity the registry registered. Multitenant
BlackBox: pass `{ tenant }` to `BlackBox.from`.

**Testing an `External<T>` subscription** posts the producing fact directly to
the consumer's BlackBox actor scope: `await box.onBehalfOf("producer")
.postExternalEvent(EventSchema, create(EventSchema, {...}))`. The scope retains
the BlackBox tenant, actor, zone, and timestamp; the event is marked external,
reaches only external handlers, and is not recorded as a context-produced
event. Build multitenant consumers with `BlackBox.from(ctx, { tenant })`
and use `box.eventually(query)` when the read-side projection is asynchronous.
In this snapshot, `postExternalEvent()` omits `producerId`; a consumer repository
that would otherwise use default event routing must declare exact `EventRouting`
routes for the tested external schemas.
