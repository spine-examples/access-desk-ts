# Access Desk web client

The page people work in Access Desk through, built with React and Vite. It is
the frontend, and calls the backend: the gateway and the application server
behind it.

| Page            | What it does                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `/`             | Sends a signed-out person to `/sign-in` and a member to `/organization`; tells a person in no organization to sign in again once added. |
| `/sign-in`      | Signs a person in through Google.                                                                                                       |
| `/organization` | Shows the organization's name, the person's role in it, and its members with their roles.                                               |

## Configuration

The web client reads the address of the backend (`apiUrl`) when it opens, not when
it is built. Before anything else, it fetches `/config.json` from its own
address:

```json
{
  "apiUrl": "https://<ACCESS_DESK_API_HOST>:<ACCESS_DESK_API_PORT>"
}
```

Without that answer, the page does not start.

If the address were baked into the build, each environment would need a build
of its own. Read at runtime, it lets one build run at any address.

Each server of the web client answers `/config.json` in its own way:

- the development server gives its own address and forwards the calls to the
  gateway running on this machine, so `ACCESS_DESK_API_HOST` and `_PORT` are
  not used there;
- a hosting service gives the address of the backend, from `ACCESS_DESK_API_HOST`
  and `ACCESS_DESK_API_PORT`, as [`deploy/README.md`](../../deploy/README.md)
  lays it out on this machine.

## Signing in and session

People sign in through Google with PKCE. Before sending the browser to Google,
the web client saves a one-time secret, and the backend accepts the code Google
sends back only together with that secret. A stolen code alone signs nobody in.

After signing in, the backend gives the web client a session token. The web client
keeps it in the browser tab and checks it with the backend each time the page
opens. The token lasts eight hours or until the person signs out, and closing
the tab forgets it.

## Reading data

The web client reads the organization through the framework's gRPC-Web client
and its React bindings: one client per organization, with the session token on
every call. The page does not subscribe to changes yet.

## Run it

1. Start PostgreSQL, the application server, and the gateway, as
   [`packages/app/README.md`](../app/README.md) tells.
2. Make a certificate for this machine, once, as [HTTPS](#https) tells.
3. Start the development server:

   ```sh
   pnpm --dir packages/web run dev
   ```

The development server reads four settings of `.env`, in the root of the
repository, and refuses to start without any of them or without the
certificate:

| Setting                                                | What it is for                                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `ACCESS_DESK_WEB_HOST`, `ACCESS_DESK_WEB_PORT`         | Where it serves the page, over HTTPS.                                                  |
| `ACCESS_DESK_GATEWAY_HOST`, `ACCESS_DESK_GATEWAY_PORT` | Where it passes the page's calls on, to `/auth/` and `/spine.client.`, to the gateway. |

## HTTPS

The page is served over HTTPS, as in production. Make a certificate for this
machine once:

```sh
pnpm --dir packages/web run cert
```

It is kept in `.certs/`, which Git ignores, and is valid for `localhost` and
`127.0.0.1` only, so `ACCESS_DESK_WEB_HOST` and `ACCESS_DESK_API_HOST` must be
one of them. [`deploy/README.md`](../../deploy/README.md) uses the same
certificate. It is self-signed, so the browser warns about it once for each
address. A certificate this machine trusts, such as one `mkcert` makes, saves
the warnings.

Register `https://<ACCESS_DESK_WEB_HOST>:<ACCESS_DESK_WEB_PORT>/`, with the
trailing `/`, with Google as an authorized redirect address of the OAuth client.
