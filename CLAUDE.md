# CLAUDE.md

Guidance for Claude Code working in this repo. `CONTRIBUTING.md` has the full
detail; this is the short version.

## What this is

`ver-por-que` — a framework-free TypeScript (ESM) web app that visualizes the
physical byte layout of Parquet files. It parses raw `.parquet` in the browser
(por-que compiled to WASM via pyodide, in a Web Worker) or loads a por-que dump
JSON. Bundled by Vite, no backend.

## First thing in a fresh clone

```bash
npm ci
npm run wheel   # REQUIRED once: stages the wheels AND extracts the dump JSON
                # Schema that `npm run generate` consumes. Nothing builds without it.
```

`dev`/`build`/`test`/`typecheck`/`lint` each run `generate` first, so the only
manual step is `wheel`. `src/generated/` and `static/vendor/` are gitignored —
never hand-edit generated files or the schema; to change the dump shape, bump
the wheel pin in `scripts/fetch-wheels.py`.

## The gate (run before calling work done)

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
npm run e2e     # Playwright; the @slow pyodide case needs `npm run wheel`
```

## Architecture in one breath

**load → validate against schema → `project()` the dump into ONE `SegmentNode`
tree → everything shares that tree.** Lenses (`svg-byte-visualizer`,
`treemap-visualizer`, behind the `Visualizer` interface) render it; the info
panel reads it; the query engine (`business/pruning.ts` + `query-model.ts`)
annotates it. No surface re-projects or re-derives byte offsets — every span is
a real offset off the wire. `business/` is pure (no DOM); `components/` is UI.
The worker (`src/js/worker/`) also answers bloom `probe` and value `preview`
requests. See `CONTRIBUTING.md` for the file-by-file map, and prefer the module
header docstrings — they're the design-of-record.

## Conventions

- TypeScript strict, real `import`/`export`, no global-script sharing.
- Validate at the load boundary, then trust the shape.
- New logic in `business/`/`domain/` comes with a focused Vitest test in `test/`.
- `PLAN.md` is a local-only driver scratchpad — do not commit it.
