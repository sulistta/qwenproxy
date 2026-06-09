# Repository Guidelines

## Project Structure & Module Organization

This is a TypeScript ESM service that exposes an OpenAI-compatible proxy for Qwen through Hono and Playwright. Runtime code lives in `src/`: `api/` defines the Hono server and model endpoints, `routes/` contains request handlers, `services/` wraps Qwen and Playwright automation, `core/` owns accounts, config, database, metrics, and logging, and `utils/`, `tools/`, and `cache/` hold shared helpers. Tests are colocated under `src/tests/`; binary and media fixtures live in `src/tests/media/`. The CLI entrypoint is `bin/qwenproxy.mjs`. Persistent local runtime data such as `data/` and `qwen_profiles/` should not be treated as source.

## Build, Test, and Development Commands

- `npm run setup`: install dependencies, install Playwright browsers, and create `.env` from `.env.example` when needed.
- `npm start`: run the proxy with the default Chromium browser at `http://localhost:3000`.
- `npm run start:firefox|start:chrome|start:edge`: run with a specific browser.
- `npm run login`: open the account/session manager; browser-specific variants mirror the start commands.
- `npm test`: run Node’s built-in test runner over `src/**/*.test.ts`.
- `npm run typecheck`: run `tsc --noEmit` with strict TypeScript settings.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM imports, and the existing 2-space indentation style. Keep filenames descriptive and kebab-case for multiword modules, for example `account-manager.ts` or `context-truncation.ts`. Prefer named exports for shared utilities and keep route/service/core boundaries clear. There is no dedicated formatter script, so match nearby code and run `npm run typecheck` before submitting.

## Testing Guidelines

Tests use `node:test` and `node:assert`. Name test files `*.test.ts` under `src/tests/`, and keep fixtures in `src/tests/media/`. Mock external Qwen and Playwright behavior when possible; set test-specific environment variables in the test file instead of relying on local `.env`. Run `npm test` for behavior changes and `npm run typecheck` for all TypeScript changes.

## Commit & Pull Request Guidelines

Git history is currently minimal (`Initial commit`), so keep commit subjects concise, imperative, and focused on intent. Include a body when behavior, configuration, or migration details matter. Pull requests should describe the change, list verification commands run, link related issues, and include screenshots or sample API responses for user-visible route or streaming behavior changes.

## Security & Configuration Tips

Do not commit `.env`, credentials, SQLite files in `data/`, or browser profiles in `qwen_profiles/`. Use `.env.example` for documenting configuration. Treat Qwen account data and `API_KEY` values as secrets, and prefer mocked tests over calls to real external accounts.
