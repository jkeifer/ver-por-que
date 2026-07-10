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

por-que and hctef are pinned independently, but por-que declares the hctef
version it needs -- and the pyodide worker installs with ``deps=False``, so
nothing enforces that at runtime. After staging, this asserts the pinned hctef
satisfies por-que's requirement, so a por-que bump that outgrows the hctef pin
fails here (and in CI) instead of silently shipping a mismatch.
"""

from __future__ import annotations

import hashlib
import json
import re
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
        'filename': 'por_que-0.5.0-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/d7/67/34289412564dec17c4ccb0bf9ab84d9bb76e93312f20a9ee1c88de0fab0f/por_que-0.5.0-py3-none-any.whl',
        'sha256': '861adf2b2fb0c82aa2b925b25f636ead98ad81a5435e46ebedfc0d56794b094e',
    },
    'hctef': {
        'filename': 'hctef-0.4.0-py3-none-any.whl',
        'url': 'https://files.pythonhosted.org/packages/47/0b/b36b12259634a3cbf70a3aa0a8a8d70f3403f8b654825650efc57a9608ab/hctef-0.4.0-py3-none-any.whl',
        'sha256': 'ac5f6a0cb0b3d4a887108e5916cf2a9340f8927ec5db37d9f840e910d07c5a48',
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


def hctef_requirement(por_que_wheel: Path) -> str | None:
    """The hctef requirement por-que declares (e.g. 'hctef[async]>=0.3.1'), or None."""
    with zipfile.ZipFile(por_que_wheel) as whl:
        meta_name = next(n for n in whl.namelist() if n.endswith('.dist-info/METADATA'))
        meta = whl.read(meta_name).decode()
    for line in meta.splitlines():
        if line.startswith('Requires-Dist:') and re.search(r'\bhctef\b', line):
            return line.split(':', 1)[1].strip()
    return None


def satisfies(version: str, requirement: str) -> bool:
    """Does `version` satisfy the requirement string (e.g. 'hctef[async]>=0.3.1')?"""
    try:
        from packaging.requirements import Requirement

        return Requirement(requirement).specifier.contains(version, prereleases=True)
    except ModuleNotFoundError:
        # packaging isn't a hard dep of this stdlib-only script; fall back to the
        # only operator por-que uses in practice (>=). If the spec is anything
        # else, don't guess -- warn and let it through rather than false-fail.
        match = re.search(r'>=\s*([\d.]+)', requirement)
        if not match:
            print(f'cannot verify {requirement!r} without packaging; skipping')  # noqa: T201
            return True

        def as_tuple(v: str) -> tuple[int, ...]:
            return tuple(int(part) for part in v.split('.'))

        return as_tuple(version) >= as_tuple(match.group(1))


def check_hctef_pin(por_que_wheel: Path) -> None:
    """Fail if the pinned hctef can't satisfy what the por-que wheel requires."""
    requirement = hctef_requirement(por_que_wheel)
    if requirement is None:
        return  # por-que no longer declares hctef; nothing to check
    pinned = WHEELS['hctef']['filename'].split('-')[1]  # hctef-<version>-py3-...
    if not satisfies(pinned, requirement):
        sys.exit(
            f"pinned hctef {pinned} does not satisfy por-que's '{requirement}' -- "
            f'bump the hctef pin in WHEELS to a version that does'
        )
    print(f"verified hctef {pinned} satisfies por-que's '{requirement}'")  # noqa: T201


def main() -> None:
    VENDOR.mkdir(parents=True, exist_ok=True)
    staged = {key: fetch(spec) for key, spec in WHEELS.items()}
    for old in VENDOR.glob('*.whl'):
        if old.name not in {wheel.name for wheel in staged.values()}:
            old.unlink()
    check_hctef_pin(staged['wheel'])
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
