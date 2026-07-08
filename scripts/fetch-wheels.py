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
        'filename': 'por_que-0.4.1-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/9c/97/f7e872f7ac8f7c3efea2016651d4fd2ed62bb49a56780632a96a6235cf09/por_que-0.4.1-py3-none-any.whl',
        'sha256': '542c9325201695ba4be5cccc8d3115f9ce961f2216e5566017804ee587adf6ef',
    },
    'hctef': {
        'filename': 'hctef-0.3.1-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/a3/b9/2bd4c4a29b22c4e8fbfd0e23a975d3e319ee19cb63c10ebd01cbb5e66031/hctef-0.3.1-py3-none-any.whl',
        'sha256': '08ded822bc850b7be5f3e3fa8ed380818c9a3f4ad3c70ee9f93b9057c01290ac',
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
