---
name: spine-handlers
description: >
  Implement or fix a Spine TS handler — an Aggregate, Projection, or Process
  Manager and its decorated methods — under `packages/*/server/src`. Use whenever
  choosing a decorator (`@Assign`/`@Command`/`@React`/`@Subscribe`), wiring a
  command→event→projection slice, an external subscription, or a same-server
  saga.
---

# Spine Handlers

Pick the decorator and wiring from the rules below instead of reverse-engineering
the framework source. `references/spine-ts.md` (Bounded contexts and handlers)
is the authoritative reference; this skill is the fast path plus the traps.

## Choose the decorator

First parameter = trigger signal; return type = what it produces.

| Decorator    | Trigger → produces             | Valid on      |
| ------------ | ------------------------------ |---------------|
| `@Assign`    | command → event(s)             | Aggregate, PM |
| `@Command`   | event **or** command → command | PM            |
| `@React`     | event → event(s)               | PM            |
| `@Subscribe` | event → `void` (mutates state) | Projection    |

Cross-context receptor: `External<T>` (from `@spine-event-engine/server`) as
the **first** parameter, e.g. `@Subscribe onX(e: External<SomeEvent>)`.

## Wire a slice

1. Author the `.proto`: mark entity state `option (entity).kind = AGGREGATE |
   PROJECTION | PROCESS_MANAGER` (use the `protobuf-style` skill). The entity id
   is the **first field**; a message id can be a primitive wrapper or any value
   object.
2. Generate the model, then write the decorated class in `packages/<ctx>/server/src`.
3. Register it in the context factory: `.add(EntityClass)` (or
   `.add(EntityClass, { eventRouting })` for exact routing). Re-run the context
   `server`'s `compose` + `handlers`.
4. Prove it with a `BlackBox` test importing the context from `dist/` (see
   `references/spine-ts.md`, Testing boundaries).

## Copying messages (`clone`)

protobuf-es never deep-copies a nested message — `create(Schema, { field: msg })`
and `draft.field = msg` both keep the **same reference** as `msg`, and inbound
signals (`this.id`, an event's or command's fields) are framework-owned and must
be treated as read-only. `clone(schema, msg)` is the only independent copy. One
question decides it: _will this borrowed sub-message be mutated in place after I
attach it?_

| Scenario                                                           | Clone?                                              |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| Routing callback returns an id (`route(S, (c) => [c.orgId])`)      | no — read-only; guard `undefined`, don't `!`        |
| Field read or comparison (`event.person.uuid`)                     | no                                                  |
| Produce an event/command (`create(EventSchema, { id: this.id })`)  | no — serialized then emitted, never mutated         |
| One-shot `this.update((d) => { d.id = event.id ?? this.id })`      | no — assigned then returned                         |
| Store a borrowed sub-message in state you later mutate in place    | **yes** — clone on store (or rebuild with `create`) |
| Mutate a borrowed sub-message after attaching it                   | **yes** — clone first                               |

Rule of thumb: **clone only right before mutating a borrowed sub-message in
place**; routing, reads, emit-then-forget, and one-shot assignment need none.
Prefer building fresh messages with `create(...)` over mutating borrowed ones —
then `clone` is almost never needed. Also: `!` on an optional proto field fails
lint (`no-non-null-assertion`); use an `=== undefined` guard, which also handles
the field-absent case the assertion silently ignores. Depth in
`references/spine-ts.md` (Bounded contexts and handlers).

## Traps that cost time (avoid all of these)

- **Business rejections ack `ok`.** Delivery is deferred; a thrown generated
  rejection fires async and never reaches the post outcome. Prove it by no-change
  + fence, not by the ack. Validation errors ack `error`.
- **Clean build after cross-package contract changes.** `tsc -b` won't recompile
  a dependent when only a dependency's generated types changed; force-rebuild or
  wipe `dist`/`*.tsbuildinfo` before trusting `verify`.
- **Swallowed `COMMAND_POST_ERROR`.** A failed post hides its real cause behind a
  generic ack; temporarily log in the `catch` of `#post` in
  `@spine-event-engine/server/dist/services/spine-services.js` to see it, then
  restore `node_modules`. Never commit or leave those edits.
