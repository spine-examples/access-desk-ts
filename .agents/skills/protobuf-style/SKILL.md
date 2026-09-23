---
name: protobuf-style
description: >
  Formatting and style conventions for Access Desk Protobuf files. Use whenever
  creating or editing any `.proto` under `packages/*/model/proto`.
  Regenerate after any change; never hand-edit generated output.
---

# Protobuf Style

Conventions for every `.proto` in
`packages/<context>/model/proto/accessdesk/<context>/`.

## File layout (in this order)

1. Single-line `//` copyright header (see below).
2. blank line, then `syntax = "proto3";`
3. blank line, then `package accessdesk.<context>;`
4. blank line, then imports — one per line (`google/...` first, then `spine/...`
   and cross-file `accessdesk/...`).
5. blank line, then `option (type_url_prefix) = "type.accessdesk";`
6. blank line, then the messages.

- **2-space** indentation.
- One blank line right after a message's opening `{`, before the first field or
  field comment. A message-level `option` (e.g. `(entity).kind`) goes immediately
  after `{` with **no** blank line before it.
- `option (type_url_prefix)` needs `import "spine/options.proto";`, so it appears
  only in files that declare messages.

## Copyright header — single-line `//`

Use `//` line comments, **not** a `/* */` block. Open and close with a bare `//`:

```proto
//
// Copyright 2026 CodeMatters, Lda.
//
// Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
// except in compliance with the License. You may obtain a copy of the License at
//
// https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software distributed under
// the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
// either express or implied. See the License for the specific language governing permissions
// and limitations under the License.
//
```

(TypeScript/JS files keep the conventional `/* */` block — the `//` rule is
proto-only.)

## `type_url_prefix`

Use the shared prefix `type.accessdesk` in every file that declares messages.
Do not append a bounded-context, package, or other type suffix.

## Documentation comments

Use `//` line comments (never `/** */`). Document every message and every field.

**Describe the domain first, the software second — or not at all.** Say what the
thing _is_ in the business: a resource is "a protected internal source people
request access to"; an organization is "the boundary that owns resources and
grants access within it"; a policy is "the rules that govern access". Never lead
with the storage or framework mechanism ("stores the aggregate state", "the
read-side projection", "coordinates the process manager"). Mechanism detail
(routing, tenancy, delivery) belongs _after_ the domain sentence, or in the
handler code — never in place of it. This holds for TS entity/handler doc
comments too, not only `.proto`.

- **The first line is a single concise sentence** describing what the element is
  in the domain. Never put two sentences on the first line.
- **A process manager's state message (and any workflow) lists its steps as a
  numbered list** — `1.` … `2.` … `3.` — after the opening sentence, describing
  the domain steps, not the handlers.
- Any further detail follows in later paragraphs, each separated by a blank `//`
  line.
- **If the documentation is more than one line, end it with a blank `//` line**
  before the declaration. A single-line doc has **no** trailing blank `//`.
- Keep comments concise.

Multi-line doc (trailing `//`):

```proto
// Creates a new organization.
//
// The organization is its own tenant; the command is issued in that
// organization's tenant scope.
//
message CreateOrganization {

  // The identifier of the organization to create.
  OrganizationId id = 1;
}
```

Single-line doc (no trailing `//`):

```proto
// Records that an organization was created.
message OrganizationCreated {
  // ...
}
```

## File naming

- Split contracts by role **and by aggregate/purpose**, not one file per role.
  Every entity-owned filename includes the entity's full name even when its
  directory already carries that name: `organization.proto`,
  `organization_commands.proto`, `organization_events.proto`, and
  `organization_rejections.proto`; `resource_registration.proto` rather than
  `registration.proto`. Shared `identifiers.proto` and `values.proto` are the
  exceptions. Group a command/event with the aggregate that handles/emits it
  (`AddResource` and `ResourceAdded` are the Organization's, so they live in the
  `organization_*` files). The framework classifies by the `_commands`,
  `_events`, and `_rejections` suffixes, so those suffixes are load-bearing.
- **Where an enum lives.** A plain enum goes in the general shared file with the
  value objects it serves (`values.proto`). Give an enum its own file only when
  it is _special_ — carrying custom options and helper logic. Rule of
  thumb: options → own file; optionless → the general file.
- **Nested messages.** A value message used only as the repeated element of one
  entity's state (a queue's task, a list's row) is declared **inside** that state
  message, not at package top level. Generated TS names it `Parent_Child` with
  schema `Parent_ChildSchema`; its type URL becomes `pkg.Parent.Child`. Keep a
  message top-level when more than one entity uses it, or when it is a
  command/event/rejection field shared across files.

## Identity as a command field

The acting person is an explicit `PersonId` field on the command (the requester
on a submit command, the deciding manager on approve/deny) — not read from the
`CommandContext` actor. Keep the entity id first; the acting-person field comes
right after it. Handlers then read `command.<field>` (see the `spine-handlers`
skill).

## Field naming & order

- **`snake_case`** field names.
- **Repeated fields use the singular noun**, never the plural — `repeated
  AccessLevel access_level`, `repeated OrganizationMember membership` (not
  `access_levels` / `memberships`). The generated TS accessor is the singular
  camelCase name holding an array.
- **Order fields logically, not by when they were added:** identity first, then
  name, then descriptive fields (description, category), then classification and
  policy (sensitivity, access levels, duration), then people (owner, approvers).
  A related family of messages (`RequestResourceCreation`, `CreateResource`, the
  state, the created event) shares the same order. While a contract is not
  deployed, renumber freely to keep the order sensible.

## Message & field options

- The entity id is the **first field** of both the command and the entity state;
  default command routing uses it. Keep it first.
- An ID type can be a **primitive or any value object** — one or
  more fields, as rich as the identity needs. **Name each field for what it
  holds:** `uuid` for an opaque, system-generated id, `value` for a human-readable
  dash-case slug, or a composite of several fields for a naturally compound identity.
- Aggregate state: `option (entity).kind = AGGREGATE;`.
- Do not put `(validate)` on ID-typed fields. Presence may still be expressed
  with `(required)` where the contract requires it.
- Do not use `(set_once)` on any field.
- Projection state: `option (entity).kind = PROJECTION;` and
  `option (entity).visibility = FULL;`; put `(column) = true` only on fields that
  real queries filter or sort by.
- Rejections live in `*rejections.proto`; the model then depends on
  `@spine-event-engine/core`.

## Evolution & generation

- Until the first deployed compatibility baseline, keep fields and enum values
  in sequential numeric order after every change.
- **Never hand-edit generated output** (`generated/`, `spine-proto-manifest.json`).
  Regenerate via the pipeline after any `.proto` change (`pnpm run generate`, or
  `pnpm run verify`). Generated files intentionally carry no copyright header.
