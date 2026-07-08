#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["por_que==0.4.1"]
# ///
# The pin above must match scripts/fetch-wheels.py; check_por_que_pin() enforces
# it at runtime. por_que pulls hctef[async] transitively, so it's not listed.
"""Dump the structure of one Overture Maps parquet part per theme.

File URLs are resolved through Overture's STAC catalog (plain JSON GETs, no S3
listing, no hardcoded ``type=`` paths -- Overture adds/renames types between
releases). Per theme: root catalog -> latest release -> theme catalog -> first
collection -> first item -> ``assets.aws.href`` (the parquet on
``overturemaps-us-west-2.s3...amazonaws.com``, which supports CORS + range so
the webapp can preview/bloom against it too). por-que reads only the footer via
hctef range reads, so dumping a ~500 MB part costs a few MB of network.

Each dump records the live S3 URL as its ``source`` (so the webapp's
preview/bloom work on demand).

Output (default ``dist-overture/``, gitignored):
  overture-<theme>.dump.json   one full dump per theme
  state.json                   {"release": "<version>"} -- the workflow diffs
                               this against the samples-data branch to decide
                               whether to republish.

Modes (the workflow runs one theme per matrix job):
  --print-release        print the latest release id (stdlib only, no por_que)
  --resolve THEME        print ``release=`` and ``url=`` for THEME (stdlib only)
  --theme THEME [OUT]    dump just THEME into OUT (needs por_que)
  [OUT]                  dump every theme into OUT (needs por_que)

``--print-release`` / ``--resolve`` are stdlib-only so the workflow can resolve
the release and decide whether there's work BEFORE any por_que/uv setup. The
dumping modes need por_que; run self-contained via uv (it reads the inline
dependency block above): ``uv run scripts/dump-overture.py --theme buildings``.
The pinned por_que version is read from scripts/fetch-wheels.py and asserted
against the installed one, so a dump can't drift from the webapp's wheel schema.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import urllib.request

from importlib import metadata
from pathlib import Path
from urllib.parse import urljoin

# por_que is imported lazily in dump_url so the `--print-release` check (used by
# the workflow to bail out early on an unchanged release) runs on stdlib alone,
# before any wheel/pip setup.

# Keep in sync with samples.json's Overture entries.
THEMES = ['buildings', 'places', 'transportation', 'divisions']

# A theme can hold several datasets (STAC collections); default is the first
# listed, override here where that isn't the interesting one. transportation
# lists `connector` (graph junctions) first, but `segment` (roads/paths) is the
# recognizable sample.
PREFERRED_DATASET = {'transportation': 'segment'}

STAC_ROOT = 'https://stac.overturemaps.org/catalog.json'

ROOT = Path(__file__).resolve().parent.parent


def pinned_por_que_version() -> str:
    """The por_que version pinned in scripts/fetch-wheels.py (por_que-<v>-...)."""
    text = (ROOT / 'scripts' / 'fetch-wheels.py').read_text()
    match = re.search(r"'filename':\s*'por_que-([\d.]+)-", text)
    if not match:
        sys.exit('could not find the pinned por_que version in scripts/fetch-wheels.py')
    return match.group(1)


def check_por_que_pin() -> None:
    """Fail loudly if the installed por_que drifts from the webapp's pinned wheel."""
    pinned = pinned_por_que_version()
    installed = metadata.version('por_que')
    if installed != pinned:
        sys.exit(
            f'installed por_que {installed} != pinned {pinned} '
            f'(scripts/fetch-wheels.py) -- install the pinned version so dumps '
            f'match the webapp validator'
        )
    print(f'por_que {installed} matches the pinned wheel')  # noqa: T201


def get_json(url: str) -> dict:
    """Fetch and parse a STAC JSON document."""
    with urllib.request.urlopen(url) as response:  # noqa: S310
        return json.load(response)


def _child_hrefs(doc: dict, base_url: str) -> list[str]:
    """Absolute hrefs of the doc's `rel:"child"` links (order preserved)."""
    return [urljoin(base_url, link['href']) for link in doc['links'] if link.get('rel') == 'child']


def _first_item_href(doc: dict, base_url: str) -> str | None:
    """Absolute href of the doc's first `rel:"item"` link, or None."""
    return next(
        (urljoin(base_url, link['href']) for link in doc['links'] if link.get('rel') == 'item'),
        None,
    )


def resolve_release() -> tuple[str, dict, str]:
    """The latest release: its version id, the release catalog, and its URL.

    Root catalog children are releases (``./<version>/catalog.json``); versions
    are dates that sort lexicographically, so the max is the latest.
    """
    root = get_json(STAC_ROOT)
    releases = _child_hrefs(root, STAC_ROOT)
    if not releases:
        sys.exit('no releases in the Overture STAC root catalog')
    # version id = the parent dir name (.../<version>/catalog.json)
    latest_url = max(releases, key=lambda u: u.rsplit('/', 2)[-2])
    version = latest_url.rsplit('/', 2)[-2]
    return version, get_json(latest_url), latest_url


def theme_part_url(release_doc: dict, release_url: str, theme: str) -> str:
    """The first part file's aws parquet URL for a theme.

    release -> theme catalog -> first collection -> first item -> assets.aws.href.
    """
    themes = {url.rsplit('/', 2)[-2]: url for url in _child_hrefs(release_doc, release_url)}
    theme_url = themes.get(theme)
    if theme_url is None:
        sys.exit(f'theme {theme!r} not in release (have: {sorted(themes)})')

    theme_doc = get_json(theme_url)
    collections = _child_hrefs(theme_doc, theme_url)
    if not collections:
        sys.exit(f'no collections under theme {theme!r}')
    # Dataset name is the collection dir: .../<theme>/<dataset>/collection.json.
    preferred = PREFERRED_DATASET.get(theme)
    if preferred is None:
        collection_url = collections[0]  # first collection deterministically
    else:
        datasets = {url.rsplit('/', 2)[-2]: url for url in collections}
        collection_url = datasets.get(preferred)
        if collection_url is None:
            sys.exit(f'dataset {preferred!r} not under theme {theme!r} (have: {sorted(datasets)})')

    item_url = _first_item_href(get_json(collection_url), collection_url)
    if item_url is None:
        sys.exit(f'no items in collection {collection_url}')

    item = get_json(item_url)
    try:
        return item['assets']['aws']['href']
    except KeyError:
        sys.exit(f'no assets.aws.href in item {item_url}')


async def dump_url(url: str, attempts: int = 3) -> str:
    """Footer-only structure dump of a remote parquet, as por-que dump JSON.

    Mirrors src/js/worker/pyodide-parquet.ts `_dump_url`: open a range-reading
    AsyncHttpFile and hand it to ParquetFile.from_reader, which reads only the
    footer + per-chunk metadata spans. S3 drops the odd range read under a run
    of them, so retry the whole dump a few times (hctef already retries one
    dropped connection; this covers the rest). Each retry starts a fresh reader.
    """
    from hctef.exceptions import HctefNetworkError
    from por_que import AsyncHttpFile, ParquetFile

    for attempt in range(1, attempts + 1):
        f = await AsyncHttpFile(url).open()
        try:
            pf = await ParquetFile.from_reader(f, url)
            return pf.to_json()
        except HctefNetworkError as error:
            if attempt == attempts:
                raise
            print(f'  network error (attempt {attempt}/{attempts}), retrying: {error}')  # noqa: T201
            await asyncio.sleep(2 * attempt)
        finally:
            await f.close()
    raise AssertionError('unreachable')  # loop either returns or raises


def resolve_theme(theme: str) -> tuple[str, str]:
    """(latest release id, that theme's first-part aws parquet URL). Stdlib only."""
    release, release_doc, release_url = resolve_release()
    return release, theme_part_url(release_doc, release_url, theme)


async def dump_theme(theme: str, out_dir: Path) -> None:
    """Footer-dump one theme's part file to ``overture-<theme>.dump.json`` and
    write ``overture-<theme>.release`` (the release id — the workflow's per-theme
    idempotency marker)."""
    release, url = resolve_theme(theme)
    print(f'{theme}: dumping {url}')  # noqa: T201
    (out_dir / f'overture-{theme}.dump.json').write_text(await dump_url(url))
    (out_dir / f'overture-{theme}.release').write_text(release + '\n')


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description='Dump Overture parquet structure(s) via STAC.')
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--print-release', action='store_true', help='print the latest release id')
    mode.add_argument('--resolve', metavar='THEME', help='print release=/url= for THEME')
    mode.add_argument('--theme', metavar='THEME', help='dump only THEME')
    p.add_argument('out_dir', nargs='?', help='output dir for dumps (default dist-overture/)')
    return p.parse_args(argv)


async def main() -> None:
    args = parse_args(sys.argv[1:])

    # Stdlib-only resolution modes: no por_que, so the workflow runs these first
    # to decide whether a theme needs work before any uv/npm setup.
    if args.print_release:
        print(resolve_release()[0])  # noqa: T201
        return
    if args.resolve:
        release, url = resolve_theme(args.resolve)
        print(f'release={release}')  # noqa: T201
        print(f'url={url}')  # noqa: T201
        return

    # Dumping modes need por_que; guard against drift from the webapp's wheel.
    check_por_que_pin()
    out_dir = Path(args.out_dir) if args.out_dir else ROOT / 'dist-overture'
    out_dir.mkdir(parents=True, exist_ok=True)
    themes = [args.theme] if args.theme else THEMES
    for theme in themes:
        await dump_theme(theme, out_dir)
    print(f'wrote {len(themes)} dump(s) -> {out_dir}')  # noqa: T201


if __name__ == '__main__':
    asyncio.run(main())
