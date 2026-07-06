import { defineConfig } from 'vite';

export default defineConfig({
    // Deployed under a subpath (github pages / teotl.dev), so emit relative URLs.
    base: './',
    // Wheels + manifest staged by `npm run wheel`; served at /vendor/ in dev
    // and copied into dist/ on build.
    publicDir: 'static',
    worker: {
        format: 'es',
    },
});
