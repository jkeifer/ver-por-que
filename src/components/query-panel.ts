/**
 * Query simulation panel: a row-groups × columns matrix of what a query would
 * read (and why), with the predicate/projection builder beneath it.
 *
 * Rendering and input handling only — the pruning engine lives in
 * business/pruning. The delegate owns everything outside the panel (segment
 * dimming, info-panel overlay, permalink). The matrix always reflects the
 * LAST RUN evaluation crossed with the CURRENT output projection: toggling a
 * return column redraws immediately; predicates take effect on Run.
 */
import {
    evaluate,
    leafColumns,
    OP_LABEL,
    type Evaluation,
    type Op,
    type Predicate,
    type QueryState,
} from '../business/pruning';
import { escapeHtml } from './info-panel-manager';
import type { AnyDump } from '../types';

export interface QueryPanelDelegate {
    /** A query ran: overlay the evaluation on the rest of the app. */
    onRun(state: QueryState, evaluation: Evaluation): void;
    /** The query was cleared (or errored): drop any overlay. */
    onClear(): void;
}

const NOT_SELECTED = 'not selected for output — not read';

const emptyEvaluation = (): Evaluation => ({ rowGroups: new Map(), pages: new Map() });

export class QueryPanel {
    private readonly dump: AnyDump;
    private readonly delegate: QueryPanelDelegate;
    private readonly columns: string[];
    private readonly matrix: HTMLTableElement;
    private readonly rowsEl: HTMLElement;
    private readonly summaryEl: HTMLElement;
    private readonly checks: HTMLInputElement[];
    /** Last run's evaluation; empty until Run (nothing pruned). */
    private evaluation: Evaluation = emptyEvaluation();

    constructor(container: HTMLElement, dump: AnyDump, delegate: QueryPanelDelegate) {
        this.dump = dump;
        this.delegate = delegate;
        this.columns = leafColumns(dump);
        container.innerHTML = `
            <div class="query-matrix-wrap"><table class="query-matrix"></table></div>
            <div class="query-legend">
                <span><span class="qm-swatch qm-read"></span>column chunk read</span>
                <span><span class="qm-swatch qm-pruned"></span>skipped — a predicate pruned the row group</span>
                <span><span class="qm-swatch qm-skip"></span>${NOT_SELECTED}</span>
            </div>
            <div class="query-builder">
                <fieldset class="query-columns">
                    <legend>Return columns</legend>
                    ${this.columns
                        .map(
                            c =>
                                `<label><input type="checkbox" checked data-column="${escapeHtml(c)}" /> ${escapeHtml(c)}</label>`
                        )
                        .join('')}
                </fieldset>
                <div class="query-predicates">
                    <div class="query-predicate-rows"></div>
                    <button type="button" id="query-add-predicate" class="btn btn-sm">
                        Add predicate
                    </button>
                    <span class="query-predicates-note">predicates combine with AND</span>
                </div>
                <div class="query-actions">
                    <button type="button" id="query-run-btn" class="btn btn-primary btn-sm">
                        Run
                    </button>
                    <button type="button" id="query-clear-btn" class="btn btn-sm">Clear</button>
                    <span id="query-summary" class="query-summary"></span>
                </div>
            </div>`;
        this.matrix = container.querySelector('.query-matrix')!;
        this.rowsEl = container.querySelector('.query-predicate-rows')!;
        this.summaryEl = container.querySelector('#query-summary')!;
        this.checks = [...container.querySelectorAll<HTMLInputElement>('.query-columns input')];
        container
            .querySelector('#query-add-predicate')!
            .addEventListener('click', () => this.addPredicateRow());
        container.querySelector('#query-run-btn')!.addEventListener('click', () => this.run());
        container.querySelector('#query-clear-btn')!.addEventListener('click', () => this.clear());
        this.checks.forEach(cb => cb.addEventListener('change', () => this.render()));
        this.render();
    }

    /** Restore a permalink state: rebuild the builder and run it. */
    applyState(state: QueryState): void {
        const known = new Set(this.columns);
        this.rowsEl.innerHTML = '';
        state.predicates.filter(p => known.has(p.column)).forEach(p => this.addPredicateRow(p));
        const selected = new Set(state.columns);
        this.checks.forEach(cb => {
            cb.checked = selected.has(cb.dataset['column']!);
        });
        this.run();
    }

    private addPredicateRow(preset?: Predicate): void {
        const row = document.createElement('div');
        row.className = 'query-predicate';
        const options = (values: [string, string][]): string =>
            values
                .map(
                    ([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`
                )
                .join('');
        row.innerHTML = `
            <select class="qp-column" aria-label="Column">
                ${options(this.columns.map(c => [c, c]))}
            </select>
            <select class="qp-op" aria-label="Operator">
                ${options(Object.entries(OP_LABEL))}
            </select>
            <input type="text" class="qp-value" placeholder="value" />
            <button type="button" class="qp-remove btn btn-sm" aria-label="Remove predicate">
                &times;
            </button>`;
        if (preset) {
            row.querySelector<HTMLSelectElement>('.qp-column')!.value = preset.column;
            row.querySelector<HTMLSelectElement>('.qp-op')!.value = preset.op;
            row.querySelector<HTMLInputElement>('.qp-value')!.value = preset.value;
        }
        row.querySelector('.qp-remove')!.addEventListener('click', () => row.remove());
        row.querySelector('.qp-value')!.addEventListener('keypress', e => {
            if ((e as KeyboardEvent).key === 'Enter') {
                this.run();
            }
        });
        this.rowsEl.appendChild(row);
    }

    /** The builder's current predicates + projection, straight from the DOM. */
    private readState(): QueryState {
        const predicates = [...this.rowsEl.querySelectorAll('.query-predicate')].map(row => ({
            column: row.querySelector<HTMLSelectElement>('.qp-column')!.value,
            op: row.querySelector<HTMLSelectElement>('.qp-op')!.value as Op,
            value: row.querySelector<HTMLInputElement>('.qp-value')!.value,
        }));
        const columns = this.checks.filter(cb => cb.checked).map(cb => cb.dataset['column']!);
        return { predicates, columns };
    }

    private run(): void {
        const state = this.readState();
        try {
            this.evaluation = evaluate(this.dump, state.predicates);
        } catch (error) {
            // UI-level input error (bad value / unknown column): report it and
            // drop any previous run's overlay so nothing stale lingers.
            this.evaluation = emptyEvaluation();
            this.render();
            this.summaryEl.textContent = (error as Error).message;
            this.delegate.onClear();
            return;
        }
        this.render();
        this.delegate.onRun(state, this.evaluation);
    }

    private clear(): void {
        this.rowsEl.innerHTML = '';
        this.checks.forEach(cb => {
            cb.checked = true;
        });
        this.evaluation = emptyEvaluation();
        this.render();
        this.delegate.onClear();
    }

    /** Redraw the matrix + summary from the last evaluation and current projection. */
    private render(): void {
        const selected = new Set(this.readState().columns);
        const head = `<tr><th></th>${this.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
        const body = this.dump.metadata.row_groups
            .map((_, index) => {
                const decision = this.evaluation.rowGroups.get(index);
                const cells = this.columns
                    .map(column => {
                        let cls = 'qm-read';
                        let title = 'read';
                        if (!selected.has(column)) {
                            cls = 'qm-skip';
                            title = NOT_SELECTED;
                        } else if (decision?.pruned) {
                            cls = 'qm-pruned';
                            title = decision.reason;
                        }
                        return `<td class="qm-cell ${cls}" title="${escapeHtml(title)}"></td>`;
                    })
                    .join('');
                return `<tr><th>RG${index}</th>${cells}</tr>`;
            })
            .join('');
        this.matrix.innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
        this.summaryEl.textContent = this.summaryText(selected);
    }

    /** "would read X of Y column chunks in N of M row groups" (+ pages on full dumps). */
    private summaryText(selected: Set<string>): string {
        const groups = this.dump.metadata.row_groups;
        let total = 0;
        let read = 0;
        let groupsRead = 0;
        groups.forEach((group, index) => {
            const pruned = this.evaluation.rowGroups.get(index)?.pruned ?? false;
            if (!pruned) {
                groupsRead += 1;
            }
            for (const column of this.columns) {
                if (!(column in group.column_chunks)) {
                    continue;
                }
                total += 1;
                if (!pruned && selected.has(column)) {
                    read += 1;
                }
            }
        });
        const s = (n: number): string => (n === 1 ? '' : 's');
        let text =
            `would read ${read} of ${total} column chunk${s(total)} ` +
            `in ${groupsRead} of ${groups.length} row group${s(groups.length)}`;
        if (!('column_chunks' in this.dump)) {
            // Metadata-only export: the column index isn't in the dump, so
            // page-level decisions degrade to a note (once a predicate ran).
            if (this.evaluation.rowGroups.size > 0) {
                text += ' — page detail is not in a metadata-only dump';
            }
        } else if (this.evaluation.pages.size > 0) {
            const pages = this.evaluation.pages;
            const kept = [...pages.values()].filter(d => !d.pruned).length;
            text += `, ${kept} of ${pages.size} page${s(pages.size)}`;
        }
        return text;
    }
}
