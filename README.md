# ver-por-que: Parquet Explorer Web App

See why parquet with por-que, okay?

Pairs with [the python package por-que](https://pypi.org/project/por-que)
([github repo here](https://github.com/jkeifer/por-que)).

A browser-based Parquet file explorer that visualizes the physical structure of
Parquet files. This application allows you to examine how Parquet files are
organized on disk, including the layout of row groups, column chunks, and data
pages.

> [!NOTE]
> This is a young project that moves fast — expect some rough edges. Bug
> reports and PRs are welcome.

## Features

- **Two ways in**: drop, pick, or point a `?url=` at a raw `.parquet` file
  (parsed in the browser, no server) — or a por-que dump JSON if you'd rather
  parse it yourself.
- **Two lenses on the same structure**: a physical **byte-map layout** and a
  size-proportional **treemap**, switchable, with your selection carried
  between them.
- **Interactive drill-down**: click a segment — row group, column chunk, page,
  dictionary, or index — to see its details.
- **Info-panel extras**: a paged **value preview** for any data page (with
  Dremel levels and null-skipping), **dictionary values**, and an interactive
  **bloom-filter** card — probe a value through its hash → block → bit lineage,
  over a density strip of the whole filter.
- **Query simulation**: build an AND of predicates plus an output-column
  projection and watch which row groups and pages a reader would skip — and
  why, from the file's own statistics and (for `=` predicates) its bloom
  filters.
- **Shareable links**: the selected node, active lens, and query state live in
  the URL hash.
- **Works offline**: after the first load, the app shell, wheels, and Python
  runtime are cached.

## How It Works

You can feed the app two things, and it handles both:

- **A raw `.parquet` file** — dropped, picked, or pointed at via `?url=`. The
  app boots por-que itself in the browser (Python compiled to WebAssembly via
  [pyodide](https://pyodide.org/), running in a Web Worker) and produces the
  same structure dump `por-que dump` would, with no server involved.
- **A por-que dump JSON** — produced by `por-que dump file.parquet`, if you'd
  rather run the parse yourself.

Either way you then explore the visual representation of the file's physical
structure. Detection is by magic bytes (`PAR1`), so extension doesn't matter.

### In-browser parsing notes

- The first parquet parse downloads the ~12MB Python runtime from a CDN (cached
  afterward); the JSON path pays none of that cost.
- A remote `.parquet` URL is read in place via HTTP range requests — only the
  byte ranges the parser touches are downloaded. This needs the server to
  support `Range` and (cross-origin) to expose `Content-Range` via
  `Access-Control-Expose-Headers`; otherwise the app warns in the console and
  falls back to downloading the whole file.
- Page **content** decompression is not needed for the structure dump, so a
  SNAPPY-compressed file dumps fine even without the C snappy extension. Value
  previews additionally decode content: SNAPPY works via por-que's pure-python
  fallback; LZO has no in-browser decoder and previews report it as such.

## Technology Stack

- **TypeScript (ESM)**: Strict, framework-free modules bundled natively by
  Vite
- **Vite**: Bundler and dev server; native ESM in dev, so the pyodide module
  worker runs the same way in dev and production
- **Vitest / Playwright**: Vitest unit-tests the domain/business logic;
  Playwright drives an end-to-end smoke suite
- **Modern CSS**: Responsive design for an optimal viewing experience

## Getting Started

### Running Locally

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for development setup instructions.

### Using the Live App

Visit
[https://teotl.dev/ver-por-que](https://teotl.dev/ver-por-que)
to use the deployed version.

### Workflow

1. **Load a file.** Either drop a raw `.parquet` file straight in (it's parsed
   in the browser — nothing leaves your machine), or, if you'd rather parse it
   yourself, load a por-que dump JSON:

   ```bash
   pip install por-que
   por-que dump your-file.parquet > metadata.json
   ```

   Either kind can arrive by:

   - Drag and drop onto the browser window
   - File picker (click the drop zone)
   - URL input, or a `?url=` query parameter (e.g. `/?url=data.parquet`) to
     auto-load on startup — handy for linking straight to a hosted file

1. **Explore the structure**:

   - View the physical layout as a byte map, or switch to the treemap lens
   - Click segments to see details about row groups, columns, and pages —
     including value and dictionary previews and the bloom-filter probe
   - Understand how your data is compressed and encoded

1. **Simulate a query** (optional): build predicates and pick output columns to
   see which row groups and pages a reader would skip, and why.

## Contributing

Contributions are welcome — [open an
issue](https://github.com/jkeifer/ver-por-que/issues) to report a bug or
request a feature, or send a pull request. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for development setup, the architecture,
and the test/gate commands.

## License

Apache License 2.0, same as [por-que](https://github.com/jkeifer/por-que) (see [`LICENSE`](./LICENSE)).

## Resources

- [Por Que Library](https://github.com/jkeifer/por-que)
- [Apache Parquet Format](https://parquet.apache.org/)
