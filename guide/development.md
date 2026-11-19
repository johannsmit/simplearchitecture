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

`.env` holds twelve settings, all required: the image's ten (see [Hosting the image](hosting.md#settings)) plus `FRONTEND_PORT` and `BACKEND_PORT`. Use `APP_DOMAIN=localhost`, as providers allow plain http for localhost only. A local PostgreSQL without TLS needs `?sslmode=disable` at the end of `DATABASE_URL`.

The web app passes `/api` and `/auth` on to the API, so the browser talks only to the web app's port, except for the sign-in callback. Register exactly `http://localhost:<BACKEND_PORT>/auth/callback` with your provider.

For AI agents, the dev server also passes on `/oauth`, `/mcp` and `/.well-known/oauth-*`, so the MCP address is `http://localhost:<FRONTEND_PORT>/mcp`. Claude Code accepts plain http on localhost.

To try the app with made-up data, see [the sample model](import-and-export.md#try-it-with-the-sample-model).

Never commit `.env`, a secret or a model export: exports hold an organisation's data (`graph-export.json` is ignored).

## Commands

Run these from the repository root.

| Command                         | What it does                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm run dev`                   | Starts the API (with reload) and the web dev server together                                     |
| `npm run build`                 | Builds `shared/`, `backend/` and `frontend/`                                                     |
| `npm run lint`                  | Lints all workspaces with ESLint                                                                 |
| `npm run typecheck`             | Type-checks all workspaces                                                                       |
| `npm test`                      | Runs all tests once with Vitest (`npm run test:watch` to watch)                                  |
| `npm run format`                | Formats all files with Prettier (`npm run format:check` to check)                                |
| `npm run check:links`           | Checks every relative link and `#anchor` in the README, `SECURITY.md`, `guide/` and `metamodel/` |
| `npm run db:migrate -w backend` | Runs the database migrations (the API also runs them when it starts)                             |

The tests use PGlite, PostgreSQL running inside the test process.

To try the production build, with the service worker (which `npm run dev` doesn't run):

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

Pass the commit you build from, so the app names it in its startup log; without it, the commit is `unknown`:

```sh
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" .
```

## Releasing

For the maintainer. On every push to `main` and every pull request, `.github/workflows/ci.yml` runs lint, typecheck, the tests and the link check, audits the production dependencies, and builds the image for both platforms without pushing it, then checks, tests and scans the amd64 image.

To release, tag the commit whose package files hold the version, with exactly `v` and that version, and push the tag:

```sh
git tag v0.60.0
git push origin v0.60.0
```

The publish job first checks that the tag matches the version in all four `package.json` files and `package-lock.json`, and stops before anything is pushed if not. Only a tag in this repository publishes. The job then pushes the image by digest, checks, scans, signs and attests it, adds the version tags (`1.2.3` and `1.2`) only once all of that has passed, and creates the GitHub release with the notes from `guide/releases/<tag>.md`. Each step is described in the security overview's [Supply chain](security-overview.md#supply-chain).

### After a failed release run

A failed run leaves its digest in the registry, and the run's log names it (`Push the image by digest`). Anyone can pull it, and if the run got as far as signing, it even verifies. So don't leave it there:

1. Note the digest and its platform manifests: `docker buildx imagetools inspect ghcr.io/<owner>/simplearchitecture@sha256:<digest>`.
2. Delete those versions, with the signature and attestations from the same run, under Package settings → Manage versions on GitHub, or with `gh api -X DELETE /users/<owner>/packages/container/simplearchitecture/versions/<version id>`. Delete only what this run made: a released image's platform manifests also show as untagged, and deleting one breaks that release.
3. Fix the cause and tag a new version. Never move a version tag by hand onto a digest that failed.

If `Add the version tags` itself fails, its log lists each tag and where it points, and no GitHub release is made. Point a wrong tag at the right digest with `docker buildx imagetools create -t ghcr.io/<owner>/simplearchitecture:<tag> ghcr.io/<owner>/simplearchitecture@sha256:<digest>` (for `1.2`, the newest good `1.2.x`), or delete a version with no good build, and say so in the release notes.
