#!/usr/bin/env python3
"""Download the pinned por-que and hctef wheels and stage them for the webapp.

The webapp parses raw .parquet files in the browser via pyodide, which needs
por-que and hctef wheels as static assets. This downloads the pinned releases
from PyPI, verifies their hashes, and stages them, plus a tiny manifest, into
``static/vendor/`` (gitignored). It also extracts ``por_que/dump-schema.json``
from the por-que wheel to ``static/vendor/por-que.schema.json``, which
``npm run generate`` codegens types and validators from -- so the validator
can never drift from the runtime. The pyodide integration test skips itself
when the manifest is absent.

Already-staged wheels with matching hashes are left alone, so repeat runs are
offline-friendly. To bump a version: update WHEELS below with the new
filename, URL, and sha256 from ``https://pypi.org/pypi/<pkg>/<version>/json``.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
import zipfile

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'static' / 'vendor'

# Pinned pure-python wheels. micropip parses name/version from the filename --
# keep filenames intact.
WHEELS = {
    'wheel': {
        'filename': 'por_que-0.4.0-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/d4/4b/ab2c8d2e1beedd9c3b98e8a78742e0028508838a153ffc20177ff986065b/por_que-0.4.0-py3-none-any.whl',
        'sha256': '98308b4c10edcd8f36fab687e47049945da037a8d885a395ab4f747496c9762e',
    },
    'hctef': {
        'filename': 'hctef-0.3.0-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/a1/91/1b1e10bf71f5101a48eec5c1e17e64345bf14999d3c929a0ae9b1e5c4885/hctef-0.3.0-py3-none-any.whl',
        'sha256': '0c86878329821bb440578921325cd3bb01d0644bbe158c5ba171ddcda20b92da',
    },
}


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fetch(spec: dict[str, str]) -> Path:
    staged = VENDOR / spec['filename']
    if staged.is_file() and sha256_of(staged) == spec['sha256']:
        print(f'{staged.name} already staged')  # noqa: T201
        return staged

    with urllib.request.urlopen(spec['url']) as response:  # noqa: S310
        data = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != spec['sha256']:
        sys.exit(
            f'hash mismatch for {spec["filename"]}: '
            f'expected {spec["sha256"]}, got {digest}'
        )
    staged.write_bytes(data)
    print(f'downloaded {staged.name}')  # noqa: T201
    return staged


def main() -> None:
    VENDOR.mkdir(parents=True, exist_ok=True)
    staged = {key: fetch(spec) for key, spec in WHEELS.items()}
    for old in VENDOR.glob('*.whl'):
        if old.name not in {wheel.name for wheel in staged.values()}:
            old.unlink()
    # The dump JSON Schema ships inside the por-que wheel; extract it so
    # `npm run generate` codegens from the exact schema the runtime uses.
    schema = VENDOR / 'por-que.schema.json'
    with zipfile.ZipFile(staged['wheel']) as whl:
        schema.write_bytes(whl.read('por_que/dump-schema.json'))
    print(f'extracted {schema.name}')  # noqa: T201
    (VENDOR / 'manifest.json').write_text(
        json.dumps({key: wheel.name for key, wheel in staged.items()}) + '\n',
    )
    print(f'staged -> {VENDOR.relative_to(ROOT)}')  # noqa: T201


if __name__ == '__main__':
    main()
