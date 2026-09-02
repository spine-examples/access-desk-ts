# Access Desk

A demo-sized access request and approval application built
on [Spine TS](https://github.com/SpineEventEngine/spine-ts).

Organizations grant time-bounded access to resources through requests,
approvals, scheduled activation and expiration, and an immutable audit trail.

## Status

Under development.

## Development

Prerequisites: Node.js ≥ 24 and pnpm 11.9 (the exact versions are pinned in the
root [`package.json`](package.json); `corepack enable` selects the right pnpm).

Install the workspace:

```sh
pnpm install
```

Reproduce the full foundation check — regenerates the Spine Proto pipeline, then
builds, typechecks, lints, and tests every package — with a single command:

```sh
pnpm run verify
```

## Documentation

- [Product Requirements Document](PRD.md).
- [Event Storming board](https://miro.com/app/board/uXjVHu7F0ng=).

## License

Apache 2.0.
