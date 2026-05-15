---
tags: [demo, duckdb, motherduck, obsidian]
created: 2026-05-15
last_update: 2026-05-15
title: DuckDB & MotherDuck for Obsidian, demo notebook
---

A few sample queries to showcase the [obsidian-duckdb-motherduck](https://github.com/motherduckdb/obsidian-duckdb-motherduck) plugin. Each block runs against a different backend (local WASM DuckDB or MotherDuck cloud), and the result freezes in-place as a regular markdown table.

## 1. Pure DuckDB, read a Parquet over HTTP

Local WASM DuckDB range-reads a 1 MB TPCH `orders` parquet from DuckDB's own public CDN. Fast, CORS-friendly, no token.

```duckdb
SELECT
  o_orderpriority AS priority,
  count(*) AS orders,
  round(sum(o_totalprice), 2) AS revenue,
  round(avg(o_totalprice), 2) AS avg_order
FROM read_parquet('https://shell.duckdb.org/data/tpch/0_01/parquet/orders.parquet')
GROUP BY 1
ORDER BY revenue DESC
```

<!-- md:cache hash=b54c0ac2 conn=local ts=2026-05-15T09:27:08.015Z rows=5 -->

| priority | orders | revenue | avg_order |
| --- | --- | --- | --- |
| 2-HIGH | 3065 | 434187711.87 | 141659.94 |
| 4-NOT SPECIFIED | 3024 | 428175171.06 | 141592.32 |
| 1-URGENT | 3020 | 426348805.57 | 141175.1 |
| 5-LOW | 2950 | 423182674.56 | 143451.75 |
| 3-MEDIUM | 2941 | 415502466.96 | 141279.32 |

<!-- md:cache-end -->



## 2. Pure DuckDB, read a CSV straight from GitHub

GitHub's `raw.githubusercontent.com` serves files with `Access-Control-Allow-Origin: *`, so DuckDB WASM can read them directly. Here, the canonical [airport-codes](https://github.com/datasets/airport-codes) dataset.

```duckdb
SELECT
  iso_country AS country,
  type,
  count(*) AS airports
FROM read_csv('https://raw.githubusercontent.com/datasets/airport-codes/master/data/airport-codes.csv')
WHERE type IN ('large_airport', 'medium_airport')
GROUP BY 1, 2
ORDER BY airports DESC
LIMIT 12
```

<!-- md:cache hash=987c2c92 conn=local ts=2026-05-15T09:27:07.846Z rows=12 -->

| country | type | airports |
| --- | --- | --- |
| US | medium_airport | 822 |
| CN | medium_airport | 265 |
| CA | medium_airport | 237 |
| RU | medium_airport | 210 |
| AU | medium_airport | 178 |
| FR | medium_airport | 118 |
| BR | medium_airport | 110 |
| IN | medium_airport | 96 |
| US | large_airport | 95 |
| JP | medium_airport | 79 |
| GB | medium_airport | 72 |
| CN | large_airport | 69 |

<!-- md:cache-end -->



## 3. MotherDuck, sample_data, no upload required

Every MotherDuck account has the shared `sample_data` database attached. Queries hit data hosted in MotherDuck itself, so they work even if your workspace has no AWS credentials configured.

```motherduck
SELECT
  type,
  count(*) AS items,
  round(avg(score), 1) AS avg_score,
  round(avg(descendants), 1) AS avg_comments
FROM sample_data.hn.hacker_news
WHERE type IS NOT NULL
GROUP BY 1
ORDER BY items DESC
```

<!-- md:cache hash=ae578b5a conn=cloud ts=2026-05-15T09:27:06.762Z rows=5 -->

| type | items | avg_score | avg_comments |
| --- | --- | --- | --- |
| comment | 3530415 |  |  |
| story | 334153 | 17.2 | 12.9 |
| pollopt | 1123 | 26.5 |  |
| job | 915 | 1 |  |
| poll | 134 | 41.7 | 49.3 |

<!-- md:cache-end -->





## 4. MotherDuck, top Hacker News stories

`by` is a reserved keyword in DuckDB SQL, so the author column needs double quotes.

```motherduck
SELECT
  title,
  score,
  "by" AS author,
  descendants AS comments
FROM sample_data.hn.hacker_news
WHERE type = 'story'
  AND title IS NOT NULL
ORDER BY score DESC NULLS LAST
LIMIT 10
```

<!-- md:cache hash=4f14bd96 conn=cloud ts=2026-05-15T09:27:06.641Z rows=10 -->

| title | score | author | comments |
| --- | --- | --- | --- |
| Mechanical Watch | 4298 | todsacerdoti | 413 |
| Google Search Is Dying | 3636 | dbrereton | 1561 |
| My First Impressions of Web3 | 3393 | natdempk | 1129 |
| Sound | 3053 | todsacerdoti | 207 |
| GPS | 2900 | todsacerdoti | 285 |
| Queen Elizabeth II has died | 2827 | xd | 1596 |
| Google no longer producing high quality search results in significant categories | 2813 | lando2319 | 1275 |
| Elon Musk makes $43B unsolicited bid to take Twitter private | 2747 | zegl | 3078 |
| Twitter set to accept Musk's $43B offer – sources | 2498 | marban | 3678 |
| Nvidia releases open-source GPU kernel modules | 2410 | ghishadow | 392 |

<!-- md:cache-end -->





## 5. MotherDuck, read a public Parquet over HTTPS (no AWS creds needed)

Reading via `https://` goes through MotherDuck's httpfs and does not trigger AWS credential signing, so this works for any workspace, even one with no S3 setup or with expired AWS keys.

```motherduck
SELECT
  l_shipmode,
  count(*) AS lineitems,
  round(sum(l_extendedprice), 2) AS revenue
FROM read_parquet('https://shell.duckdb.org/data/tpch/0_01/parquet/lineitem.parquet')
GROUP BY 1
ORDER BY revenue DESC
```

<!-- md:cache hash=fc229a4f conn=cloud ts=2026-05-15T09:27:05.757Z rows=7 -->

| l_shipmode | lineitems | revenue |
| --- | --- | --- |
| TRUCK | 8710 | 313178114.52 |
| MAIL | 8669 | 310589888.43 |
| FOB | 8641 | 307473870.52 |
| REG AIR | 8616 | 306936993.53 |
| SHIP | 8482 | 305720437.51 |
| RAIL | 8566 | 305082696.65 |
| AIR | 8491 | 303207759.31 |

<!-- md:cache-end -->