#!/usr/bin/env node
/**
 * Validate a por-que dump file with the EXACT ajv validator the webapp uses
 * (src/generated/validate.js, generated from the pinned wheel schema by
 * `npm run generate` -- run that first). Dispatches on `_meta.model` the same
 * way main.ts does. Exits non-zero on failure so the Overture workflow refuses
 * to publish a dump the app can't load.
 *
 * Usage: node scripts/validate-dump.mjs <dump.json> [more.json ...]
 */
import { readFileSync } from 'node:fs';
import { validateFile, validateMetadata } from '../src/generated/validate.js';

const files = process.argv.slice(2);
if (files.length === 0) {
    console.error('usage: node scripts/validate-dump.mjs <dump.json> [...]');
    process.exit(2);
}

let failed = false;
for (const file of files) {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const model = data?._meta?.model;
    const validate =
        model === 'file' ? validateFile : model === 'metadata' ? validateMetadata : null;
    if (!validate) {
        console.error(`${file}: unknown _meta.model ${JSON.stringify(model)}`);
        failed = true;
        continue;
    }
    if (validate(data)) {
        console.log(`${file}: valid (${model})`);
    } else {
        console.error(`${file}: INVALID (${model})`);
        for (const e of (validate.errors ?? []).slice(0, 5)) {
            console.error(`  ${e.instancePath || '(root)'}: ${e.message}`);
        }
        failed = true;
    }
}

process.exit(failed ? 1 : 0);
