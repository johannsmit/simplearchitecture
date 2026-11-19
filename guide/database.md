# Database

For hosts: how to set up the PostgreSQL database SimpleArchitecture keeps everything in: models, views, sessions, settings and the audit trail. [Run with Docker Compose](docker-compose.md) sets one up for you; this page is for a database of your own, such as Azure Database for PostgreSQL.

## 1. Create the role and the database

Run this once as an admin on the PostgreSQL server, for example in `psql`. Use a strong, random password: `openssl rand -hex 32` gives one that needs no escaping in a URL. Type it only into `psql` and the host's secret store, never into chat, tickets or commits.

```sql
-- The application's own role: it can sign in, but it isn't a superuser and can't create
-- databases or roles.
CREATE ROLE simplearchitecture WITH LOGIN PASSWORD 'paste-the-generated-password-here'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- The database, owned by that role.
CREATE DATABASE simplearchitecture OWNER simplearchitecture ENCODING 'UTF8';

-- Connect to the new database (in psql: \c simplearchitecture), then:
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE simplearchitecture FROM PUBLIC;
GRANT CONNECT ON DATABASE simplearchitecture TO simplearchitecture;
-- PostgreSQL 14 or older only (15 and later already give the database owner the public schema):
ALTER SCHEMA public OWNER TO simplearchitecture;
```

The role owns only its own database. The app creates and updates its tables there itself, so it needs no other rights.

## 2. Allow the app through the firewall

If the server, or its cloud provider, has a firewall, allow the container host's outbound address on the PostgreSQL port (usually 5432).

## 3. Set `DATABASE_URL`

```sh
DATABASE_URL=postgres://simplearchitecture:<password>@db.example.com:5432/simplearchitecture?sslmode=verify-full
```

- For any host other than `localhost` or `127.0.0.1`, the app always uses TLS and verifies the server's certificate and host name. It refuses to start if `sslmode` asks for less (`disable`, `allow`, `prefer` or `no-verify`). Use `sslmode=verify-full`, or leave `sslmode` out.
- The server's certificate must come from a public certificate authority, as on Azure Database for PostgreSQL and other managed services. A private certificate authority isn't supported.
- `sslmode` is the only parameter the URL may have.
- A password with special characters must be percent-encoded in the URL. A password from `openssl rand -hex 32` needs none.
- The app never logs `DATABASE_URL` or the password, and never shows them.

Keep `DATABASE_URL` in the host's secret store: it holds the password. On Azure, the app can also sign in to the database with Entra ID instead of a password: see [Azure examples](azure.md#database-sign-in-with-entra-id-instead-of-a-password).

## 4. Migrations

The app creates and updates its tables itself, with migrations that run when it starts: only the missing ones, in one transaction, under a lock, so several containers starting at once are safe. Running them again changes nothing.

To run them by hand, as a one-off command with the same environment variables as the app (for example `docker run --rm --env-file <file> <image> <command>`):

```sh
node backend/dist/db/migrate-cli.js
```

## 5. Backups

The database holds everything, so back it up, and test that you can restore it. Protect backups like the database itself: they hold your organisation's architecture. Back up before every upgrade: there is no downgrade, and restoring the backup is the way back.

## Checking the connection

**Admin → Database** shows the connection's status (never the password), and **Test connection** checks it. See [The Admin space](admin.md#database).
