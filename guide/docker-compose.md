# Run with Docker Compose

For hosts: the quickest way to run SimpleArchitecture, with its own PostgreSQL 17, on one machine. For other container hosts, see [Hosting the image](hosting.md).

## What you need

- A machine with Docker and Docker Compose.
- Your own OpenID Connect provider that can send roles or groups in the ID token. No provider is included. See [Sign-in and roles](sign-in.md).
- A domain name for the app, and an https proxy on the machine, such as Caddy or nginx. The app expects to be served at `https://<APP_DOMAIN>`.

## Set it up

The repository's `deploy/compose/` folder holds `compose.yaml` and `example.env`. Copy that folder to the server, then:

1. Copy `example.env` to `.env` in the folder and fill in every value: the image version, the port, `APP_DOMAIN`, a database password, and your own OpenID Connect provider's settings. Keep `.env` private: it holds the secrets. What each app setting means is in [Hosting the image](hosting.md#settings).
2. Register `https://<APP_DOMAIN>/auth/callback` as the redirect address with your provider.
3. Start it:

   ```sh
   docker compose up -d
   ```

   The app waits for the database, runs the migrations and then answers `http://127.0.0.1:<APP_PORT>/api/health` with `{"status":"ok"}`.

4. Put an https proxy in front, such as Caddy or nginx, that serves `https://<APP_DOMAIN>`, forwards to `127.0.0.1:<APP_PORT>` and sets `X-Forwarded-For` and `X-Forwarded-Proto`. The port is open to this machine only: never expose it directly (see [Behind the https proxy](hosting.md#behind-the-https-proxy)).

Then open `https://<APP_DOMAIN>` and sign in. To try the app with made-up data, sign in as an Admin and import `samples/sample-insurance.jgf.json` (from the repository) on **Admin → Models**.

## The settings file

`example.env` lists every setting, with a placeholder to replace:

| Setting                                                                         | Value                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `SIMPLEARCHITECTURE_VERSION`                                                    | The image version to run, such as `1.2.3`: a release, never `latest` (there is none)                                      |
| `APP_PORT`                                                                      | The port on this machine that your https proxy forwards to                                                                |
| `APP_DOMAIN`                                                                    | The domain only, as your https proxy serves it                                                                            |
| `POSTGRES_PASSWORD`                                                             | The database password, for PostgreSQL and the app. Letters and digits only, as it goes into a URL: `openssl rand -hex 32` |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`                           | Your provider's issuer, client id and client secret                                                                       |
| `SESSION_SECRET`                                                                | At least 32 random characters, not the client secret: `openssl rand -base64 48`                                           |
| `OIDC_ROLES_CLAIM`, `OIDC_ROLE_ADMIN`, `OIDC_ROLE_MODELLER`, `OIDC_ROLE_VIEWER` | The ID token claim that holds the roles, and the value in it for each role                                                |

Write each value without quotes, and with no comment after it. Compose stops with a message naming any setting that is missing. The app's `DATABASE_URL` is built from `POSTGRES_PASSWORD`; nothing secret is in `compose.yaml`.

## How it runs

- The app and PostgreSQL share one network, so the app reaches the database on `127.0.0.1`. Either can restart on its own.
- The app runs with a read-only file system, no Linux capabilities and no new privileges.
- Both have health checks, and the app starts only once the database is ready.
- The app's port is published on `127.0.0.1` only, for your https proxy.

## Data, backups and upgrades

The data is in the volume `simplearchitecture_db-data`. It survives restarts, upgrades and `docker compose down`; only `docker compose down -v` deletes it.

To back up the database:

```sh
docker compose exec -T db pg_dump -U simplearchitecture simplearchitecture > backup.sql
```

To upgrade, back up the database, read the [release notes](releases/), change `SIMPLEARCHITECTURE_VERSION` in `.env` and run `docker compose up -d` again. There is no downgrade: to go back, restore the backup and start the older version.

PostgreSQL is pinned to version 17. A new major version of PostgreSQL needs a dump and restore.
