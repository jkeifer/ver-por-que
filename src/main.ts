/**
 * Main application logic for the Parquet Explorer (JSON Mode).
 */
import {
    InfoPanelManager,
    type BloomBlock,
    type BloomDensity,
    type BloomProbe,
    type DictionaryPreview,
    type ValuePreview,
} from './components/info-panel-manager';
import { QueryPanel } from './components/query-panel';
import { SvgByteVisualizer } from './components/svg-byte-visualizer';
import { TreemapVisualizer } from './components/treemap-visualizer';
import type { Visualizer } from './components/visualizer';
import { isParquet, isParquetURL, httpUrlOrNull } from './detect';
import { validateFile, validateMetadata, type ValidationError } from './generated/validate';
import { fetchBytes } from './js/fetch-progress';
import { getHashParam, setHashParam } from './js/permalink';
import { parseQueryState, type QueryState } from './business/pruning';
import { project, type SegmentNode } from './business/segment-tree';
import type { Resolution } from './business/query-model';
import { ParquetWorkerClient } from './js/worker/client';
import type { AnyDump } from './types';
import { BUILD_INFO } from './build-info.js';
import samples from '../samples.json';

const DB_NAME = 'ParquetExplorerDB';

/** A sample card: title/desc/meta + the dump URL it loads and its attribution. */
interface Sample {
    title: string;
    description: string;
    meta: string;
    url: string;
    source: { name: string; url: string };
}

/** The two renderers over the same segment tree. 'bytes' is the default. */
type Lens = 'bytes' | 'treemap';

interface StoredFile {
    id: string;
    data: AnyDump;
    source: string;
    timestamp: number;
}

class ParquetExplorer {
    private parquetData: AnyDump | null = null;
    // The segment tree, projected once per dump and shared by both lenses and
    // the query panel — renderers consume it, they never re-project.
    private tree: SegmentNode | null = null;
    // Bloom-filter probe against the worker's current file. Only raw-parquet
    // loads have one (the worker keeps the parsed file alive); JSON dumps and
    // restores degrade with a note.
    private bloomProbe: BloomProbe | null = null;
    // Whole-filter density reader against the worker's current file; same
    // lifecycle as the bloom probe.
    private bloomDensity: BloomDensity | null = null;
    // Single-block byte reader against the worker's current file; same lifecycle
    // as the bloom probe.
    private bloomBlock: BloomBlock | null = null;
    // Value decoder against the worker's current file; same lifecycle as the
    // bloom probe.
    private valuePreview: ValuePreview | null = null;
    // Dictionary decoder against the worker's current file; same lifecycle as
    // the value preview.
    private dictionaryPreview: DictionaryPreview | null = null;
    // For a full dump loaded from JSON (or restored) whose source is a
    // fetchable URL: the one-time boot that rehydrates the dump into the
    // worker and attaches a range reader, so bloom/preview read only the spans
    // they need. Reset on every load so the slot always matches the dump.
    private workerBooted: Promise<void> | null = null;
    private infoPanelManager: InfoPanelManager | null = null;
    private fileStructureViz: Visualizer | null = null;
    private queryPanel: QueryPanel | null = null;
    // Lens + overlay state that must survive a lens switch: the new renderer
    // starts blank, so main.ts re-selects the node and re-applies the dimming.
    private lens: Lens = 'bytes';
    private selectedNodeId: string | null = null;
    private currentResolution: Resolution | null = null;
    // Lazily created on the first raw-parquet load so the JSON path never boots
    // pyodide.
    private workerClient: ParquetWorkerClient | null = null;

    /** Initialize the application (event listeners are bound exactly once). */
    async init(): Promise<void> {
        try {
            this.setupEventListeners();

            // `?url=` is the contract for `por-que serve`, which opens
            // /?url=data.json. It wins over any previously stored file.
            const urlParam = new URLSearchParams(location.search).get('url');
            if (urlParam) {
                await this.loadURL(urlParam);
            } else {
                await this.tryLoadFromStorage();
            }
            this.hideLoadingScreen();

            // Boot pyodide in the background so the runtime is warm -- or
            // already up -- by the time the user provides a parquet file.
            // This costs JSON-only visitors the runtime download too; the
            // browser cache makes that a one-time hit.
            this.ensureWorkerClient().warmUp();
        } catch (error) {
            this.showError(`Initialization failed: ${(error as Error).message}`);
        }
    }

    private setupEventListeners(): void {
        const dropZone = document.getElementById('drop-zone')!;
        const fileInput = document.getElementById('file-input') as HTMLInputElement;

        dropZone.addEventListener('click', () => fileInput.click());
        dropZone.addEventListener('dragover', e => this.handleDragOver(e as DragEvent));
        dropZone.addEventListener('dragleave', e => this.handleDragLeave(e as DragEvent));
        dropZone.addEventListener('drop', e => this.handleDrop(e as DragEvent));

        document.body.addEventListener('dragover', e => this.handleGlobalDragOver(e as DragEvent));
        document.body.addEventListener('dragleave', e =>
            this.handleGlobalDragLeave(e as DragEvent)
        );
        document.body.addEventListener('drop', e => this.handleGlobalDrop(e as DragEvent));

        fileInput.addEventListener('change', e => {
            const files = (e.target as HTMLInputElement).files;
            if (files && files.length > 0) {
                void this.loadFile(files[0]!);
            }
        });

        const urlInput = document.getElementById('url-input') as HTMLInputElement;
        const loadUrlBtn = document.getElementById('load-url-btn')!;

        loadUrlBtn.addEventListener('click', () => {
            const url = urlInput.value.trim();
            if (url) {
                void this.loadURL(url);
            }
        });

        urlInput.addEventListener('keypress', e => {
            if ((e as KeyboardEvent).key === 'Enter') {
                const url = urlInput.value.trim();
                if (url) {
                    void this.loadURL(url);
                }
            }
        });

        this.renderSamples();

        document
            .getElementById('lens-bytes')!
            .addEventListener('click', () => this.setLens('bytes'));
        document
            .getElementById('lens-treemap')!
            .addEventListener('click', () => this.setLens('treemap'));

        document.getElementById('reset-btn')!.addEventListener('click', () => this.handleReset());
        document
            .getElementById('error-reset-btn')!
            .addEventListener('click', () => this.handleReset());
        document
            .getElementById('download-dump-btn')!
            .addEventListener('click', () => this.downloadDump());
    }

    /** Build the sample cards from the imported manifest into `.samples-list`. */
    private renderSamples(): void {
        const list = document.querySelector('.samples-list');
        if (!list) {
            return;
        }
        for (const sample of samples as Sample[]) {
            const card = document.createElement('div');
            card.className = 'sample-card';

            const button = document.createElement('button');
            button.className = 'sample-link';
            for (const [cls, text] of [
                ['sample-title', sample.title],
                ['sample-desc', sample.description],
                ['sample-meta', sample.meta],
            ] as const) {
                const span = document.createElement('span');
                span.className = cls;
                span.textContent = text;
                button.append(span);
            }
            button.addEventListener('click', () => void this.loadURL(sample.url));

            const source = document.createElement('a');
            source.className = 'sample-source';
            source.href = sample.source.url;
            source.target = '_blank';
            source.rel = 'noopener';
            source.textContent = sample.source.name;

            card.append(button, source);
            list.append(card);
        }
    }

    /** Download the loaded dump as `<source-basename>.dump.json`. */
    private downloadDump(): void {
        if (!this.parquetData) {
            return;
        }
        const source = this.parquetData.source ?? 'parquet';
        const base = (source.split(/[?#]/)[0]!.split('/').pop() || 'parquet').replace(
            /\.(parquet|json)$/i,
            ''
        );
        const blob = new Blob([JSON.stringify(this.parquetData)], { type: 'application/json' });
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(blob);
        anchor.download = `${base}.dump.json`;
        anchor.click();
        URL.revokeObjectURL(anchor.href);
    }

    private handleDragOver(e: DragEvent): void {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.add('drag-over');
    }

    private handleDragLeave(e: DragEvent): void {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.remove('drag-over');
    }

    private handleDrop(e: DragEvent): void {
        e.preventDefault();
        (e.currentTarget as HTMLElement).classList.remove('drag-over');

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            void this.loadFile(files[0]!);
        }
    }

    private handleGlobalDragOver(e: DragEvent): void {
        if (e.dataTransfer?.types.includes('Files')) {
            e.preventDefault();
            document.body.classList.add('global-drag-over');
        }
    }

    private handleGlobalDragLeave(e: DragEvent): void {
        if (e.target === document.body) {
            document.body.classList.remove('global-drag-over');
        }
    }

    private handleGlobalDrop(e: DragEvent): void {
        e.preventDefault();
        document.body.classList.remove('global-drag-over');

        const files = e.dataTransfer?.files;
        if (files && files.length > 0) {
            void this.loadFile(files[0]!);
        }
    }

    /** Load a file (por-que dump JSON or a raw .parquet) into the app. */
    async loadFile(file: File): Promise<void> {
        this.showLoadingScreen();
        this.updateLoadingStatus('Reading file...');

        try {
            await this.ingest(await file.arrayBuffer(), file.name);
        } catch (error) {
            this.showError(`Failed to parse file: ${(error as Error).message}`);
        }
    }

    /** Load a remote dump JSON or raw .parquet into the app. */
    async loadURL(url: string): Promise<void> {
        this.showLoadingScreen();

        try {
            // A .parquet URL skips the whole-file download: the worker reads
            // it in place via HTTP range requests, falling back to a full
            // download when the server (or CORS) doesn't allow ranges. Other
            // URLs (dump JSON, or parquet without the extension) are fetched
            // whole and sniffed as before.
            if (isParquetURL(url)) {
                const dump = await this.parseParquetURL(url);
                await this.parseJSON(
                    dump,
                    url,
                    this.workerBloomProbe(),
                    this.workerBloomDensity(),
                    this.workerBloomBlock(),
                    this.workerValuePreview(),
                    this.workerDictionaryPreview()
                );
                return;
            }

            this.updateLoadingStatus('Fetching remote file...');
            this.updateLoadingDetail(url);
            const bytes = await fetchBytes(url, fraction => this.updateLoadingProgress(fraction));
            await this.ingest(bytes.buffer as ArrayBuffer, url);
        } catch (error) {
            this.showError(`Failed to load URL: ${(error as Error).message}`);
        }
    }

    /**
     * Route bytes to the right parser: raw parquet goes through the pyodide
     * worker (producing a dump JSON string), everything else is treated as a
     * dump JSON document directly. Both converge on the same schema-validated
     * boundary in parseJSON.
     */
    private async ingest(buffer: ArrayBuffer, source: string): Promise<void> {
        const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
        if (isParquet(head, source)) {
            // The worker takes ownership of the buffer (postMessage detaches
            // it); nothing here needs it afterward.
            const dump = await this.parseParquet(buffer, source);
            await this.parseJSON(
                dump,
                source,
                this.workerBloomProbe(),
                this.workerBloomDensity(),
                this.workerBloomBlock(),
                this.workerValuePreview(),
                this.workerDictionaryPreview()
            );
        } else {
            this.updateLoadingStatus('Parsing JSON data...');
            await this.parseJSON(new TextDecoder().decode(buffer), source);
        }
    }

    /** Parse raw parquet bytes in the browser via the pyodide worker. */
    private parseParquet(buffer: ArrayBuffer, source: string): Promise<string> {
        return this.ensureWorkerClient().parse(buffer, source);
    }

    /** Parse a remote parquet URL via the pyodide worker (range requests). */
    private parseParquetURL(url: string): Promise<string> {
        return this.ensureWorkerClient().parseURL(url);
    }

    /**
     * Whole-file fallback for a source whose server won't serve range requests:
     * download it all (with progress) and re-ingest as a local load, so bloom
     * and value preview work against the freshly parsed file. The modal shows
     * progress.
     */
    private async downloadFullFile(url: string): Promise<void> {
        this.showLoadingScreen();
        try {
            this.updateLoadingStatus('Downloading whole file (range requests not supported)...');
            this.updateLoadingDetail(url);
            const bytes = await fetchBytes(url, fraction => this.updateLoadingProgress(fraction));
            await this.ingest(bytes.buffer as ArrayBuffer, url);
        } catch (error) {
            this.showError(`Failed to download file: ${(error as Error).message}`);
        }
    }

    /**
     * Probe routed at the worker's current-file slot, which the parse that
     * just completed populated. Valid until the next parse replaces it.
     */
    private workerBloomProbe(): BloomProbe {
        return (rowGroup, column, value) => this.workerClient!.probeBloom(rowGroup, column, value);
    }

    /** Whole-filter density reader routed at the same worker current-file slot. */
    private workerBloomDensity(): BloomDensity {
        return (rowGroup, column) => this.workerClient!.bloomDensity(rowGroup, column);
    }

    /** Single-block byte reader routed at the same worker current-file slot. */
    private workerBloomBlock(): BloomBlock {
        return (rowGroup, column, blockIndex) =>
            this.workerClient!.bloomBlock(rowGroup, column, blockIndex);
    }

    /** Value decoder routed at the same worker current-file slot. */
    private workerValuePreview(): ValuePreview {
        return (rowGroup, column, pageIndex, offset, limit, skipNulls) =>
            this.workerClient!.preview(rowGroup, column, pageIndex, offset, limit, skipNulls);
    }

    /** Dictionary decoder routed at the same worker current-file slot. */
    private workerDictionaryPreview(): DictionaryPreview {
        return (rowGroup, column, offset, limit) =>
            this.workerClient!.previewDictionary(rowGroup, column, offset, limit);
    }

    private ensureWorkerClient(): ParquetWorkerClient {
        if (!this.workerClient) {
            this.workerClient = new ParquetWorkerClient(
                status => this.updateLoadingStatus(status),
                detail => this.updateLoadingDetail(detail),
                fraction => this.updateLoadingProgress(fraction)
            );
        }
        // First parse downloads the ~12MB python runtime; the worker emits
        // status events that updateLoadingStatus surfaces.
        this.updateLoadingStatus('Loading Python runtime...');
        return this.workerClient;
    }

    private async parseJSON(
        jsonText: string,
        source: string,
        bloomProbe: BloomProbe | null = null,
        bloomDensity: BloomDensity | null = null,
        bloomBlock: BloomBlock | null = null,
        valuePreview: ValuePreview | null = null,
        dictionaryPreview: DictionaryPreview | null = null
    ): Promise<void> {
        const parsed: unknown = JSON.parse(jsonText);

        // Dispatch on the self-identifying envelope, then validate against that
        // root's schema. After this gate, downstream code trusts the shape.
        const model = (parsed as { _meta?: { model?: unknown } } | null)?._meta?.model;
        let data: AnyDump;
        if (model === 'file') {
            if (!validateFile(parsed)) {
                this.showError(this.validationMessage('file', validateFile.errors));
                return;
            }
            data = parsed;
        } else if (model === 'metadata') {
            if (!validateMetadata(parsed)) {
                this.showError(this.validationMessage('metadata', validateMetadata.errors));
                return;
            }
            data = parsed;
        } else {
            const got = typeof model === 'string' ? `"${model}"` : 'no _meta.model';
            this.showError(
                'Not a por-que dump / unsupported format — this build understands full ' +
                    'dumps (_meta.model "file") and metadata-only exports (_meta.model ' +
                    `"metadata"), got ${got}.`
            );
            return;
        }

        if (!data.source) {
            data.source = source;
        }

        this.parquetData = data;
        this.bloomProbe = bloomProbe;
        this.bloomDensity = bloomDensity;
        this.bloomBlock = bloomBlock;
        this.valuePreview = valuePreview;
        this.dictionaryPreview = dictionaryPreview;
        this.hydrateFromSource();
        await this.saveToStorage(data, source);

        this.showExplorer();
        this.populateUI();
        this.hideLoadingScreen();
    }

    /** The dump's recorded source, when it's a fetchable http(s) URL. */
    private fetchableSource(): string | null {
        return httpUrlOrNull(this.parquetData?.source);
    }

    /**
     * JSON-dump and restored loads arrive source-less, but nothing they need is
     * actually missing: a full dump carries every offset, and bloom/preview
     * lazily boot a range reader in the worker on first use (see
     * ensureWorkerBooted). So when the dump records a fetchable URL, wire those
     * byte-level features straight at it. Metadata-only dumps have no chunk/page
     * nodes to probe from, so they rely on the "load full structure" button.
     */
    private hydrateFromSource(): void {
        this.workerBooted = null;
        if (this.bloomProbe) {
            return; // a raw-parquet load already wired bloom/preview at the worker
        }
        const url = this.fetchableSource();
        if (!url) {
            return;
        }
        if (this.parquetData && 'column_chunks' in this.parquetData) {
            this.bloomProbe = (rowGroup, column, value) =>
                this.ensureWorkerBooted(url).then(() =>
                    this.workerClient!.probeBloom(rowGroup, column, value)
                );
            this.bloomDensity = (rowGroup, column) =>
                this.ensureWorkerBooted(url).then(() =>
                    this.workerClient!.bloomDensity(rowGroup, column)
                );
            this.bloomBlock = (rowGroup, column, blockIndex) =>
                this.ensureWorkerBooted(url).then(() =>
                    this.workerClient!.bloomBlock(rowGroup, column, blockIndex)
                );
            this.valuePreview = (rowGroup, column, pageIndex, offset, limit, skipNulls) =>
                this.ensureWorkerBooted(url).then(() =>
                    this.workerClient!.preview(
                        rowGroup,
                        column,
                        pageIndex,
                        offset,
                        limit,
                        skipNulls
                    )
                );
            this.dictionaryPreview = (rowGroup, column, offset, limit) =>
                this.ensureWorkerBooted(url).then(() =>
                    this.workerClient!.previewDictionary(rowGroup, column, offset, limit)
                );
        }
    }

    /**
     * Boot the worker's current-file slot for the loaded dump once (rehydrate
     * the dump JSON + attach a range reader at `url` — a footer-sized read at
     * most, never a download), then reuse it for every probe until the next
     * load resets it.
     */
    private ensureWorkerBooted(url: string): Promise<void> {
        if (!this.workerBooted) {
            const dumpJson = JSON.stringify(this.parquetData);
            this.workerBooted = this.ensureWorkerClient().bootFromDump(dumpJson, url);
        }
        return this.workerBooted;
    }

    /** First ~5 validation errors, as a single human-readable line. */
    private validationMessage(kind: string, errors?: ValidationError[] | null): string {
        const details = (errors ?? [])
            .slice(0, 5)
            .map(e => `${e.instancePath || '(root)'}: ${e.message}`)
            .join('; ');
        return `Not a valid por-que ${kind} dump: ${details || 'schema validation failed'}`;
    }

    private populateUI(): void {
        if (!this.parquetData) {
            return;
        }

        try {
            this.initializeFileStructureViz(this.parquetData);
        } catch (error) {
            console.error('Error populating UI:', error);
            this.showError(`Failed to populate UI: ${(error as Error).message}`);
        }
    }

    private initializeFileStructureViz(data: AnyDump): void {
        const container = document.getElementById('rowgroup-chart');
        if (!container) {
            return;
        }

        try {
            const canvasContainer = document.getElementById('canvas-container');
            const infoPanelContainer = document.getElementById('info-panel-container');

            if (!canvasContainer || !infoPanelContainer) {
                throw new Error('Required containers not found');
            }

            const src = this.fetchableSource();
            const metadataOnly = !('column_chunks' in data);
            this.infoPanelManager = new InfoPanelManager(
                infoPanelContainer,
                this.bloomProbe,
                this.bloomDensity,
                this.bloomBlock,
                this.valuePreview,
                this.dictionaryPreview,
                {
                    loadFullStructure: src && metadataOnly ? () => void this.loadURL(src) : null,
                    downloadFullFile: src ? () => void this.downloadFullFile(src) : null,
                }
            );

            // A new dump invalidates the previous dump's selection and dimming.
            this.selectedNodeId = null;
            this.currentResolution = null;
            // Project once here; the lenses and the query panel all share it.
            this.tree = project(data);

            // Permalink: `#lens=treemap` opens straight into the treemap
            // (only the non-default lens is ever written to the hash).
            this.lens = getHashParam(location.hash, 'lens') === 'treemap' ? 'treemap' : 'bytes';
            this.createVisualizer(data);

            // Permalink: `#node=<id>` selects that node in whatever dump just
            // loaded (file drop, URL, or IndexedDB restore). Ids that don't
            // resolve in this tree are silently ignored.
            const nodeId = getHashParam(location.hash, 'node');
            if (nodeId) {
                this.fileStructureViz!.selectNodeById(nodeId);
            }

            // Query simulation section (matrix + builder) below the structure.
            this.queryPanel = new QueryPanel(
                document.getElementById('query-panel')!,
                data,
                this.tree!,
                {
                    onUpdate: resolution => this.applyQueryRun(resolution),
                    onClear: () => this.clearQueryOverlay(),
                    loadFullStructure: src && metadataOnly ? () => void this.loadURL(src) : null,
                }
            );

            // Permalink: `#q=<json {predicates, columns}>` re-applies the query
            // simulation to the dump that just loaded (applied after `node`).
            const q = getHashParam(location.hash, 'q');
            const state = q ? parseQueryState(q) : null;
            if (state) {
                this.queryPanel.applyState(state);
            }
        } catch (error) {
            console.error('Error creating file structure visualization:', error);
            container.innerHTML =
                '<p class="viz-error">Unable to create file structure visualization</p>';
        }
    }

    /**
     * (Re)build the active lens's visualizer in the canvas container. The
     * previous one (if any) is destroyed first so its listeners don't leak.
     */
    private createVisualizer(data: AnyDump): void {
        const canvasContainer = document.getElementById('canvas-container')!;
        this.fileStructureViz?.destroy();
        this.fileStructureViz =
            this.lens === 'treemap'
                ? new TreemapVisualizer(canvasContainer, this.infoPanelManager)
                : new SvgByteVisualizer(canvasContainer, this.infoPanelManager);
        this.fileStructureViz.onSelectionChange = id => {
            this.selectedNodeId = id;
            this.syncHashNode(id);
        };
        this.fileStructureViz.initWithData(data, this.tree!);
        this.updateLensButtons();
    }

    /**
     * Switch to the other lens: same tree, new renderer. The current selection
     * is re-selected by id and any active query dimming re-applied, so the
     * views stay interchangeable mid-exploration.
     */
    private setLens(lens: Lens): void {
        if (lens === this.lens || !this.parquetData) {
            return;
        }
        this.lens = lens;
        this.createVisualizer(this.parquetData);
        if (this.selectedNodeId) {
            this.fileStructureViz!.selectNodeById(this.selectedNodeId);
        }
        this.fileStructureViz!.setDimmed(this.currentResolution?.dimmed ?? new Set());
        this.syncHashLens();
    }

    private updateLensButtons(): void {
        document
            .getElementById('lens-bytes')
            ?.classList.toggle('lens-active', this.lens === 'bytes');
        document
            .getElementById('lens-treemap')
            ?.classList.toggle('lens-active', this.lens === 'treemap');
    }

    /** Mirror the selected node into the permalink hash (`?url=` untouched). */
    private syncHashNode(id: string | null): void {
        const hash = setHashParam(location.hash, 'node', id);
        history.replaceState(null, '', location.pathname + location.search + hash);
    }

    /** Mirror the active lens into the permalink hash (default lens = no param). */
    private syncHashLens(): void {
        const hash = setHashParam(location.hash, 'lens', this.lens === 'bytes' ? null : this.lens);
        history.replaceState(null, '', location.pathname + location.search + hash);
    }

    /** Mirror the live query state (JSON) into the permalink hash. */
    private syncHashQuery(state: QueryState | null): void {
        const hash = setHashParam(location.hash, 'q', state ? JSON.stringify(state) : null);
        history.replaceState(null, '', location.pathname + location.search + hash);
    }

    // Query simulation (predicate pushdown visualization)

    /** The live query changed: dim pruned segments, overlay the info panel, sync the hash. */
    private applyQueryRun(resolution: Resolution): void {
        this.currentResolution = resolution;
        this.fileStructureViz?.setDimmed(resolution.dimmed);
        this.infoPanelManager?.setQuery(resolution);
        this.syncHashQuery(resolution.state);
    }

    /** Drop the query overlay and the `q` permalink param. */
    private clearQueryOverlay(): void {
        this.currentResolution = null;
        this.fileStructureViz?.setDimmed(new Set());
        this.infoPanelManager?.setQuery(null);
        this.syncHashQuery(null);
    }

    private async handleReset(): Promise<void> {
        this.parquetData = null;
        this.tree = null;
        this.bloomProbe = null;
        this.bloomDensity = null;
        this.bloomBlock = null;
        this.valuePreview = null;
        this.dictionaryPreview = null;
        this.workerBooted = null;
        this.lens = 'bytes';
        this.selectedNodeId = null;
        this.currentResolution = null;
        this.updateLensButtons();
        // A permalink is meaningless with no dump loaded (lens and query included).
        history.replaceState(null, '', location.pathname + location.search);
        await this.clearStorage();
        this.clearFileStructureContent();
        this.showFileInput();
    }

    private clearFileStructureContent(): void {
        this.fileStructureViz?.destroy();
        this.fileStructureViz = null;
        this.infoPanelManager = null;
        this.queryPanel = null;

        for (const id of ['canvas-container', 'info-panel-container', 'query-panel']) {
            const el = document.getElementById(id);
            if (el) {
                el.innerHTML = '';
            }
        }
    }

    // UI state management

    private showLoadingScreen(): void {
        // Leave app-main in place: the fixed, frosted overlay covers it, so the
        // current structure stays visible (blurred) behind the modal and is only
        // swapped when the load finishes and repopulates the UI — rather than the
        // page going blank the instant a load starts.
        document.getElementById('loading-screen')!.style.display = 'flex';
    }

    private hideLoadingScreen(): void {
        document.getElementById('loading-screen')!.style.display = 'none';
        document.getElementById('app-main')!.style.display = 'block';
    }

    private updateLoadingStatus(status: string): void {
        const el = document.getElementById('loading-status');
        if (el) {
            el.textContent = status;
        }
        // A new phase invalidates the previous phase's sub-step and progress.
        this.updateLoadingDetail('');
        this.updateLoadingProgress(null);
    }

    private updateLoadingDetail(detail: string): void {
        const el = document.getElementById('loading-detail');
        if (el) {
            el.textContent = detail;
        }
    }

    /** A fraction (0..1) swaps the spinner for a progress bar; null restores it. */
    private updateLoadingProgress(fraction: number | null): void {
        const spinner = document.querySelector<HTMLElement>('#loading-screen .spinner');
        const bar = document.getElementById('loading-progress') as HTMLProgressElement | null;
        if (!spinner || !bar) {
            return;
        }
        bar.hidden = fraction === null;
        spinner.style.display = fraction === null ? '' : 'none';
        if (fraction !== null) {
            bar.value = fraction;
        }
    }

    private showFileInput(): void {
        this.setDisplay('no-file-state', 'block');
        this.setDisplay('file-loaded-state', 'none');
        this.setDisplay('file-content-section', 'none');
        this.setDisplay('error-section', 'none');
    }

    private showExplorer(): void {
        this.setDisplay('no-file-state', 'none');
        this.setDisplay('file-loaded-state', 'block');
        this.setDisplay('file-content-section', 'block');
        this.setDisplay('error-section', 'none');

        const sourceElement = document.getElementById('loaded-file-source');
        if (sourceElement && this.parquetData?.source) {
            const metadataOnly = !('column_chunks' in this.parquetData);
            sourceElement.textContent =
                this.parquetData.source + (metadataOnly ? '  (metadata-only export)' : '');
        }
    }

    private showError(message: string): void {
        console.error('App Error:', message);

        const errorMessage = document.getElementById('error-message');
        if (errorMessage) {
            errorMessage.textContent = message;
        }

        this.setDisplay('error-section', 'block');
        this.hideLoadingScreen();
    }

    private setDisplay(id: string, value: string): void {
        const el = document.getElementById(id);
        if (el) {
            el.style.display = value;
        }
    }

    // Storage

    private async tryLoadFromStorage(): Promise<void> {
        try {
            const storedFile = await this.loadFromIndexedDB();
            if (storedFile) {
                this.parquetData = storedFile.data;
                this.hydrateFromSource();
                this.showExplorer();
                this.populateUI();
            }
        } catch (error) {
            console.warn('Failed to load from IndexedDB:', error);
            void this.clearStorage();
        }
    }

    private openDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);

            request.onerror = () => reject(request.error);

            request.onupgradeneeded = event => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'id' });
                }
            };

            request.onsuccess = () => resolve(request.result);
        });
    }

    private async withStore<T>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore) => IDBRequest<T>
    ): Promise<T> {
        const db = await this.openDB();
        return new Promise<T>((resolve, reject) => {
            const request = run(db.transaction(['files'], mode).objectStore('files'));
            request.onsuccess = () => {
                db.close();
                resolve(request.result);
            };
            request.onerror = () => {
                db.close();
                reject(request.error);
            };
        });
    }

    private async loadFromIndexedDB(): Promise<StoredFile | null> {
        let db: IDBDatabase;
        try {
            db = await this.openDB();
        } catch {
            return null;
        }

        // onupgradeneeded only fires on a version bump, so a pre-existing v1 DB
        // that somehow lost the 'files' store won't get it recreated by openDB.
        // Recover by deleting the DB so the next open rebuilds it clean.
        if (!db.objectStoreNames.contains('files')) {
            db.close();
            return new Promise(resolve => {
                const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
                deleteRequest.onsuccess = () => resolve(null);
                deleteRequest.onerror = () => resolve(null);
            });
        }

        return new Promise(resolve => {
            try {
                const getRequest = db
                    .transaction(['files'], 'readonly')
                    .objectStore('files')
                    .get('current-file');
                getRequest.onsuccess = () => {
                    db.close();
                    resolve((getRequest.result as StoredFile | undefined) ?? null);
                };
                getRequest.onerror = () => {
                    db.close();
                    resolve(null);
                };
            } catch {
                db.close();
                resolve(null);
            }
        });
    }

    private async saveToStorage(data: AnyDump, source: string): Promise<void> {
        try {
            await this.saveToIndexedDB(data, source);
        } catch (error) {
            console.warn('Failed to save to IndexedDB:', error);
        }
    }

    private async saveToIndexedDB(data: AnyDump, source: string): Promise<void> {
        const fileData: StoredFile = {
            id: 'current-file',
            data: data,
            source: source,
            timestamp: Date.now(),
        };
        await this.withStore('readwrite', store => store.put(fileData));
    }

    private async clearStorage(): Promise<void> {
        try {
            await this.clearIndexedDB();
        } catch (error) {
            console.warn('Failed to clear IndexedDB:', error);
        }
    }

    private clearIndexedDB(): Promise<void> {
        return new Promise(resolve => {
            const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
            deleteRequest.onsuccess = () => resolve();
            deleteRequest.onerror = () => resolve();
            deleteRequest.onblocked = () => resolve();
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const commitEl = document.getElementById('commit-hash');
    if (commitEl) {
        commitEl.textContent = BUILD_INFO.commit;
        commitEl.title = `Built ${BUILD_INFO.buildTime}`;
    }

    const app = new ParquetExplorer();
    app.init().catch((error: Error) => {
        console.error('Failed to initialize app:', error);
        const status = document.getElementById('loading-status');
        if (status) {
            status.textContent = `Error: ${error.message}`;
        }
    });
});

// Offline support: cache the app shell + pyodide runtime after one warm load so
// workshop venues with flaky wifi keep working. Production only -- dev must stay
// live-reloadable. The ?v=<commit> versions the cache and forces the service
// worker to update on every deploy.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register(`./sw.js?v=${BUILD_INFO.commit}`)
            .catch((error: unknown) => {
                console.warn('Service worker registration failed:', error);
            });
    });
}
