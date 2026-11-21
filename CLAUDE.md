# Simple Architecture

An IT architecture modelling application. Architects build a relational model of their landscape (elements and relationships) against a metamodel, and view it on diagrams. The app has three spaces: **Admin** (models, properties, branding, connected apps), **Modelling** (elements, relationships and views) and **Viewing** (read-only browsing). An MCP endpoint (`/mcp`) lets AI agents query models on behalf of an architect.

## Layout and stack

- `frontend/`: React 19 and TypeScript, Vite, React Flow (`@xyflow/react`) with elkjs for layout, a Progressive Web App.
- `backend/`: Node.js 26 and TypeScript, Fastify 5 and zod. Paths `/api/...`, `/auth/...`, `/mcp`, `/oauth/...`. Migrations are in `backend/migrations/`.
- `shared/`: types and rules shared by the frontend and backend.
- `metamodel/`: the default metamodel and its JSON Graph Format (JGF) example. Models are exchanged as JGF.
- `samples/`: the made-up sample model for local runs.
- `guide/`: the documentation (index `guide/README.md`), with release notes in `guide/releases/`.
- Data is in PostgreSQL (`DATABASE_URL`); tests use PGlite. Sign-in is OpenID Connect with roles in the ID token. Delivery is one container image.

## Commands

Run from the repository root:

- `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, `npm run check:links`
- `npx vitest run --coverage` for coverage.
- Some tests run only with `THROWAWAY_DATABASE_URL` set (CI sets it) and are skipped otherwise.
- Canvas tests wait with `settle()` (`frontend/test/settle.ts`), never with fixed delays.

## Rules

- **Security first:** deny by default, least privilege, validate all input at the server (zod), no secrets in the repository or the browser. Every route and MCP tool checks sign-in and role.
- Business logic goes in services that both the REST routes and the MCP server call, not in route handlers.
- **Don't change** without the maintainer: the default metamodel in `metamodel/`, any existing migration file in `backend/migrations/`, the release workflow, or the rulesets. A new migration gets the next number.
- A stricter metamodel or validation rule must still accept existing stored models: a model that fails validation on read is hidden as damaged.
- **Made-up data only:** tests, fixtures, docs and examples use the sample model in `samples/` or invented names. No names of real people, companies or real models anywhere: code, tests, commits, pull requests or comments.
- Never commit, print or rewrite `.env`, and never commit any `graph-export.json`.
- Test and end-to-end servers never use the development ports 5173 and 3000. Check that a port is free before using it.
- No issue numbers or task marks in code, tests or workflows.
- Use npm 11 from Node 26 for any lockfile change.
- **Versioning is part of every pull request.** Each pull request raises the version in all five places: the root, `shared`, `frontend` and `backend` package files and `package-lock.json`. Raise the minor version (0.63.0 to 0.64.0) for a feature or any change users will notice, and the patch version (0.64.0 to 0.64.1) for fixes only. Start from the version on the latest `main`. Release notes for that version go in `guide/releases/v<version>.md`, linked from `guide/README.md` and from the front page. Never create a git tag: the maintainer tags, and a `v*` tag publishes an image.
- **Docs:** the README stays a short front page; everything else goes in `guide/`, one page per subject, written as the product (no "I" or "we"). A new or changed keyboard shortcut is updated in `guide/keyboard-shortcuts.md` in the same change. A change users will notice gets a line in the release notes of the version its pull request sets, under `guide/releases/`.

## Working on an issue

The `work-refined-issue` skill (`.claude/skills/work-refined-issue/`) takes the oldest issue labelled `refined` and works it into a pull request, using the agents in `.claude/agents/`.
