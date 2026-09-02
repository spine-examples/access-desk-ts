---
name: protobuf-style
description: >
  Formatting and style conventions for Access Desk Protobuf files. Use whenever
  creating or editing any `.proto` under `packages/*/model/proto`.
  Regenerate after any change; never hand-edit generated output.
---

# Protobuf Style

Conventions for every `.proto` in
`packages/<context>/model/proto/access_desk/<context>/`.

## File layout (in this order)

1. Single-line `//` copyright header (see below).
2. blank line, then `syntax = "proto3";`
3. blank line, then `package access_desk.<context>;`
4. blank line, then imports — one per line (`google/...` first, then `spine/...`
   and cross-file `access_desk/...`).
5. blank line, then `option (type_url_prefix) = "type.access-desk.<context>";`
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
// Copyright 2026, TeamDev. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Redistribution and use in source and/or binary forms, with or without
// modification, must retain the above copyright notice and the following
// disclaimer.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
```

(TypeScript/JS files keep the conventional `/* */` block — the `//` rule is
proto-only.)

## `type_url_prefix`

`type.access-desk.<context-name>` — e.g. `type.access-desk.resources`. Present
only in files that declare messages.

## Documentation comments

Use `//` line comments (never `/** */`). Document every message and every field.

- **The first line is a single concise sentence** describing what the element is.
  Never put two sentences on the first line.
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
  OrganizationId id = 1 [(validate) = true];
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

- Split contracts by role: `identifiers.proto`, `commands.proto`, `events.proto`,
  `rejections.proto`, and a state file per entity (e.g. `organization.proto`).

## Message & field options

- The entity id is the **first field** of both the command and the entity state;
  default command routing uses it. Keep it first.
- ID types are wrapper messages: `OrganizationId { string value = 1 [(required) = true]; }`.
- Aggregate state: `option (entity).kind = AGGREGATE;`, id
  `[(validate) = true, (set_once) = true]`.
- Projection state: `option (entity).kind = PROJECTION;` and
  `option (entity).visibility = FULL;`; put `(column) = true` only on fields that
  real queries filter or sort by.
- Rejections live in `*rejections.proto`; the model then depends on
  `@spine-event-engine/core`.

## Evolution & generation

- **Append-only.** Never reuse or renumber a field number or enum value; on
  removal, reserve the number **and** the name inside the owning message/enum.
- **Never hand-edit generated output** (`generated/`, `spine-proto-manifest.json`).
  Regenerate via the pipeline after any `.proto` change (`pnpm run generate`, or
  `pnpm run verify`). Generated files intentionally carry no copyright header.
