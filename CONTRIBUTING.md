# Contributing to ver-por-que

Thank you for your interest in contributing to ver-por-que! This guide will
help you get started with development and contributing to the project.

## 🚀 Quick Start

### Prerequisites

- Node.js (v24 recommended; matches CI)
- npm
- Git

### Setup

1. **Clone the repository**

   ```bash
   git clone https://github.com/jkeifer/ver-por-que.git
   cd ver-por-que
   ```

2. **Install dependencies and stage the wheels**

   ```bash
   npm install
   npm run wheel
   ```

   `npm run wheel` downloads the pinned por-que/hctef wheels into
   `static/vendor/` and extracts the dump JSON Schema from the por-que
   wheel — `npm run generate` (run automatically by the other scripts)
   needs that schema.

3. **Start the development server**

   ```bash
   npm run dev
   ```

   The application will, by default, be available at
   [`http://localhost:5173`](http://localhost:5173) (Vite's default port)

4. **Test the application**

   You'll need a JSON file from the [por-que Python
   library](https://github.com/jkeifer/por-que) to test:

   ```bash
   pip install por-que
   por-que dump your-file.parquet > test-metadata.json
   ```

   Then drag the `test-metadata.json` file into the browser window.

## 🏗️ Development Workflow

### Available Commands

| Command                | Description                                        |
| ---------------------- | ------------------------------------------------- |
| `npm run generate`     | Generate types + validator from the JSON Schema   |
| `npm run wheel`        | Stage the pinned wheels + extract the dump schema |
| `npm run dev`          | Start development server with hot reload          |
| `npm run build`        | Build for production                              |
| `npm run preview`      | Serve the production build from `dist/`           |
| `npm run typecheck`    | Type-check with `tsc --noEmit`                    |
| `npm test`             | Run unit tests with Vitest                        |
| `npm run e2e`          | Run the Playwright end-to-end smoke suite         |
| `npm run lint`         | Check code style and quality                      |
| `npm run lint:fix`     | Auto-fix linting issues                           |
| `npm run format`       | Format code with Prettier                         |
| `npm run format:check` | Check code formatting                             |

`dev`, `build`, `test`, `typecheck`, and `lint` each run `generate` first (via
npm pre-hooks), so a fresh clone only needs `npm run wheel` before any of
them. `generate` reads `static/vendor/por-que.schema.json` — the canonical
contract for the dump JSON (a union of the `file` and `metadata` roots),
extracted from the pinned [por-que](https://github.com/jkeifer/por-que) wheel
by `npm run wheel` — and emits `src/generated/` (gitignored):

- `por-que.d.ts` — TypeScript types ([json-schema-to-typescript])
- `validate.js` / `validate.d.ts` — standalone AJV validators (one per root)
  used at the load boundary in `main.ts`

The schema comes out of the exact wheel the app runs in the browser, so the
validator cannot drift from the runtime. To change the schema, release a new
por-que version and bump the wheel pin in `scripts/fetch-wheels.py`; never
edit the generated files.

[json-schema-to-typescript]: https://github.com/bcherny/json-schema-to-typescript

### In-browser parquet parsing

Dropping a raw `.parquet` file runs por-que in the browser via
[pyodide](https://pyodide.org/) in a Web Worker (`src/js/worker/`). A remote
`.parquet` URL is parsed the same way, but in place via HTTP range requests
(hctef's `AsyncHttpFile`, pyfetch transport) instead of a whole-file download,
falling back to a full download when the server (or CORS) doesn't allow
ranges. The worker needs por-que and hctef wheels as static assets:

```bash
npm run wheel   # downloads the wheels into static/vendor/ (gitignored), once
```

- The wheels are pinned [por-que](https://pypi.org/project/por-que/) and
  [hctef](https://pypi.org/project/hctef/) releases, downloaded from PyPI and
  hash-verified by [`scripts/fetch-wheels.py`](./scripts/fetch-wheels.py). To
  bump a version, update the pins (filename, URL, sha256) at the top of that
  script.
- Without the wheels, the pyodide integration test skips — but `npm run wheel`
  is still required once per clone, since it also extracts the dump schema
  that `npm run generate` consumes.
- pyodide itself loads from a CDN, pinned to one version constant in
  `src/js/worker/worker.ts` (keep it equal to the `pyodide` devDep).
- The parse never decompresses page content, so the structure dump needs no
  compression libs; value previews decode content and rely on por-que's
  pure-python codec fallbacks (SNAPPY works, LZO doesn't). Static assets under `static/` are Vite's
  `publicDir`: served at the site root in dev and copied into `dist/` on build.

### Pre-commit Hooks

The project uses [prek](https://prek.j178.dev) (`.pre-commit-config.yaml`),
installed via the `@j178/prek` npm package, to run quality checks on staged
JS/TS files before commits:

- **ESLint**: Code quality and style checks (`npm run lint:fix`)
- **Prettier**: Code formatting (`npm run format`)

The `prepare` script installs the git hooks automatically on `npm install`;
run `npx prek install` to set them up manually. All hooks are
`language: system` running the npm scripts above, so prek never builds hook
environments. If pre-commit hooks fail, fix the issues before committing:

```bash
npm run lint:fix
npm run format
```

## 🏛️ Architecture Overview

### Project Structure

```plaintext
index.html                 # HTML entry point (repo root; loads /src/main.ts as a module)
static/                    # Vite publicDir (served at site root, copied into dist/)
├── sw.js                  # Hand-written service worker (offline cache-first)
└── vendor/                # STAGED (gitignored) by `npm run wheel`: wheels + dump schema
src/
├── css/styles.css         # Styles
├── main.ts                # Controller: load → validate → project → drive lenses/panel/query
├── detect.ts              # Parquet-vs-JSON detection by magic bytes; URL helpers
├── format.ts              # Shared byte/number formatting helpers
├── types.ts               # Friendly aliases over the schema-generated types
├── build-info.{js,d.ts}   # Git commit info, written at build time by get-git-info.js
├── generated/             # GENERATED (gitignored): por-que.d.ts + validate.js/.d.ts
├── js/
│   ├── permalink.ts       # URL-hash state (de)serialization (#node=, lens=, q=)
│   ├── fetch-progress.ts  # Streaming URL→bytes with download-progress reporting
│   ├── storage.ts         # IndexedDB persistence of the loaded dump (restore on reload)
│   └── worker/            # In-browser parquet parsing (pyodide in a Web Worker)
│       ├── client.ts          # Main-thread handle; lazily spins up the worker
│       ├── worker.ts          # Worker shell (loads pyodide from the CDN)
│       ├── pyodide-parquet.ts # Worker-agnostic boot/parse/probe/preview (node-testable)
│       └── protocol.ts        # Request/response message shapes (kind-tagged unions)
├── domain/
│   ├── parquet-type-resolver.ts # Logical-type pretty-printing / display logic
│   └── geoparquet.ts            # GeoParquet `geo` metadata: WKB columns, display types
├── business/                        # Pure logic (no DOM)
│   ├── segment-tree.ts              # project(): validated dump → SegmentNode tree
│   ├── segment-layout-calculator.ts # Byte positions for the byte-map lens
│   ├── min-sizing.ts                # Minimum-sizing math shared by both lenses
│   ├── treemap-layout.ts            # squarify(): size-proportional rectangles
│   ├── stat-values.ts               # Decode base64 statistics bytes → comparable values
│   ├── wkb.ts                       # WKB geometry parsing (summaries, GeoJSON copy)
│   ├── pruning.ts                   # Predicate-pushdown pruning engine
│   └── query-model.ts               # resolve(): per-segment status under a query
├── components/
│   ├── visualizer.ts              # Visualizer interface (the lens contract)
│   ├── svg-byte-visualizer.ts     # Byte-map lens renderer
│   ├── svg-funnels.ts             # Drill-down funnel shapes for the byte-map lens
│   ├── treemap-visualizer.ts      # Treemap lens renderer
│   ├── info-panel-manager.ts      # Info-panel orchestration + DOM wiring
│   ├── info-panel/                # The panel's modules (pure rendering + widgets)
│   │   ├── panels.ts              # Declarative kind → panel sections registry
│   │   ├── view.ts                # Row/Section types, escaping, copy buttons
│   │   ├── column-rows.ts         # Column metadata/stats/index-table builders
│   │   ├── preview-view.ts        # Value/dictionary preview table rendering
│   │   ├── bloom-probe-widget.ts  # Interactive bloom card (probe + block strip)
│   │   ├── bloom-view.ts          # Pure bloom rendering (bit grids, density strip)
│   │   ├── capabilities.ts        # Worker-backed capability types (WorkerCapabilities)
│   │   └── recovery.ts            # Degraded-card recovery (range-unsupported fallback)
│   └── query-panel.ts             # Query-simulation panel (matrix + builder)
└── config/
    └── visualization-config.ts     # Layout constants + kind → color map
```

Everything is TypeScript ESM using real `import`/`export`; there is no
global-script sharing. Unit tests live in `test/` and run under Vitest.

### Key Components

The core dataflow: **load → validate → `project()` once → share one
`SegmentNode` tree** across every surface. Lenses render the tree, the info
panel reads it, and the query engine annotates it — none of them re-project or
re-derive offsets.

#### ParquetExplorer (`main.ts`)

- Main application controller; loads files (local, URL, or `?url=`), raw
  `.parquet` or dump JSON
- Validates the dump against the schema at the boundary, then trusts the shape
- Projects the tree once and coordinates the active lens, info panel, and query
  panel; owns permalink hash state

#### project (`business/segment-tree.ts`)

- One recursive pass turns a validated dump into a `SegmentNode` tree
  (`projectDump` / `projectMetadataExport` behind the `project` dispatcher)
- Every span is a REAL byte offset off the wire — nothing is estimated
- A node's `kind` (a string-literal union) says what it is; its `children` are
  the next drill-down level

#### Visualizer lenses (`components/visualizer.ts` + renderers)

- `Visualizer` is the lens contract — a renderer over the shared tree
- `SvgByteVisualizer` (+ `svg-funnels.ts`) is the byte-map lens: children per
  level, colored by `kind`, funnels animating each drill-down
- `TreemapVisualizer` is the size-proportional lens (area ∝ span)
- Selection and query dimming carry across lenses; the active lens is
  permalinked

#### Query engine (`business/pruning.ts` + `query-model.ts`)

- `pruning.ts` simulates predicate pushdown: which row groups (footer stats)
  and pages (column index) a reader would skip, each with a stated reason;
  never guesses on unsupported types or missing stats
- `query-model.ts` `resolve()` turns that into one per-segment status the
  matrix, info panel, and lenses all consume
- `stat-values.ts` decodes the base64 statistics bytes into comparable values
- `QueryPanel` (`components/query-panel.ts`) is the RG×column matrix + predicate
  builder; evaluation is live. On raw-parquet loads it also probes the file's
  bloom filters for `=` predicates (async, cached) and folds the misses back
  into the evaluation as row-group prunes the min/max range couldn't make

#### Info panel (`components/info-panel-manager.ts` + `components/info-panel/`)

- The manager is orchestration + DOM wiring; the pure rendering lives in the
  `info-panel/` modules. `panels.ts` is the declarative registry: one handler
  per segment `kind` mapping a node to its sections
- The interactive cards — the paged value preview, the dictionary preview, and
  the bloom-probe widget (probe lineage + virtualized block strip over a
  density minimap) — round-trip to the worker through the `WorkerCapabilities`
  bundle (`capabilities.ts`); JSON/metadata-only loads pass null and the cards
  degrade honestly (`recovery.ts` offers re-parse / full-download fallbacks)

#### Layout math (`business/segment-layout-calculator.ts`, `min-sizing.ts`, `treemap-layout.ts`)

- Byte positions for the byte-map lens; `squarify()` for the treemap;
  `min-sizing.ts` floors tiny segments so metadata stays visible next to huge
  data spans (shared by both lenses)

#### Worker (`js/worker/`)

- pyodide + por-que/hctef parse `.parquet` off the main thread and answer the
  follow-up requests against the current-file slot: bloom `probe` /
  `bloomDensity` / `bloomBlocks`, value `preview` / `dictionaryPreview`, `boot`
  (rehydrate a JSON dump + attach a range reader), and `prefetchBlooms`;
  `protocol.ts` is the message contract (kind-tagged request/response unions)

## 🎯 Contributing Guidelines

### Code Style

The project uses ESLint and Prettier with the following conventions:

#### Code Conventions

- **TypeScript (strict)**: No framework dependencies; `npm run typecheck` must pass
- **ESM**: Real `import`/`export`, no global-script sharing
- **Descriptive variable names** over comments
- **Separation of concerns**: Domain, business, and UI layers

### Making Changes

1. **Create a feature branch**

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**

   - Follow existing code patterns
   - Keep changes focused and atomic
   - Test your changes manually with sample Parquet files

3. **Test your changes**

   ```bash
   npm run lint
   npm run build
   ```

   Test the built application in `dist/` directory.

4. **Commit your changes**

   ```bash
   git add .
   git commit -m "feat: add your feature description"
   ```

   Pre-commit hooks will run automatically.

5. **Push and create a pull request**

   ```bash
   git push origin feature/your-feature-name
   ```

### Pull Request Process

1. **Ensure code quality**: All linting and formatting checks must pass
2. **Test manually**: Verify your changes work with real Parquet files
3. **Update docs**: Update README or this file if adding features
4. **Describe changes**: Provide clear description in PR

## 🚀 Deployment

### GitHub Pages Deployment

The site deploys to GitHub Pages when a GitHub release is published:

1. **Publish a release** (or trigger the workflow manually)
2. **GitHub Actions** builds and deploys automatically
3. [**Visit** the live site](https://teotl.dev/ver-por-que)

The deployment workflow is in `.github/workflows/deploy.yml`.

### Build Process

```bash
npm run build              # Production build (runs generate + get-git-info.js first)
```

Output goes to `dist/` directory with assets at `./` public URL.

## 🐛 Debugging & Troubleshooting

### Common Issues

#### Development Server Won't Start

```bash
rm -rf node_modules/.vite
npm run dev
```

#### Linting Errors

```bash
npm run lint:fix          # Auto-fix most issues
npm run format            # Format code
```

#### Build Issues

```bash
rm -rf node_modules/.vite dist  # Clear caches
npm run build                   # Rebuild
```

#### JSON File Won't Load

- Ensure the JSON file is from a recent version of por-que
- Check browser console for errors
- Verify the JSON structure matches expected format

## 🧪 Testing

Unit tests run under [Vitest](https://vitest.dev/) (`npm test`) and live in
`test/`. They cover the pure logic: formatting and detection helpers, the
segment layout calculator, min-sizing and treemap layout, the pruning/query
engine and statistics decoding, WKB geometry parsing, permalink
(de)serialization, and the tree projection (`project`). The projection tests read real dump fixtures from
`test/fixtures/` (vendored from por-que's test suite), assert the validator
accepts them and rejects mutations, and check the tree has real offsets, sorted
children, and correct `kind` coverage. New logic in those layers should come
with a focused test.

`test/pyodide-parquet.integration.test.ts` is the integration check for
in-browser parsing: it boots real pyodide, installs the locally-built wheels,
parses a real parquet file — from bytes, and from a URL served by a local
range-supporting HTTP server (plus the no-range fallback) — and asserts the
dumps pass the validator. It also exercises the follow-up requests (bloom
probe/density/blocks and prefetch, value/dictionary previews, dump boot). It
skips (with a message) when the wheels are absent, so run `npm run wheel`
first — CI does. Its parquet fixtures are committed under `test/fixtures/`
(vendored from `apache/parquet-testing` at the same ref as the python
fixtures), so the suite runs offline; it has a long timeout for the pyodide
boot. A lighter `pyodide-parquet.mock.test.ts` covers the same code paths
without booting pyodide.

End-to-end tests run under [Playwright](https://playwright.dev/) (`npm run
e2e`, `e2e/smoke.spec.ts`): they drive the built app in a real browser —
loading a fixture, drilling in, switching lenses, exercising the query panel,
and reloading offline. The `@slow` pyodide case needs the wheels; CI runs the
suite as a separate `e2e` job.

Welcome additions:

- Visual regression tests for the byte visualizer

## 🤝 Community

- **Issues**: Report bugs or request features on [GitHub
  Issues](https://github.com/jkeifer/ver-por-que/issues)
- **Discussions**: Use GitHub Discussions for questions and ideas

## 📋 Development Tips

### Testing with Different Parquet Files

Generate test files with different characteristics:

```bash
# Simple file
por-que dump simple.parquet > simple.json

# File with multiple row groups
por-que dump large-file.parquet > multi-rowgroup.json

# File with nested schema
por-que dump nested.parquet > nested.json
```

### Debugging Visualization Issues

- Use browser DevTools to inspect SVG elements
- Check the console for layout calculation logs
- Verify segment data structure in `ParquetExplorer.parquetData`

### Performance Considerations

- Large Parquet files (many row groups/columns) can create complex
  visualizations
- Consider viewport optimization for files with thousands of segments
- SVG performance may degrade with very detailed visualizations
