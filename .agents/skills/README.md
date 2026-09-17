# Skills

This index is a quick orientation aid. Each skill's frontmatter remains the
routing source of truth.

- `interpret-event-storming`: parse a new or updated Event Storming image into the
  canonical board transcription (`references/event-storming.md`), recording any
  architecture-required implementation mapping separately from board evidence.
- `protobuf-style`: apply Access Desk conventions whenever creating or editing a
  `.proto` contract under `packages/*/model/proto`, including file layout,
  documentation, entity options, and append-only schema evolution.
- `spine-handlers`: choose the right Spine decorator
  (`@Assign`/`@Command`/`@React`/`@Subscribe`) and wire an aggregate, projection,
  or process manager under `packages/*/server/src`, avoiding the framework
  gotchas (value-object ids, `ok`-acking rejections, the same-server saga
  delivery gap).
