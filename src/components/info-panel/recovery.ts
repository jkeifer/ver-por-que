/**
 * Degraded-card recovery. On-demand byte reads (value/dictionary previews, the
 * bloom probe) all hit the same wall when a server won't serve HTTP range
 * requests; this detects that failure and renders a full-file fallback action.
 */

export const RANGE_UNSUPPORTED_MESSAGE =
    "This file can't be read incrementally (HTTP range requests not supported).";

/**
 * Recovery actions for degraded cards: re-parse the file from its URL to gain
 * full structure (metadata-only dumps), or download the whole file when the
 * server won't serve range requests. Null when the loaded dump has no fetchable
 * source (no recovery possible).
 */
export interface RecoveryActions {
    loadFullStructure: (() => void) | null;
    downloadFullFile: (() => void) | null;
}

/** True when a byte read failed because the server won't serve range requests. */
export function isIncrementalReadError(error: unknown): boolean {
    const message = (error as Error | undefined)?.message ?? '';
    return (
        message.includes('HctefNetworkError') ||
        message.includes('does not support HTTP range') ||
        message.includes('range request')
    );
}

/** Render `message` in `el`, plus a wired recovery button when `action` exists. */
export function appendRecovery(
    el: HTMLElement,
    message: string,
    label: string,
    action: (() => void) | null
): void {
    el.textContent = message;
    if (action) {
        el.append(' ');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn recovery-btn';
        btn.textContent = label;
        btn.addEventListener('click', action);
        el.appendChild(btn);
    }
}
