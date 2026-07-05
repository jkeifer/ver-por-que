#!/usr/bin/env python3
"""Build a por-que wheel from a local checkout and stage it for the webapp.

The webapp parses raw .parquet files in the browser via pyodide, which needs a
por-que wheel as a static asset. This builds that wheel from a por-que source
checkout and copies it, plus a tiny manifest, into ``static/vendor/``
(gitignored). The pyodide integration test skips itself when the wheel is
absent, so this is only required to actually run that test.

Point it at a checkout with ``POR_QUE_CHECKOUT=/path/to/por-que``; otherwise it
autodiscovers a ``../por-que`` sibling. ``POR_QUE_NO_WEBAPP=1`` is set
unconditionally -- in older por-que it stops ``uv build`` recursing into the
hatch webapp build hook; in newer por-que the hook is gone and the env var is
simply ignored. Either way it is harmless.

ponytail: no PyPI download path yet -- the released wheel predates the current
dump format. Once por-que ships the current format on PyPI, this becomes a
pinned-wheel download and can go away.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'static' / 'vendor'


def find_checkout() -> Path:
    env = os.environ.get('POR_QUE_CHECKOUT')
    candidates = [Path(env)] if env else []
    candidates.append(ROOT.parent / 'por-que')
    for c in candidates:
        if (c / 'pyproject.toml').is_file():
            return c.resolve()
    sys.exit(
        'no por-que checkout found. Set POR_QUE_CHECKOUT=/path/to/por-que or '
        'place a por-que checkout at ../por-que.\n'
        'This step needs a por-que checkout until por-que ships on PyPI with '
        'the current dump format; then it becomes a PyPI download.'
    )


def main() -> None:
    checkout = find_checkout()
    env = {**os.environ, 'POR_QUE_NO_WEBAPP': '1'}
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(  # noqa: S603
            ['uv', 'build', '--wheel', '--out-dir', tmp],  # noqa: S607
            cwd=checkout,
            check=True,
            env=env,
        )
        wheels = list(Path(tmp).glob('*.whl'))
        if len(wheels) != 1:
            sys.exit(f'expected exactly one wheel, found {len(wheels)}')
        wheel = wheels[0]

        VENDOR.mkdir(parents=True, exist_ok=True)
        for old in VENDOR.glob('*.whl'):
            old.unlink()
        # micropip parses the filename for name/version -- keep it intact.
        shutil.copy2(wheel, VENDOR / wheel.name)
        (VENDOR / 'manifest.json').write_text(json.dumps({'wheel': wheel.name}) + '\n')

    print(f'staged {wheel.name} -> {VENDOR.relative_to(ROOT)} (from {checkout})')  # noqa: T201


if __name__ == '__main__':
    main()
