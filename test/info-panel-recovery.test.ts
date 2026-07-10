import { describe, it, expect } from 'vitest';
import { isIncrementalReadError } from '../src/components/info-panel-manager';

describe('isIncrementalReadError', () => {
    it('matches range-unsupported failures by exception class name', () => {
        expect(
            isIncrementalReadError(
                new Error('hctef.exceptions.RangeRequestsUnsupportedError: server ignored Range')
            )
        ).toBe(true);
    });
    it('ignores transient network failures and unrelated errors', () => {
        expect(isIncrementalReadError(new Error('HctefNetworkError: HTTP 503'))).toBe(false);
        expect(isIncrementalReadError(new Error('KeyError: no column nope'))).toBe(false);
        expect(isIncrementalReadError(new Error('codec_unavailable'))).toBe(false);
        expect(isIncrementalReadError(undefined)).toBe(false);
    });
});
