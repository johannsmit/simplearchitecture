# Hosting the image

For hosts: how to run the SimpleArchitecture image on any container host, such as Azure Container Apps, Azure App Service, Kubernetes or a server with Docker. On one machine, [Run with Docker Compose](docker-compose.md) is quicker.

## What runs

SimpleArchitecture is one container image: the API, which also serves the web app, so everything shares one address. Next to it you need:

- a PostgreSQL database (see [Database](database.md));
- an OpenID Connect provider for sign-in (see [Sign-in and roles](sign-in.md));
- an https proxy or ingress in front of the container. The host's own (App Service, Container Apps, a Kubernetes ingress) is fine.

## Pull the image

The image is in GitHub Container Registry, `ghcr.io/johannsmit/simplearchitecture:<version>`. A release `v1.2.3` is tagged `1.2.3` and `1.2`. No sign-in is needed.

```sh
docker pull ghcr.io/johannsmit/simplearchitecture:1.2.3
```

- There is no `latest` tag, so a pull without a version fails. Pin the full version on the host, so an upgrade happens only when you choose it.
- Each tag holds an image for Intel and AMD servers (`linux/amd64`) and one for ARM (`linux/arm64`); Docker pulls the right one.
- The code and the image are hosted on GitHub, a US company. If you prefer, copy the image into your own registry and run it from there.
- You can check that an image was built by this repository and hasn't changed: see [Verify a release](security-overview.md#verify-a-release).

## Settings

The image reads **ten settings, all required**. Set them as environment variables on the host. Keep the secrets in the host's secret store, never in the image or a file in it.

| Variable             | Secret | Value                                                                                                                                               |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_DOMAIN`         |        | The domain only, such as `architecture.example.com`. The app is always served at `https://<APP_DOMAIN>`                                             |
| `DATABASE_URL`       | Yes    | `postgres://simplearchitecture:<password>@<server>:5432/simplearchitecture?sslmode=verify-full` (see [Database](database.md))                       |
| `OIDC_ISSUER`        |        | Your provider's issuer, https, exactly as it names itself                                                                                           |
| `OIDC_CLIENT_ID`     |        | The client id of the app's registration at your provider                                                                                            |
| `OIDC_CLIENT_SECRET` | Yes    | Its client secret                                                                                                                                   |
| `SESSION_SECRET`     | Yes    | At least 32 random characters (`openssl rand -base64 48`), with at least 10 different ones, and not the client secret. A new value signs nobody out |
| `OIDC_ROLES_CLAIM`   |        | The ID token claim that holds the roles, such as `roles` or `groups`                                                                                |
| `OIDC_ROLE_ADMIN`    |        | The value in that claim that gives Admin                                                                                                            |
| `OIDC_ROLE_MODELLER` |        | The value that gives Modeller                                                                                                                       |
| `OIDC_ROLE_VIEWER`   |        | The value that gives Viewer                                                                                                                         |

How to get the provider's values is in [Sign-in and roles](sign-in.md), and for Microsoft Entra ID in [Azure examples](azure.md#microsoft-entra-id).

If one of the ten is missing or invalid, the container refuses to start. Its log names the settings that are wrong, never their values. Other settings aren't read.

**Optional settings,** for hosts that need them; a standard host sets none:

- `TRUST_PROXY`: the number of proxies in front of the app, when there is more than one (see [Behind the https proxy](#behind-the-https-proxy)).
- On Azure Kubernetes Service with Workload Identity: `OIDC_CLIENT_AUTH` and `DATABASE_AUTH`, to run without a client secret or a database password (see [Azure examples](azure.md#azure-kubernetes-service-with-workload-identity)).

Everything else is fixed in the image:

- the app's address is `https://<APP_DOMAIN>`, and the sign-in callback is `https://<APP_DOMAIN>/auth/callback`;
- the container listens on port **8080**, plain http, for the proxy in front;
- cookies are always secure, and logs are at `info`.

## Port, health check and running safely

- Point the host's ingress or target port at **8080**.
- **Health check:** `GET /api/health` answers `200` with `{"status":"ok"}`, without sign-in, and names no version. The image has a Docker health check on it. On Kubernetes or Azure, use it for the liveness and readiness probes.
- **No volume is needed.** Everything is in PostgreSQL, and the container writes nothing to its file system. Run it with a read-only root file system, as its non-root user, with no extra capabilities:
  - with Docker: `docker run --read-only --cap-drop ALL --security-opt no-new-privileges ...`;
  - on Kubernetes: `readOnlyRootFilesystem: true`, `allowPrivilegeEscalation: false` and `capabilities: { drop: [ALL] }`.

## Behind the https proxy

- The app trusts one proxy in front of it for `X-Forwarded-For` and `X-Forwarded-Proto`, so its logs show the client's address and it knows the request came over https. So **never expose port 8080 to the internet directly**: without the proxy, a client could fake its address.
- Behind two proxies, set `TRUST_PROXY` to their number (1 to 5, default 1). For example, on Kubernetes behind Azure Front Door, which reaches the ingress over http: `TRUST_PROXY=2`, with the ingress forwarding Front Door's `X-Forwarded-Proto: https` ahead of its own. Never set it higher than the proxies really there: that would let a client fake its address.
- A request that reached the proxy over plain http is redirected to `https://<APP_DOMAIN>`, or refused if it isn't a GET or HEAD. Also turn on the host's own https-only setting (Container Apps: ingress "Allow insecure connections" off; App Service: "HTTPS Only").

## Starting and upgrading

When the container starts, it runs any database migrations it needs before it accepts requests. If the database isn't reachable yet, it waits up to 60 seconds, then exits so the host restarts it. A wrong password, a missing database or a TLS problem fails at once, with the reason in the log.

To upgrade:

1. Read the [release notes](releases/) for the new version.
2. Back up the database.
3. Change the image tag to the new version and start it. Several containers starting at once are safe; a failed migration changes nothing and stops the container with the reason.

There is no downgrade: an older image refuses a database that a newer one has migrated. To go back, restore the backup and start the older image.

## The version

Signed-in people see the version at the bottom of the account menu. The server also logs its version and the commit it was built from when it starts. Nothing names the version before sign-in.

## Security

What the host is responsible for (https, secrets, the database, backups, logs) is listed in the [security overview](security-overview.md#what-the-host-is-responsible-for).
