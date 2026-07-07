import { describe, it, expect } from 'vitest';
import { isIncrementalReadError } from '../src/components/info-panel-manager';

describe('isIncrementalReadError', () => {
    it('matches range-unsupported failures', () => {
        expect(
            isIncrementalReadError(new Error('server does not support HTTP range requests'))
        ).toBe(true);
        expect(isIncrementalReadError(new Error('HctefNetworkError: range probe failed'))).toBe(
            true
        );
    });
    it('ignores unrelated failures', () => {
        expect(isIncrementalReadError(new Error('KeyError: no column nope'))).toBe(false);
        expect(isIncrementalReadError(new Error('codec_unavailable'))).toBe(false);
        expect(isIncrementalReadError(undefined)).toBe(false);
    });
});
