#!/usr/bin/env python3
"""Download the pinned por-que and hctef wheels and stage them for the webapp.

The webapp parses raw .parquet files in the browser via pyodide, which needs
por-que and hctef wheels as static assets. This downloads the pinned releases
from PyPI, verifies their hashes, and stages them, plus a tiny manifest, into
``static/vendor/`` (gitignored). The pyodide integration test skips itself
when the manifest is absent, so this is only required to actually run that
test (and to serve the app).

Already-staged wheels with matching hashes are left alone, so repeat runs are
offline-friendly. To bump a version: update WHEELS below with the new
filename, URL, and sha256 from ``https://pypi.org/pypi/<pkg>/<version>/json``.
"""

from __future__ import annotations

import hashlib
import json
import sys
import urllib.request

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'static' / 'vendor'

# Pinned pure-python wheels. micropip parses name/version from the filename --
# keep filenames intact.
WHEELS = {
    'wheel': {
        'filename': 'por_que-0.3.3-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/23/9d/c659ce66e2bb500cfc9e745f2e9585dbfcf97d45cdd0f8814fbfc9f3728a/por_que-0.3.3-py3-none-any.whl',
        'sha256': 'b98bbbca85aff87f437f869b7cc858d112ea111ff88b3e0118d91d0b3a9ddccb',
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
    (VENDOR / 'manifest.json').write_text(
        json.dumps({key: wheel.name for key, wheel in staged.items()}) + '\n',
    )
    print(f'staged -> {VENDOR.relative_to(ROOT)}')  # noqa: T201


if __name__ == '__main__':
    main()
