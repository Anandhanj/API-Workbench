# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

API Workbench is an Electron desktop app for API testing and visual workflow automation — an offline-first Postman alternative that keeps OpenAPI-imported collections in sync, executes REST requests, and runs drag-and-drop API workflows. Everything is stored locally in SQLite; there is no mandatory cloud dependency.

The repo is an npm-workspaces monorepo, but currently the only real package is `apps/desktop` (`@api-workbench/desktop`). Root scripts delegate into that workspace.

## Commands

Run from the repo root (they delegate to the desktop workspace):

- `npm run dev` — start the app in dev (electron-vite, HMR renderer + main).
- `npm run build` — typecheck then build the production bundle.
- `npm run typecheck` — type-checks **both** projects (`tsconfig.node.json` for main/preload/shared, `tsconfig.web.json` for renderer). A single tsconfig does **not** cover the whole tree — always run the combined script.
- `npm run lint` — ESLint, `--max-warnings 0` (warnings fail).
- `npm run format` / `npm run format:check` — Prettier across the repo.
- `npm test` — Vitest (run mode). `npm run test:coverage` for coverage.

Running a single test (from `apps/desktop`, or pass through with `--workspace @api-workbench/desktop`):

- `npx vitest run src/main/workflows/__tests__/workflow-engine.test.ts` — one file.
- `npx vitest run -t "merges scopes by precedence"` — by test name.
- `npx vitest` — watch mode (also `npm run test:watch`).

### Native module note

Persistence uses `better-sqlite3`, a native module that must match Electron's ABI. `postinstall` runs `electron-rebuild` automatically. If the app fails to start with a `NODE_MODULE_VERSION` / ABI mismatch error, run `npm run rebuild:native`. Tests do **not** hit this: the persistence layer is driver-agnostic and tests run against `sql.js` (pure WASM), so no native build is needed to run the suite.

## Architecture

### Three-process Electron model

Code is split by Electron process under `apps/desktop/src/`, and the split is enforced — keep code on the correct side:

- `main/` — Node/Electron main process. Owns the database, filesystem, network execution, secrets, and all business logic. Organized into feature modules (see below).
- `renderer/` — the React UI (Vite + React 18 + Tailwind/shadcn + Zustand + React Query + React Router via **hash** routing). Has no Node access.
- `preload/` — the only bridge between the two. Exposes `window.workbench` via `contextBridge` with an **allowlist** of channels and a single typed event subscription — there is no generic "invoke any channel" escape hatch.
- `shared/` — isomorphic code imported by all three sides, chiefly the **IPC contract** and its Zod schemas/DTOs.

Path aliases (configured in `electron.vite.config.ts` and `vitest.config.ts`): `@shared`, `@main`, `@renderer`. Use these rather than long relative paths.

### The IPC contract is the spine

[apps/desktop/src/shared/ipc-contract.ts](apps/desktop/src/shared/ipc-contract.ts) is the single source of truth for every cross-process call. Each channel declares a Zod schema for its request and response. This same module is imported by:

- the **main** handler registry ([main/ipc/index.ts](apps/desktop/src/main/ipc/index.ts)), which validates every inbound request **and** every outbound response against the schema — a validation failure is rejected and logged, never processed;
- the **preload** bridge, which bundles the contract (it can't `require` external modules in the sandbox) and allowlists channel names;
- the **renderer** client ([renderer/src/lib/ipc.ts](apps/desktop/src/renderer/src/lib/ipc.ts)), which is fully typed off the contract and falls back gracefully when run outside Electron (unit tests / plain browser).

**To add a feature that crosses the process boundary:** define the DTOs/schemas in a `shared/*.ts` module, register the channel in `IpcChannels`, add the handler in `main/ipc/index.ts`, and call it from the renderer via the typed `invoke`. The wire format cannot drift because both sides share the schema.

Security posture is hardened (ADR-0003): context isolation on, node integration off, sandbox on, navigation and new-window creation blocked. Don't weaken these in `main/index.ts`.

### Main-process service composition

`main/index.ts` is the composition root: it opens the SQLite DB, constructs every service, wires them together, then calls `registerIpcHandlers(services)`. Services are constructed with their dependencies injected (e.g. `VariableService` takes a `PersistenceService` and an `Encryptor`), which is what keeps them testable without Electron.

Each feature module under `main/` is a self-contained unit with a barrel `index.ts`, its own `__tests__/`, and usually a `README.md` + `Architecture.md` describing it. Key modules:

- `persistence/` — SQLite via Drizzle. `PersistenceService` is the facade exposing repositories, transactions, and backup/restore. Schema changes go through numbered migrations in `persistence/migrations/` (see "Migrations" below).
- `openapi/` — import (OpenAPI 3.x / Swagger 2, JSON/YAML) and **sync** (re-import a changed spec, merging without losing manual edits).
- `execution/` — REST request execution behind a `Transport` port (`FetchTransport` in prod). Resolves `{{variables}}` via an injected evaluate callback.
- `variables/` — scoped variable engine + secret encryption (see below).
- `auth/` — credential storage and request signing (Bearer, OAuth2, Basic, Digest, API Key, AWS SigV4, client certs).
- `workflows/` — the workflow engine (see below).
- `versioning/` — snapshot / diff / restore of collections. Note the IPC layer **auto-snapshots** around import and around sync so a merge can be rolled back.
- `testing/`, `scripting/` — assertion/test runner and the pre-request / post-response script sandbox.

### Cross-cutting wiring to know

Several services are deliberately reused rather than duplicated — preserve this when changing them:

- **Workflow request nodes reuse the execution engine.** In `main/index.ts`, `WorkflowService` is given an `executeRequest` port that resolves stored credentials (`credentialId` → `auth.getConfig`) and calls `execution.run`. Workflows do not have their own HTTP path.
- **Variables flow through one evaluator.** `ExecutionService`, `WorkflowService`, and the script sandbox all call `variables.evaluate`/`variables.resolve`. The workflow engine threads a mutable `runtime` map through the run — set-variable and sub-workflow nodes write to it, and that's how values propagate between steps (`RunContext` in [workflow-engine.ts](apps/desktop/src/main/workflows/workflow-engine.ts)).
- **In-flight cancellation** lives in the IPC layer: `request.execute`/`workflow.run` register an `AbortController`/`RunController` in a map keyed by id so `*.cancel`/`*.pause`/`*.resume` can reach them.

### Variables & secrets

Scope precedence (low → high): `global < workspace < collection < folder < request < workflow < runtime`. Only scopes present in the resolve context are pulled. Secret resolution and decryption happen **only in the main process** — `list`/`get` never return secret plaintext to the renderer (the DTO omits the value and exposes `hasValue`). Encryption is behind an `Encryptor` port: `SafeStorageEncryptor` (OS keychain, production, imports `electron` so it's never imported by tests) vs `NodeEncryptor` (AES-256-GCM, test/fallback).

## Conventions

- **Migrations are append-only.** Add `persistence/migrations/000N-<name>.ts` (version, name, up/down SQL), append it to `MIGRATIONS` in `migrations/index.ts`, and update `schema.ts` to match. Never edit a released migration — its checksum is recorded and a changed checksum is rejected as tampering.
- **Don't import `electron` into testable code.** Anything that needs Electron (safeStorage, app paths) is injected as a port so the module stays unit-testable against `sql.js`/`NodeEncryptor`. Only `main/index.ts` (and prod-only encryptors/transports) touch Electron directly.
- Tests are colocated in `__tests__/` dirs or as `*.test.ts(x)` next to the source; Vitest runs `jsdom` with the setup in `vitest.setup.ts`.
- The renderer uses **hash** routing (`createHashRouter`) because production loads from a `file://` URL.

## Docs

The project is delivered phase-by-phase; design intent lives in `docs/`. Read these when a change touches architecture: `docs/architecture/ARCHITECTURE.md`, the ADRs in `docs/adr/` (esp. 0003 IPC/security, 0004 persistence, 0005 & 0008 workflow engine, 0006 secrets), and the per-module `README.md` / `Architecture.md` inside `main/*`.
