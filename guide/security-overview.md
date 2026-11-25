# Security overview

For IT and security teams who are deciding whether to run SimpleArchitecture, and for hosts checking a release: what the app stores, what it connects to, how it protects itself, how to verify a release, and what the host is responsible for. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## In short

- One container image (the API, which also serves the web app) and one PostgreSQL database. Nothing else.
- Sign-in with your own OpenID Connect provider. The browser holds only a session cookie, never a token.
- AI agents (MCP clients such as Claude) can read the models a user can see, once that user allows them, and for a Modeller or Admin add and change elements and relationships. They get the app's own short-lived tokens, never the provider's.
- All data is in your database. The container writes nothing to disk and runs read-only, as a non-root user.
- The app doesn't phone home: no telemetry, analytics, update checks or third-party content.
- Each release is scanned, signed and comes with a signed SBOM and build provenance. The latest release is scanned again every week.

## What is stored, and where

Everything is in the PostgreSQL database set in `DATABASE_URL`.

| Data        | Where                                                                                            | What it holds                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models      | Tables `models`, `elements`, `relationships`                                                     | Elements, relationships and their properties, and who created each model (the provider's user id and display name)                                                                                                    |
| Views       | Tables `views`, `view_elements`, `view_relationships`                                            | Each view's name, folder and layout, the elements and relationships it holds (by reference), and who created and last changed it                                                                                      |
| Properties  | Tables `element_properties`, `relationship_properties`                                           | The element and relationship properties an Admin defined: names, keys, kinds and options                                                                                                                              |
| Audit trail | Table `audit`                                                                                    | Who changed what, and when (see [Logs and the audit trail](#logs-and-the-audit-trail))                                                                                                                                |
| Sessions    | Table `sessions`                                                                                 | A SHA-256 hash of each session id (never the id itself), the user's id at the provider, display name, email address and roles, and when the session started and was last used                                         |
| Branding    | Table `branding`                                                                                 | An optional product title, two colours, a logo, a logo for the Dark theme and an app icon, and who last changed them                                                                                                  |
| AI agents   | Tables `mcp_clients`, `mcp_authorization_requests`, `mcp_codes`, `mcp_connections`, `mcp_tokens` | Each registered agent's self-given name and redirect addresses, and each connection a user allowed: the user's id, name and roles at that moment, and its times. Codes, tokens and request ids only as SHA-256 hashes |
| App logs    | Table `app_logs`                                                                                 | The server's log entries of the last 30 days, for Admin → Logs: the same entries as standard output, credentials redacted                                                                                             |

In the browser:

- One session cookie, `__Host-sa_session`: a random id, `Secure`, `httpOnly` and `SameSite=Lax`, so scripts can't read it. During sign-in, a second cookie holds the encrypted sign-in state for up to 10 minutes.
- The app's own files, cached by the service worker so the app loads quickly. API responses and model data are never cached.
- Display preferences in local storage: the theme, panel sizes, depth, the canvas switches, the branding (colours, product title and image addresses), and which view folders are closed (as short hashes of their names). Never tokens, user data or model content.

Treat the database, its backups and any exported model files (JGF) as confidential: they hold your organisation's architecture.

## What is in the image, and what is not

The image holds the compiled backend, the built web app, the database migrations, the default import mapping, the backend's production dependencies and the licence terms (`LICENSE`, and the web app's `third-party-licenses.txt`). It is based on the official Node.js image for Alpine Linux, pinned by digest, with npm and other package managers removed.

It never holds source code, source maps, type declarations, tests, documents, `.env` files, the `.git` folder, model data or exports. The image build fails if any of them is there or the licence terms are missing, and CI checks the finished image again. Third-party packages keep their own files as published.

There are no secrets in the image. Every setting, the client secret, the session secret and the database password included, comes from environment variables that the host sets. On Azure Kubernetes Service, two optional settings replace the client secret and the database password with the pod's workload identity (see [Azure examples](azure.md#azure-kubernetes-service-with-workload-identity)). Its tokens and Entra ID's messages are never logged: a failure gives only Entra's error number.

## What the app connects to

The app makes no connection that you haven't configured:

- **The API** connects only to your PostgreSQL server and to the sign-in provider in `OIDC_ISSUER`, over https. The database connection uses TLS with a verified certificate from a public certificate authority, unless `DATABASE_URL` asks for a plain connection (`sslmode=disable`), which the app allows only to the same machine or to a host with a one-word name, such as a Compose service (see [Database](database.md#3-set-database_url)). With the optional `DATABASE_AUTH=entra`, it also asks Entra ID for the database's token.
- **The browser** talks only to the app's own address, enforced by the content security policy (`connect-src 'self'`; scripts, styles, fonts and images from the app's own origin only). Sign-in and sign-out send the browser to the provider.
- **AI agents** call the app; the app never calls them. claude.ai and Claude Desktop call it from Anthropic's servers, Claude Code from the user's computer.

## Sign-in, sessions and roles

- Sign-in uses OpenID Connect with the one provider you set: the authorization code flow with PKCE, state and nonce, handled by the API. The ID token is validated on the server and never sent to the browser. The provider's issuer must equal `OIDC_ISSUER` exactly (see [Sign-in and roles](sign-in.md)).
- Roles come from one claim in the signed ID token, matched exactly against the three configured values. A missing or malformed claim gives no access.
- Admin (model imports and deletion, the element and relationship properties, branding, the database status page, disconnecting anyone's AI agents), Modeller (editing) and Viewer (read-only). Each role includes the ones below it. **Every role can read every model in full**, as Viewing shows it: the Export button is on an Admin page, but a Viewer's browser loads the same data.
- Every sign-in gets a new, random session id, and only its hash is stored. A session ends after 30 minutes without use or 8 hours after sign-in. Sign-out ends it on the server and sends the browser to the provider's end-session address, if it has one.
- Roles are read at sign-in, so a role removed at the provider takes effect at the person's next sign-in. There is no way yet to end another user's session early.
- Every API route declares who may call it, and the API refuses to start with a route that doesn't (deny by default). Every request that changes something must come from the app's own origin (protection against cross-site request forgery).

## AI agents (MCP)

How people connect agents, and which paths a host opens for them, is in [Connect an AI agent](connect-an-ai-agent.md).

- The app is its own small OAuth 2.1 authorization server, used only for AI agents and built from `APP_DOMAIN`, with no settings of its own. Agents register themselves as public clients, with no client secrets. PKCE (S256) is required, and the authorization response names the app as its issuer.
- Registration is open to anyone, as the MCP specification expects, so it is rate-limited and capped. At the cap, a new registration replaces the oldest agent that never got a token, so anonymous registrations can't fill it.
- An agent's redirect address must be https, or plain http on the user's own computer (`127.0.0.1`, `[::1]` or `localhost`, any port), and must match exactly as registered. Until the user has decided on the consent page, the browser is never sent to the agent's address: any error shows on the app's own page.
- The consent page shows the address the browser goes back to (checked) and the name the agent gives (not checked, shown as text only). Only a Viewer or higher can allow it. The page can't be framed, the decision must come from the app's own origin, and a request can be decided once, by the user who opened it, within 10 minutes.
- Authorization codes are used once, within a minute, and are bound to the agent, its redirect address and the PKCE challenge. Using one twice ends the connection it started.
- Access tokens last 1 hour. Refresh tokens change on every use, and using an old one again ends the whole connection. A connection ends 7 days after the user allowed it, however often it refreshes, and keeps the roles the user had at that moment until then.
- Tokens are random, stored only as hashes, never logged, and work only on `/mcp`, which accepts nothing else, never the session cookie. Disconnecting, by the user or by an Admin for anyone, stops them at once.
- Every agent reads exactly what Viewing shows that user, through seven read-only tools. Model content is returned as data, marked as untrusted, never as instructions.
- A connection whose roles open Modelling (Modeller or Admin) also gets four write tools: create and update one element or one relationship. A Viewer's connection never sees them, and each call checks the role again (deny by default). There is no delete tool. The consent page says what the agent can change before the user allows it.
- A write goes through the same editing services as Modelling: the same input checks and limits, the metamodel's rules and the whole model's validation, under the model's lock. An update carries the version the agent read, so a conflict is reported, never overwritten. `dry_run` runs the change in full, then rolls the transaction back: nothing is stored and no audit row is written.
- A saved write has the same audit row as a change in Modelling, with the user (their id and their name when they allowed the agent) as actor, and `via` in its details: `mcp` with the agent's client and connection ids. One element or relationship per call, and at most 60 write calls a minute per user, previews included.
- A connection whose roles open Admin also gets `get_logs`, which reads the stored log entries (see [Logs and the audit trail](#logs-and-the-audit-trail)). Other connections never see it, each call checks the role again, and each read is logged with the user's id.

## Logs and the audit trail

- The API writes logs to standard output as JSON lines, for the host to collect: the request method and path, the client address, status codes, and for audited actions the user's id at the provider. The query of `/auth`, `/oauth` and `/agents` addresses, and the id of a consent request, are left out. Logs never hold passwords, secrets, cookies, tokens, the database URL or model content.
- The same entries are also kept in the database (table `app_logs`) for 30 days, then removed, so Admins can read them on **Admin → Logs** and through an Admin's AI agent (`get_logs`). No other role can read them. Each read of the logs, on Admin → Logs or by an agent, is itself logged with the reader's user id at the provider, the days and level asked for, where it came from (`web` or `mcp`) and how many entries it returned, never the entries themselves. A refused or invalid request is not logged as a read. Before an entry is stored, and again before it is shown, any field named like a credential (authorization, cookie, password, token, secret and similar) is replaced by `[Redacted]`. If the database can't take them, entries are dropped, never held without limit, and the requests go on.
- They also record model imports, saves and deletions, database connection tests, sign-in and sign-out, and, for AI agents, each registration, connection, refresh-token reuse, revocation, disconnect and tool call (for a write, the id it touched and whether it was saved or a preview), with ids and counts only, never search text, names or other model content.
- The database's `audit` table keeps every change to an element, a relationship, a view, a property definition or the branding, and each Admin's disconnect of AI agents: who, when, the action, the ids and the names of the changed fields, never their values. A change an AI agent made for the user also names the agent connection.

## How the app protects itself

- **Input:** the server checks every request: types, sizes and allowed values. Uploads have size limits, the OEF (XML) parser refuses document types and entities, and logos are checked to be real PNG, JPEG or WebP images. Database queries are always parameterised.
- **Rate limits,** per minute: 60 sign-in starts and 60 sign-in callbacks per client address; 10 uploads (model imports and the logo), 10 new models and 5 database connection tests per user. For AI agents: 20 registrations, 30 authorize requests, 60 token requests and 60 revocations per client address, 120 MCP calls and 60 MCP write calls (previews included) per user, and 300 unrecognised tokens per address (an expired token the app issued doesn't count). A limit per address counts everyone who reaches the app from that address together. Over a sign-in limit, the browser goes back to the sign-in page, which asks to wait a minute; other requests get `429 Too Many Requests`. The counts are kept in memory in each container, so with several containers each counts on its own. A request may take at most 120 seconds in all.
- **Safe start:** the image reads ten required settings and a few optional ones, and fixes everything else (https only, secure cookies, one trusted proxy unless `TRUST_PROXY` says more, port 8080). It refuses to start if a setting is missing or invalid, if `SESSION_SECRET` is too short, too simple or equals the client secret, or if `DATABASE_URL` breaks the connection rules above. The error names the setting, never its value.
- **Errors** never show stack traces or internal messages. `/api/health` answers only `{"status":"ok"}`. The version is given only to signed-in people with a role.
- **Security headers** on every response: a strict content security policy (no inline scripts, no framing), HSTS for two years, `X-Content-Type-Options: nosniff`, a strict referrer policy, and a permissions policy that switches off the camera, microphone, location, payment and USB features.
- **Web app files** are served from memory, so no request path reaches the file system. Hidden files and source maps are never served.
- **The container** runs as a non-root user (uid 1000) that can't change the app's files, with a read-only root file system and no Linux capabilities, and listens on port 8080 only. CI tests each of these on every build.

## Supply chain

Each release (a version tag) is built by GitHub Actions from this repository's public source, with every action pinned by commit and the base images by digest. Each job has only the permissions it needs, and nothing secret is built into the image or printed in the logs. The image is pushed by digest with no tag, and gets its version tags only after all of the following have passed, so a failed release has no version tag:

- **Checked:** the pushed image's contents and licence terms, and the container test on amd64 (read-only, no capabilities, non-root, port 8080 only, no path tricks).
- **Scanned** with Trivy on both platforms (amd64 and arm64). The web app's bundled packages, which Trivy can't see in the image, are listed by the build and scanned too. A high or critical vulnerability with a fix stops the release. The production dependencies are also checked with `npm audit`.
- **Signed** with Sigstore cosign, keyless: the signature is tied to the release workflow's GitHub identity, so no signing key exists that could leak. It is recorded in Sigstore's public transparency log.
- **SBOM** (CycloneDX) of the image's and the web app's packages, attached to the image, signed, and to the GitHub release.
- **Build provenance** (SLSA) and the SBOM, also attested by GitHub and stored with the image.
- The GitHub release carries the release notes, the SBOM, the scan results and the image's digest.

Every week, the latest release is scanned again on both platforms. A fixable high or critical finding opens an issue in this repository, and the maintainer decides on a patch release. Dependabot proposes dependency, action and base image updates every week, and each goes through the same checks before it reaches a release.

## Verify a release

Anyone can check that an image was built by this repository's release workflow and hasn't changed since, with [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) and no sign-in. Replace the version in the commands. Pull by digest (`image-digest.txt` in the GitHub release) to be sure you deploy what you checked.

The signature:

```sh
cosign verify ghcr.io/johannsmit/simplearchitecture:1.2.3 \
  --certificate-identity "https://github.com/johannsmit/simplearchitecture/.github/workflows/ci.yml@refs/tags/v1.2.3" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

It prints the verified signature and exits with `0`; any other identity, issuer or a changed image fails.

The SBOM, fetched from the image with its signature checked:

```sh
cosign verify-attestation ghcr.io/johannsmit/simplearchitecture:1.2.3 --type cyclonedx \
  --certificate-identity "https://github.com/johannsmit/simplearchitecture/.github/workflows/ci.yml@refs/tags/v1.2.3" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  | jq -r .payload | base64 -d | jq .predicate > sbom.cdx.json
```

The same SBOM is `sbom.cdx.json` in the GitHub release, which needs no sign-in either. It lists every package in the image and every package bundled into the web app, with its version and licence. Read it with any CycloneDX tool, scan it yourself (`trivy sbom sbom.cdx.json`), or list the packages with `jq`:

```sh
jq -r '.components[] | "\(.name) \(.version)"' sbom.cdx.json | sort
```

GitHub's build provenance and SBOM attestations can be checked too, with the GitHub CLI. That is the one check that needs a GitHub sign-in (any account):

```sh
gh attestation verify oci://ghcr.io/johannsmit/simplearchitecture:1.2.3 --repo johannsmit/simplearchitecture
gh attestation verify oci://ghcr.io/johannsmit/simplearchitecture:1.2.3 --repo johannsmit/simplearchitecture \
  --predicate-type https://cyclonedx.org/bom
```

## What the host is responsible for

Some protections depend on how the app is hosted:

- **https:** put a TLS proxy or ingress in front of the container, with its https-only setting on. Never expose port 8080 directly, and set `TRUST_PROXY` only to the number of proxies really there: a higher number lets a client fake its address. See [Behind the https proxy](hosting.md#behind-the-https-proxy).
- **Secrets:** keep `OIDC_CLIENT_SECRET`, `SESSION_SECRET` and `DATABASE_URL` in the host's secret store, generate `SESSION_SECRET` randomly (`openssl rand -base64 48`), and rotate the client secret before it expires. With workload identity, let the federated credential trust only the app's own service account.
- **The database:** a dedicated database and user with no other rights, TLS when it is on another machine, only the container host allowed through the firewall, and the server kept patched. See [Database](database.md).
- **Backups:** back up the database, test restoring it, and protect backups like the database itself.
- **The sign-in provider:** give the roles only to the people who need them, register only your own redirect addresses, and use a single-organisation issuer. If the roles claim holds group names, use groups that ordinary users can't create, join or rename. See [Sign-in and roles](sign-in.md).
- **The container:** run it with a read-only root file system and no extra capabilities, pin the full version (there is no `latest` tag), and check its signature before you deploy.
- **Updates:** only the latest release gets security fixes. Watch for new releases and upgrade.
- **AI agents:** for claude.ai and Claude Desktop, open the paths in [For hosts](connect-an-ai-agent.md#for-hosts) to Anthropic's address range. If you don't want that, keep them closed: Claude Code works from the user's own computer.
- **Logs:** collect the container's standard output, keep it as long as your policy needs, and restrict who can read it: it holds user ids and client addresses.

Not included: an external penetration test or a certification (such as ISO 27001 or SOC 2).
