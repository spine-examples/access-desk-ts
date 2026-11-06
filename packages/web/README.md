# Access Desk web client

The page people work in Access Desk through.

| Page            | What it shows                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `/sign-in`      | Signing in, through Google.                                                                                           |
| `/`             | Leads a member to their organization. A person in no organization yet signs in again once an administrator adds them. |
| `/organization` | The organization: its name, the person's role in it, and its members with their roles.                                |

The session lasts while the browser tab is open, and closing the tab ends it.

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

It answers `/config.json` with its own address, so the page calls it, and the
browser sees one address. `ACCESS_DESK_API_HOST` and `_PORT` are not used here.

In production, a hosting service serves the built page instead, and its
`/config.json` gives the application's own address, `ACCESS_DESK_API_HOST` and
`_PORT`. [`deploy/README.md`](../../deploy/README.md) lays it out so on this
machine.

## HTTPS

Google sends people back only to an HTTPS address, so the page is served over
HTTPS. Make a certificate for this machine once:

```sh
pnpm --dir packages/web run cert
```

It is kept in `.certs/`, which Git ignores, and is valid for `localhost` and
`127.0.0.1` only, so `ACCESS_DESK_WEB_HOST` and `ACCESS_DESK_API_HOST` must be
one of them. [`deploy/README.md`](../../deploy/README.md) uses the same certificate.
It is self-signed, so the browser warns about it once for each address. A certificate
this machine trusts, such as one `mkcert` makes, saves the warnings.

Register `https://<ACCESS_DESK_WEB_HOST>:<ACCESS_DESK_WEB_PORT>/`, with the
trailing `/`, with Google as an authorized redirect address of the OAuth client.
