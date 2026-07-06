import { defineConfig } from 'vitest/config';

export default defineConfig({
    // Deployed under a subpath (github pages / teotl.dev), so emit relative URLs.
    base: './',
    // Wheels + manifest staged by `npm run wheel`; served at /vendor/ in dev
    // and copied into dist/ on build.
    publicDir: 'static',
    worker: {
        format: 'es',
    },
    test: {
        // e2e/ is playwright's, not vitest's.
        include: ['test/**/*.test.ts'],
    },
});
