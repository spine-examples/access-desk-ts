# Access Desk

A demo-sized access request and approval application built
on [Spine TS](https://github.com/SpineEventEngine/spine-ts).

Organizations grant their members time-bounded access to resources. A member
requests access, a manager of the resource approves or rejects it, and the
access lasts until it ends or a manager revokes it. Every decision is kept in
an audit trail.

## Status

Under development. People sign in through Google and read their
organization. Requests, approvals, and grants work in the application server,
and the web client does not show them yet.

## How it is built

| Folder                                     | What it is                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| [`packages/identity`](packages/identity)   | The Identity bounded context: people, their accounts, and their memberships.                                        |
| [`packages/resources`](packages/resources) | The Resources bounded context: organizations, resources, requests, and grants.                                      |
| [`packages/app`](packages/app/README.md)   | The application server, and the gateway browsers call it through.                                                   |
| [`packages/web`](packages/web/README.md)   | The web client.                                                                                                     |
| [`packages/testing`](packages/testing)     | The setup the tests of the application server and the bounded contexts share.                                       |
| [`deploy`](deploy/README.md)               | The Docker images and the Compose file that run every program in a container of its own, laid out as in production. |

## Development

### Prerequisites

- Node.js 24 or newer.
- pnpm 11.9 or newer.
- Docker with Compose 2.30 or newer.

### Set it up

1. Install the workspace:

   ```sh
   pnpm install
   ```

2. Copy [`.env.example`](.env.example) to `.env` and fill in every setting.
   Every program reads its settings from there. Besides the database, the
   gateway needs:
   - a Google OAuth client, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`;
   - the session key, `ACCESS_DESK_SESSION_KEY`, which this prints:

     ```sh
     pnpm --dir packages/app run session-key
     ```

   - the forwarding proof key, `ACCESS_DESK_FORWARDING_PROOF_KEY`, which this
     prints:

     ```sh
     pnpm --dir packages/app run forwarding-proof-key
     ```

3. Make the certificate of the page and the application once:

   ```sh
   pnpm --dir packages/web run cert
   ```

4. Register `https://<ACCESS_DESK_WEB_HOST>:<ACCESS_DESK_WEB_PORT>/`, with the
   trailing `/`, as an authorized redirect address of the Google OAuth client.

### Check the workspace

Start PostgreSQL, then build, typecheck, lint, and test:

```sh
pnpm run postgres:start
```

```sh
pnpm run verify
```

### Run it in containers

Every program runs in a container of its own, laid out as in production: the
page at one address, the application at another. Build the images and start
the containers:

```sh
pnpm run containers:start
```

[`deploy/README.md`](deploy/README.md) describes how to open the page, stop and
remove the containers, and how they are laid out.

### Run each program on this machine

For development without containers, start the application server and the
gateway as [`packages/app/README.md`](packages/app/README.md) describes, and
the web client as [`packages/web/README.md`](packages/web/README.md) describes.

## Documentation

- [Product Requirements Document](PRD.md).
- [Event Storming board](https://miro.com/app/board/uXjVHu7F0ng=).
- [Architecture and domain invariants](references/architecture.md).

## Contributing

Contributions are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md)
for contribution guidelines and the CLA.

## License

Apache 2.0.
