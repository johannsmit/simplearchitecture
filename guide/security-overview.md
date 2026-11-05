# Security overview

For IT and security teams who are deciding whether to run SimpleArchitecture. It says what the app stores, what it connects to, how it protects itself, how a release can be checked, and what the host is responsible for. To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## In short

- One container image (the API, which also serves the web app) and one PostgreSQL database. Nothing else.
- Sign-in with your own OpenID Connect provider, such as your Microsoft Entra ID tenant. The browser never holds a token, only a session cookie.
- AI agents (MCP clients such as Claude) can read the models a user can see, after that user signs in and allows them. The app gives them its own short-lived tokens; they never see the provider's. See [Connect an AI agent](connect-an-ai-agent.md).
- All data is in your database. The container keeps nothing on disk and runs read-only, as a non-root user.
- The image holds only the compiled app and its dependencies: no source code, source maps, tests, documents, secrets or data.
- The app doesn't phone home: no telemetry, analytics, update checks or third-party content.
- Each release is scanned, signed and comes with a signed SBOM and build provenance, and the latest release is scanned again every week.

## What is stored, and where

Everything is in the PostgreSQL database set in `DATABASE_URL`. The container's file system is never written to.

| Data        | Where                                                                                            | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models      | Tables `models`, `elements`, `relationships`                                                     | The architecture models: elements, relationships, their properties and metadata, and who created each model (the provider's user id and display name)                                                                                                                                                                                                                                                                                                                                                            |
| Views       | Tables `views`, `view_elements`, `view_relationships`                                            | Named views of a model: each view's name, who created and last changed it (the provider's user id and display name), and which of the model's elements and relationships it holds, by reference. Deleting an element, a relationship or a model removes it from every view                                                                                                                                                                                                                                       |
| Audit trail | Table `audit`                                                                                    | Every change to an element, a relationship, a view or the branding: who (the provider's user id and display name), when, the action, and which model, element, relationship or view (by id), with the names of the changed fields, never their values                                                                                                                                                                                                                                                            |
| Sessions    | Table `sessions`                                                                                 | A SHA-256 hash of each session id (never the id itself), the user's id at the provider, display name, email address and app roles, and when the session started and was last used. Sessions end after 30 minutes without use or 8 hours after sign-in, and are removed within 10 minutes after that                                                                                                                                                                                                              |
| Branding    | Table `branding`                                                                                 | Two colours, an optional logo image, and who last changed them                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AI agents   | Tables `mcp_clients`, `mcp_authorization_requests`, `mcp_codes`, `mcp_connections`, `mcp_tokens` | Each agent that registered (its self-given name and redirect addresses), and each connection a user allowed: the user's id at the provider, display name and app roles at that moment, where the browser went back to, and when it connected, was last used and ends. Codes, tokens and request ids are stored only as SHA-256 hashes. Ended connections are removed within 10 minutes. An agent that never got a token is removed an hour after it registered, and one that did, 30 days after it was last used |

In the browser:

- One session cookie (`__Host-sa_session`): a random id, `Secure`, `httpOnly` and `SameSite=Lax`, so scripts can't read it. During sign-in, a second short-lived cookie holds the encrypted sign-in state for up to 10 minutes.
- The app's own files (HTML, scripts, styles, icons), cached by the service worker so the app loads quickly. API responses and model data are never cached by it.
- Display preferences in local storage (theme, panel sizes, the branding colours). Never tokens, user data or model content.

The models are your organisation's architecture data. Treat the database, its backups and any exported model files (JGF) as confidential.

## What is in the image, and what is not

The image holds the compiled backend (JavaScript), the built web app, the database migrations (SQL), the default import mapping, the production dependencies of the backend, and the licence terms (`LICENSE`, and the third-party notices in the web app's `third-party-licenses.txt`, with a licence label on the image). It is based on the official Node.js image for Alpine Linux, pinned by digest, with npm and other package managers removed.

It never holds: source code (TypeScript), source maps, type declarations, tests, documents, `.env` files, the `.git` folder, model data or exports. The image build checks this (`deploy/check-image-files.sh`) and fails if any of them is there or if the licence terms are missing, and CI checks the finished image again (`deploy/check-finished-image.sh`). Third-party packages keep their own files as published (for example their READMEs and licences).

There are no secrets in the image. Every setting, including the OIDC client secret, the session secret and the database password, comes from environment variables that the host sets at runtime.

## What the app connects to

The app makes no connection that you haven't configured. We checked the code for every outgoing call:

- **The API** connects only to your PostgreSQL server (`DATABASE_URL`, with TLS and a verified certificate from a public certificate authority for any host other than the container itself) and to the sign-in provider you set in `OIDC_ISSUER`, over https: discovery, the token exchange and the signing keys (with Entra ID, `login.microsoftonline.com`, for your tenant).
- **The browser** talks only to the app's own address. The content security policy enforces this (`connect-src 'self'`, scripts, styles, fonts and images from the app's own origin only). Sign-in and sign-out send the browser to the provider. Fonts and icons are part of the app, not loaded from elsewhere.
- There is no telemetry, crash reporting, analytics or update check.
- AI agents call the app, never the other way round: the app makes no outgoing call for them. claude.ai and Claude Desktop call it from Anthropic's servers; Claude Code from the user's computer.

## Sign-in, sessions and roles

- Sign-in uses OpenID Connect with the one provider you set: the authorization code flow with PKCE, state and nonce, handled entirely by the API. The ID token is validated on the server and never sent to the browser.
- Roles come from one claim in the signed ID token (`OIDC_ROLES_CLAIM`), matched exactly against the three configured values. A missing or malformed claim gives no access. The provider's issuer must equal `OIDC_ISSUER` exactly, and the secret is sent by a method the provider advertises, or sign-in is refused.
- A new, random session id is issued at every sign-in (so an old session can't be reused), and only its hash is stored. Sign-out ends the session on the server and sends the browser to the provider's end-session address, if it has one. The form policy allows the app's own origin only (`form-action 'self'`): the browser leaves from a small page of the app's own, not a form redirect.
- Access comes from the app roles in the ID token: Admin (model imports and deletion, branding, the database status page), Modeller (editing) and Viewer (read-only). Roles are cumulative. A user without one of these roles gets no access. The role values are configurable, because organisations name them differently.
- Roles are read once, at sign-in. If you remove a user's role or disable the user at the provider, it takes effect at their next sign-in: at most 8 hours later, or 30 minutes if they stop using the app. There is no way yet to end another user's session early.
- Every API route declares who may call it, and the API refuses to start with a route that doesn't (deny by default). Every request that changes something must come from the app's own origin (protection against cross-site request forgery).

## AI agents (MCP)

- The app is its own small OAuth 2.1 authorization server, used only for AI agents, with everything derived from `APP_DOMAIN`: there are no settings of its own. Agents register themselves (dynamic client registration), as public clients only: no client secrets. PKCE (S256) is required, and the authorization response names the app as its issuer.
- Registration is open to anyone, as the MCP specification expects, so it is limited per address and capped at 5,000 agents. At the cap, a new registration replaces the oldest agent that never got a token, so a flood of registrations can't shut it.
- An agent's redirect address must be https, or plain http on the user's own computer (`127.0.0.1`, `[::1]` or `localhost`, any port, for desktop apps such as Claude Code). It is matched exactly as registered otherwise.
- Until the user has chosen the agent on the consent page, the app never sends the browser to the agent's address: any error is shown on the app's own page. Only Allow and Deny go back to the agent.
- The user signs in with the app's usual sign-in and then sees a consent page with the address the browser goes back to (checked) and the name the agent gives (not checked, shown as text only). Only a Viewer or higher can allow it. The page can't be framed, and the decision must come from the app's own origin. A request waits at most 10 minutes and can be decided once, by the user who opened it.
- Authorization codes are used once, within a minute, and bound to the agent, its redirect address and the PKCE challenge. Using one twice ends the connection it started.
- Access tokens last 1 hour. Refresh tokens change on every use, and using an old one again ends the whole connection. A connection ends 7 days after the user allowed it, however often it refreshes. It carries the roles the user had at that moment: a role removed at the provider still applies to the agent for up to 7 days, or until the connection is disconnected.
- The tokens work only on `/mcp`, and `/mcp` accepts only them, never the session cookie. They are random, stored only as hashes, never logged, and checked on every call.
- Users disconnect their own agents under **Connected apps**; Admins can disconnect any user's, or all, under **Admin** > **Connected apps**, which writes an audit row (who, when, the connection or user ids and the count, never agent names or tokens). Disconnecting stops the tokens at once. Signing out of the browser doesn't disconnect agents.
- Agents read exactly what Viewing shows that user, through five read-only tools. Model content is returned as data, marked in each tool's description as untrusted, never as instructions.

## Logs and the audit trail

- The API writes logs to standard output as JSON lines, for the host to collect. They hold the request method and path (the sign-in callback's query is removed), the client address, status codes, and for audited actions the user's id at the provider. They never hold passwords, secrets, cookies, tokens, the database URL or model content.
- The logs also record model imports, saves and deletions, database connection tests, and sign-in and sign-out, each with the user's id at the provider and never any model content.
- Element, relationship, view and branding changes are kept in the database's `audit` table (see above), with the field names only, never the values (a view's name is never in it).
- AI agents: each registration, connection, refresh-token reuse, revocation and disconnect is logged with ids only, and each tool call with the user's id, the tool, the model id and counts, never search text, names or other model content. An Admin's disconnects are also kept in the `audit` table.

## How the app protects itself

- **Input**: the server checks every request: types, sizes and allowed values. Uploads have size limits, the OEF (XML) parser refuses document types and entities, and logos are checked to be real PNG, JPEG or WebP images. Database queries are always parameterised.
- **Rate limits**: at most 10 sign-in starts and 10 sign-in callbacks per minute per client address, and 10 uploads (model imports and checks, the logo) per minute per user. Over the limit, sign-in sends the browser back to the sign-in page, which asks to wait a minute, and an upload gets `429 Too Many Requests` with the same advice. AI agents: 20 registrations, 30 authorize requests and 60 token requests per minute per client address, 120 MCP calls per minute per user, and 30 refused tokens per minute per address. The counts are kept in memory in each container, so with several containers each counts on its own. A request may take at most 120 seconds in all, so a very slow upload can't hold a connection open.
- **Safe start**: the image reads exactly ten settings and fixes everything else (https only, secure cookies, one proxy, port 8080). It refuses to start if one of the ten is missing or invalid, if `SESSION_SECRET` is shorter than 32 characters, has fewer than 10 different characters or equals the client secret, or if the database URL asks for less than TLS to a server other than the container itself. The error names the setting, never its value. Settings of earlier versions are ignored, with a warning.
- **Errors** never show stack traces or internal messages. `/api/health` answers only `{"status":"ok"}`: no version or other detail.
- **Security headers** on every response: a strict content security policy (no inline scripts, no framing), HSTS for two years, `X-Content-Type-Options: nosniff`, a strict referrer policy, and a permissions policy that switches off the camera, microphone, location, payment and USB features.
- **Web app files** are read into memory at startup; no request path ever reaches the file system, so path tricks such as `/../` or `%2e%2e` can't reach other files. Hidden files (such as `.env` or `.git/`) and source maps are never served, even if one were in the build.
- **The container** runs as a non-root user (uid 1000) that can't change the app's files, needs no write access to its file system (it runs with a read-only root file system), needs no Linux capabilities, and listens on port 8080 only. CI tests each of these on every build.

## Supply chain: checking a release

Each release (a version tag) is built by GitHub Actions from this repository's source, which anyone can read, with the actions and base images pinned to exact versions. The image is pushed by digest with no tag, and gets its version tags only after all of the following have passed, so a failed release has no version tag:

- The pushed image's contents and licence terms are **checked**, and the amd64 image passes the **container test**.
- The image is **scanned** with Trivy on both platforms (amd64 and arm64), and the release is stopped if a high or critical vulnerability with a fix is found. The web app's packages are bundled, so Trivy can't see them in the image: the build lists them, and that list is scanned too. The production dependencies are also checked with `npm audit`.
- The image is **signed** with Sigstore cosign, keyless: the signature is tied to the release workflow's GitHub identity. No signing key exists that could leak.
- The **SBOM** (CycloneDX) lists the image's packages and the web app's. It is attached to the image, signed with cosign, and to the GitHub release, so it can be fetched and verified with no sign-in.
- **Build provenance** (SLSA) and the SBOM are also attested by GitHub and stored with the image.
- Scan results are attached to the GitHub release.
- **Every week**, the latest release is scanned again on both platforms. A fixable high or critical finding opens one issue per release in this repository, and the maintainer decides on a patch release.
- **Dependabot** proposes dependency, action and base image updates every week in this repository. Each goes through the same checks as any other change before it reaches a release.

The README ("Verify a release") shows how to check the signature and the SBOM yourself with no sign-in, and how to check GitHub's attestations (that one check needs a GitHub sign-in).

Notes: the keyless signature is recorded in Sigstore's public transparency log, which shows the repository and workflow that signed the image (not the image's contents). GitHub's attestations need a public repository: releases built while this repository was private (release candidates) have the signature and the signed SBOM, but no GitHub attestations.

## What the host is responsible for

The app is designed to be safe by default, but some protections depend on how it is hosted:

- **https**: put a TLS proxy or ingress in front of the container, and turn on its https-only setting. The app trusts exactly one proxy in front of it, so don't expose port 8080 to the internet directly, and don't put a second proxy in front of the host's.
- **Secrets**: keep `OIDC_CLIENT_SECRET`, `SESSION_SECRET` and `DATABASE_URL` in the host's secret store, generate `SESSION_SECRET` randomly (`openssl rand -base64 48`), and rotate the client secret before it expires.
- **The database**: use a dedicated database and user with no other rights, require TLS, allow only the container host through the firewall, and keep the server patched.
- **Backups**: back up the database (it holds everything) and test restoring it. Protect backups like the database itself.
- **The sign-in provider**: assign the roles only to the people who need them, and register only your own redirect addresses. If the roles claim holds group names, use groups that ordinary users can't create, join or rename: a user in a group with the right name gets that role. Use a single-organisation issuer: the app refuses an address whose discovered issuer differs from `OIDC_ISSUER`, such as Entra's `/common`.
- **Running the container**: run it with a read-only root file system and no extra capabilities, pin the full version (there is no `latest` tag), and check its signature before you deploy.
- **Updates**: only the latest release gets security fixes. Watch for new releases and upgrade.
- **AI agents**: claude.ai and Claude Desktop reach the app from Anthropic's servers (`160.79.104.0/21`), so for them the host must let that range reach `/.well-known/`, `/oauth/register`, `/oauth/token` and `/mcp`. If you don't want that, keep those paths closed to the internet: Claude Code works from the user's own computer.
- **Logs**: collect the container's standard output, keep it as long as your policy needs, and restrict who can read it (it holds user ids and client addresses).

Not included: an external penetration test or a certification (such as ISO 27001 or SOC 2).
