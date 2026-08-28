# Spine TS Application Reference

## Source of truth

Access Desk consumes published Spine TS npm packages.

Use one exact compatible family, initially `2.0.0-snapshot.2`. Do not use
unqualified npm versions or mix snapshots. Before relying on an API, inspect in
this order:

1. the installed package and its declarations/README;
2. the package references and runnable examples in that checkout.

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

| Responsibility | Package |
| --- | --- |
| Bounded contexts, entities, handlers, server | `@spine-event-engine/server` |
| Spine Proto contracts/options | `@spine-event-engine/proto` |
| Model and handler generation | `@spine-event-engine/proto-tools` |
| Type registry, type URLs, `Any` helpers | `@spine-event-engine/core` |
| Common storage contract | `@spine-event-engine/storage` |
| Google Cloud Datastore adapter | `@spine-event-engine/storage-datastore` |
| Gateway authentication primitives | `@spine-event-engine/auth` |
| Node client where needed | `@spine-event-engine/client-node` |
| Browser client | `@spine-event-engine/client-web` |
| React hooks/provider | `@spine-event-engine/client-react` |
| Black-box tests | `@spine-event-engine/testing` |

Application model and runtime code also use the exact compatible
`@bufbuild/protobuf` family selected by the snapshot. Verify peer/dependency
requirements rather than guessing versions.

## Workspace and model structure

Use a pnpm workspace with independently buildable context model packages. A
reasonable starting shape is:

```text
packages/
  identity-model/
  resources-model/
  access-model/
  scheduling-model/
  audit-model/
  integration-model/
  server/
  web/
```

Each bounded-context model package owns canonical `.proto` sources and an
authored `spine-proto.json` in `mode: "model"`. The application package uses
`mode: "application"` to compose the required model modules and generate one
complete application TypeRegistry and handler registry. The accompanying
`spine-proto-manifest.json` is generated output, not an authored file; commit it
if the examples do, but never hand-edit it.

Run the public tooling after the related changes:

```sh
spine-proto generate
spine-proto compose
spine-proto handlers
```

Expose these through repository pnpm scripts once scaffolding exists. Generated
sources, manifests, registries, declarations, and distribution output are never
hand-edited.

Keep the entity identifier as the first field of command and entity state when
the default target is correct. Use exact routing only when the first-field route
is not the domain target. Put query/sort `(column)` options only on fields
actually used by application queries.

Validation failures and domain rejections are different. Define generated
rejections for valid commands that violate business rules and let the framework
roll back the transition. Do not implement business rejection as arbitrary
transport exceptions.

## Bounded contexts and handlers

Choose `BoundedContext.singleTenant()` or `.multitenant()` explicitly. Access
Desk uses a single-tenant Identity context and multitenant Resources, Access,
Scheduling, and Audit contexts.

Use generated handler metadata with bare `@Assign`, `@Command`, `@React`, and
`@Subscribe` decorators. Aggregates protect one consistency boundary;
Projections build query-side state; Process Managers coordinate domestic
multi-entity workflows. Application handlers return generated messages and do
not open or commit storage transactions manually.

Entity inbox replay uses the normal handler path, so effects must be replay-safe.
Process Manager outputs must not be the only irreplaceable source of a critical
public fact.

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
documented durable tenant fan-out adapter, which derives stable tenant-scoped
integration facts. Do not wire a raw single-tenant Identity event directly to a
multitenant Resources, Access, Scheduling, or Audit handler.

## Protobuf Any and type registries

Use the Spine core `Any`/TypeRegistry helpers verified against this exact
snapshot. The server application composes the complete generated TypeRegistry;
do not depend on runtime package scanning or mutable global schema registration.

Scheduling accepts only registered and application-allowlisted event schemas.
Validate the unpacked type, tenant, target, maximum payload size, and message
family at intake and again where a durable record is released. Unknown or
incompatible type URLs fail closed and become safe operational failures, never
arbitrary command execution.

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

## Testing boundaries

`BlackBox` tests one built bounded context through a local server and the public
client boundary. Use it for command outcomes, rejections, queries, and local
subscriptions. Use bounded `eventually()` only for genuinely asynchronous
visibility, not for immediate command results.

BlackBox alone does not prove browser behavior, cross-process delivery,
authentication, Datastore deployment, or multi-context choreography. Those need
separate integration and end-to-end tests listed in
`references/architecture.md`.
