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
        'filename': 'por_que-0.3.0-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/02/cc/0004dc0509f24a8f490ac65427737e7fb383813ff078d14c024a5f5543dd/por_que-0.3.0-py3-none-any.whl',
        'sha256': 'd7cd3925fd8fd917ca8868036fe6cc3452c7df8ba3bd046ed571a970b15deacf',
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
