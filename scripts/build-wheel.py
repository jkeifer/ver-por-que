#!/usr/bin/env python3
"""Build por-que and hctef wheels from local checkouts and stage them for the webapp.

The webapp parses raw .parquet files in the browser via pyodide, which needs
por-que and hctef wheels as static assets. This builds both from source
checkouts and copies them, plus a tiny manifest, into ``static/vendor/``
(gitignored). The pyodide integration test skips itself when the manifest is
absent, so this is only required to actually run that test.

Point it at checkouts with ``POR_QUE_CHECKOUT=/path/to/por-que`` and
``HCTEF_CHECKOUT=/path/to/hctef``; otherwise it autodiscovers ``../por-que``
and ``../hctef`` siblings. ``POR_QUE_NO_WEBAPP=1`` is set unconditionally --
in older por-que it stops ``uv build`` recursing into the hatch webapp build
hook; in newer por-que the hook is gone and the env var is simply ignored.
Either way it is harmless.

ponytail: no PyPI download path yet -- the released por-que wheel predates the
current dump format, and the released hctef predates the pyfetch transport
(needed for in-browser range requests). Once both ship on PyPI, this becomes a
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


def find_checkout(name: str, env_var: str) -> Path:
    env = os.environ.get(env_var)
    candidates = [Path(env)] if env else []
    candidates.append(ROOT.parent / name)
    for c in candidates:
        if (c / 'pyproject.toml').is_file():
            return c.resolve()
    sys.exit(
        f'no {name} checkout found. Set {env_var}=/path/to/{name} or place a '
        f'{name} checkout at ../{name}.\n'
        f'This step needs local checkouts until por-que ships on PyPI with '
        f'the current dump format and hctef ships the pyfetch transport; '
        f'then it becomes a PyPI download.'
    )


def build_wheel(checkout: Path) -> Path:
    """Build a wheel from `checkout` and copy it into VENDOR; return the copy."""
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
            sys.exit(f'expected exactly one wheel from {checkout}, found {len(wheels)}')
        # micropip parses the filename for name/version -- keep it intact.
        staged = VENDOR / wheels[0].name
        shutil.copy2(wheels[0], staged)
    return staged


def main() -> None:
    por_que = find_checkout('por-que', 'POR_QUE_CHECKOUT')
    hctef = find_checkout('hctef', 'HCTEF_CHECKOUT')

    VENDOR.mkdir(parents=True, exist_ok=True)
    for old in VENDOR.glob('*.whl'):
        old.unlink()

    por_que_wheel = build_wheel(por_que)
    hctef_wheel = build_wheel(hctef)
    (VENDOR / 'manifest.json').write_text(
        json.dumps({'wheel': por_que_wheel.name, 'hctef': hctef_wheel.name}) + '\n',
    )

    print(  # noqa: T201
        f'staged {por_que_wheel.name} (from {por_que}) and '
        f'{hctef_wheel.name} (from {hctef}) -> {VENDOR.relative_to(ROOT)}'
    )


if __name__ == '__main__':
    main()
