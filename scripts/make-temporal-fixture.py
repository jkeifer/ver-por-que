"""Regenerate the tiny temporal test fixture.

Writes a 3-row uncompressed Parquet file with a TIMESTAMP (INT64), a DATE
(INT32), and a STRING column to ``test/fixtures/temporal.parquet``. It backs the
value-preview "physical value" test: a logical column displays a converted value
(an ISO datetime/date), but the bloom probe hashes the raw physical integer, so
the preview must surface both. The string column is the negative case (physical
== what you'd type, so no overlay).

No por-que dump is generated -- the test parses the raw ``.parquet`` through the
worker, which needs only the file. Uncompressed so decoding needs no codec::

    python3 scripts/make-temporal-fixture.py
"""

from datetime import date, datetime
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

table = pa.table(
    {
        # timestamp[us], tz-naive -> INT64 TIMESTAMP(MICROS) logical type.
        'ts': pa.array(
            [datetime(2021, 1, 1, 0, 0, 0), datetime(2021, 6, 15, 12, 30), datetime(2022, 3, 3)],
            type=pa.timestamp('us'),
        ),
        # date32 -> INT32 DATE logical type.
        'd': pa.array([date(2021, 1, 1), date(2021, 6, 15), date(2022, 3, 3)], type=pa.date32()),
        # plain UTF8 string: physical == what you'd type, so no physical overlay.
        's': pa.array(['alpha', 'bravo', 'charlie'], type=pa.string()),
    }
)

out = Path(__file__).resolve().parent.parent / 'test' / 'fixtures' / 'temporal.parquet'
pq.write_table(table, out, compression='none')
print(f'wrote {out} ({out.stat().st_size} bytes)')
