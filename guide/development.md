# Development

For developers: how to build and run SimpleArchitecture from source, and how a release is made. Bug reports and ideas are welcome as [GitHub issues](https://github.com/johannsmit/simplearchitecture/issues); code contributions aren't taken.

SimpleArchitecture is a React Progressive Web App (`frontend/`) and a Node.js API (`backend/`), in TypeScript, with types shared by both (`shared/`).

## What you need

- Node.js 26.13 LTS or later, with npm 11 or later.
- A PostgreSQL database (see [Database](database.md)). The tests need no database and no Docker.
- An OpenID Connect provider that allows `http://localhost` redirect addresses (see [Sign-in and roles](sign-in.md)).

## Start

```sh
npm install
cp .env.example .env   # then fill in the twelve settings
chmod 600 .env
npm run dev
```

- Web app: `http://localhost:5173` (`FRONTEND_PORT`)
- API: `http://localhost:3000` (`BACKEND_PORT`), for example `http://localhost:3000/api/health`

In development, the API and the web dev server read exactly twelve settings from `.env`, all required: the image's ten (see [Hosting the image](hosting.md#settings)) plus `FRONTEND_PORT` and `BACKEND_PORT`. They refuse to start if one is missing or invalid. Use `APP_DOMAIN=localhost`: providers allow plain http for localhost only. Everything else is fixed: plain http, and logs at `info`. Other settings in `.env` aren't read.

The web app passes `/api` and `/auth` on to the API, so the browser talks only to the web app's port, except for the sign-in callback. Register exactly `http://localhost:<BACKEND_PORT>/auth/callback` with your provider.

For AI agents, the dev server also passes on `/oauth`, `/mcp` and `/.well-known/oauth-*`, so the MCP address is `http://localhost:<FRONTEND_PORT>/mcp`. Claude Code accepts plain http on localhost.

To try the app with made-up data, sign in as an Admin and import `samples/sample-insurance.jgf.json`, or `samples/sample-insurance.oef.xml` for the ArchiMate import, on **Admin → Models**.

Never commit `.env` or any secret; only `.env.example` is tracked. Model exports hold an organisation's data: never commit them either (`graph-export.json` is ignored).

## Commands

Run these from the repository root.

| Command                         | What it does                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                   | Starts the API (with reload) and the web dev server together                                                     |
| `npm run build`                 | Builds `shared/`, `backend/` (to `backend/dist`) and `frontend/` (to `frontend/dist`)                            |
| `npm run lint`                  | Lints all workspaces with ESLint                                                                                 |
| `npm run typecheck`             | Type-checks all workspaces with TypeScript                                                                       |
| `npm test`                      | Runs all tests once with Vitest (`npm run test:watch` to watch)                                                  |
| `npm run format`                | Formats all files with Prettier (`npm run format:check` to check)                                                |
| `npm run check:links`           | Checks that every relative link and `#anchor` in the README, `guide/` and `metamodel/` resolves (CI runs it too) |
| `npm run db:migrate -w backend` | Runs the database migrations (the API also runs them when it starts)                                             |

The tests use PGlite, PostgreSQL running inside the test process. They also store models as JGF files in a folder; `npm run db:import-files -w backend -- <folder>` copies such files into the database.

To try the production build, with the service worker and installing the app (the service worker is only active there, not in `npm run dev`):

```sh
npm run build
npm run start -w backend      # the API on BACKEND_PORT
npm run preview -w frontend   # the built web app on FRONTEND_PORT, passing /api and /auth to the API
```

## Project structure

```
backend/   Fastify API (TypeScript); backend/migrations/ holds the numbered SQL migrations
frontend/  React + Vite PWA (TypeScript)
shared/    Types shared by the web app and the API
config/    The ArchiMate OEF import mapping
guide/     This guide and the release notes
metamodel/ The default metamodel and an example model in JSON Graph Format
samples/   A made-up sample model to import, as JGF and as ArchiMate OEF (not in the image)
deploy/    The Docker Compose example and the image scripts: the contents check and the container test
```

The API's routes are in `backend/src/routes`, and the shapes of their requests and answers in `shared/src`. The REST API isn't a documented, supported interface yet; other tools read models through the [MCP endpoint](connect-an-ai-agent.md).

## Building the image yourself

The `Dockerfile` builds the image. Pass the commit you build from, so the app can name it in its startup log:

```sh
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" .
```

Outside Docker, `SOURCE_COMMIT=<commit> npm run build` does the same. It is optional: without it the commit is `unknown`, and the app starts as usual.

## Releasing

For the maintainer. `.github/workflows/ci.yml` runs on every push to `main` and every pull request: lint, typecheck, tests, an audit of the production dependencies, and a build of the image for `linux/amd64` and `linux/arm64` (not pushed). The amd64 image is then checked from outside (its files, the licence terms and the third-party notices), run in the container test, and scanned with Trivy.

To release, tag the commit whose package files hold the version, with exactly `v` and that version, and push the tag:

```sh
git tag v0.60.0
git push origin v0.60.0
```

The publish job checks the tag first (`deploy/check-release-tag.mjs`). A tag that isn't exactly `v` and the version in the four `package.json` files and `package-lock.json` (a pre-release tag such as `v0.60.0-rc.1` included), or package files that disagree with each other, stops the run with a message saying why, before anything is pushed. Pushes to `main` and pull requests aren't affected.

A version tag publishes the image from this repository only: a tag in any other repository, a fork included, publishes nothing. The workflow:

1. pushes the image for both platforms by digest, with no tag (arm64 is built under QEMU emulation);
2. checks the pushed amd64 image and runs the container test on it;
3. scans the pushed image on both platforms;
4. signs it with cosign, keyless;
5. makes a CycloneDX SBOM of the pushed image, adds the web app's packages, and attaches it to the image, signed, with cosign;
6. attests its build provenance and its SBOM with GitHub;
7. only then adds the version tags, `1.2.3` and `1.2`. It first works out what the tags would point at, without writing them, and stops if that isn't the tested digest;
8. creates the GitHub release for the tag, with the release notes from `guide/releases/<tag>.md`, `sbom.cdx.json`, `vulnerabilities-amd64.txt`, `vulnerabilities-arm64.txt` and `image-digest.txt` (also kept as workflow artifacts for 90 days).

A failure in any step before 7 leaves no version tag, only an untagged digest in the registry. GitHub's attestations (step 6) need a public repository; the repository variable `SKIP_ATTESTATIONS` set to `true` leaves that step out, and a release built that way has no GitHub attestations.

`.github/workflows/weekly-scan.yml` scans the latest release's image every Monday (or on demand: Actions → Weekly image scan → Run workflow). If it finds a high or critical vulnerability that has a fix, it opens an issue; nothing is republished automatically.

Every job has only the permissions it needs, and every action is pinned by commit SHA. The workflows use only their own `GITHUB_TOKEN` and OIDC identity; nothing secret is built into the image or printed in the logs.

### After a failed release run

A failed run leaves its digest in the registry, and the run's log names it (`Push the image by digest`). On a public package anyone can see and pull it. If the run got as far as signing, it even verifies against that tag's identity. So don't leave it there:

1. Note the digest and the platform manifests it holds: `docker buildx imagetools inspect ghcr.io/<owner>/simplearchitecture@sha256:<digest>`.
2. Delete those versions, and the signature and attestations from the same run, in the package's settings on GitHub (Package settings → Manage versions), or with `gh api -X DELETE /users/<owner>/packages/container/simplearchitecture/versions/<version id>`. Delete only what this run made: the platform manifests of a released image also show as untagged, and deleting one breaks that release.
3. Fix the cause and tag a new version. Never move a version tag by hand onto a digest that failed.

If `Add the version tags` itself fails, its log lists each tag and where it points, and no GitHub release is made. A tag on the wrong digest, or a `1.2` tag left behind, may already have been pulled. Point it at the right one (`docker buildx imagetools create -t ghcr.io/<owner>/simplearchitecture:<tag> ghcr.io/<owner>/simplearchitecture@sha256:<the release's digest>`, which for `1.2` means the newest good `1.2.x`), or, for a version with no good build, delete it. Then say so in the release notes.
