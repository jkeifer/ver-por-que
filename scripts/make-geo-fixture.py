"""Regenerate the tiny GeoParquet test fixtures.

Writes a 2-row GeoParquet file (a POINT and a MULTIPOLYGON in a WKB BYTE_ARRAY
column, with GeoParquet `geo` file metadata) and its por-que dump JSON to
``test/fixtures/``. These back the geometry e2e test; committed so the suite
needs no network or the gitignored Overture dumps.

The dump must be produced by the SAME por-que the app is pinned to (its
`_meta.format_version` is validated on load), so generate with the vendored
wheel rather than an ambient install::

    uv run --no-project --python 3.13 --with pyarrow --with pydantic \
        --with ./static/vendor/hctef-0.3.1-py3-none-any.whl \
        --with ./static/vendor/por_que-0.4.1-py3-none-any.whl \
        scripts/make-geo-fixture.py
"""

import asyncio
import io
import json
import struct
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
from por_que import ParquetFile

FIXTURES = Path(__file__).resolve().parent.parent / 'test' / 'fixtures'


def wkb_point(x: float, y: float) -> bytes:
    return b'\x01' + struct.pack('<I', 1) + struct.pack('<dd', x, y)


def wkb_multipolygon(ring: list[tuple[float, float]]) -> bytes:
    poly = b'\x01' + struct.pack('<I', 3) + struct.pack('<I', 1)
    poly += struct.pack('<I', len(ring)) + b''.join(struct.pack('<dd', x, y) for x, y in ring)
    return b'\x01' + struct.pack('<I', 6) + struct.pack('<I', 1) + poly


def main() -> None:
    geo = {
        'version': '1.1.0',
        'primary_column': 'geometry',
        'columns': {
            'geometry': {
                'encoding': 'WKB',
                'geometry_types': ['Point', 'MultiPolygon'],
                'bbox': [0.0, 0.0, 30.0, 10.0],
            }
        },
    }
    geom = pa.array(
        [wkb_point(30, 10), wkb_multipolygon([(0, 0), (10, 0), (10, 10), (0, 0)])],
        type=pa.binary(),
    )
    schema = pa.schema(
        [pa.field('id', pa.int32()), pa.field('geometry', pa.binary())],
        metadata={b'geo': json.dumps(geo).encode()},
    )
    table = pa.table({'id': pa.array([1, 2], pa.int32()), 'geometry': geom}, schema=schema)

    pq_path = FIXTURES / 'geoparquet.parquet'
    pq.write_table(table, pq_path, compression='snappy', write_statistics=True)

    pf = asyncio.run(ParquetFile.from_reader(io.BytesIO(pq_path.read_bytes()), 'geoparquet.parquet'))
    (FIXTURES / 'geoparquet_expected.json').write_text(pf.to_json())
    print(f'wrote {pq_path.name} + geoparquet_expected.json to {FIXTURES}')


if __name__ == '__main__':
    main()
