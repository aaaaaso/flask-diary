import argparse
import os
import re
import sqlite3
from datetime import datetime
from pathlib import Path

DATE_HEADING_RE = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})\s*$")
DIARY_PERIOD_BASE_DATE = datetime.strptime("2025-06-01", "%Y-%m-%d").date()
DIARY_PERIOD_MONTH_SPAN = 3
DEFAULT_DB_PATH = Path(__file__).resolve().parents[1] / "mytimeline.db"


def parse_diary_text(text: str):
    entries = []
    current_date = None
    current_lines = []

    def flush():
        nonlocal current_date, current_lines
        if current_date is None:
            return
        body = "\n".join(current_lines).strip()
        if body:
            entries.append({"entry_date": current_date, "body": body})
        current_date = None
        current_lines = []

    for raw_line in text.splitlines():
        match = DATE_HEADING_RE.match(raw_line)
        if match:
            flush()
            current_date = match.group(1)
            continue
        if current_date is None:
            continue
        current_lines.append(raw_line.rstrip())

    flush()
    return entries


def compute_diary_period_id(entry_date):
    if isinstance(entry_date, datetime):
        value = entry_date.date()
    else:
        value = entry_date
    if value < DIARY_PERIOD_BASE_DATE:
        raise ValueError(f"entry_date must be on or after {DIARY_PERIOD_BASE_DATE.isoformat()}")
    months_since_base = (value.year - DIARY_PERIOD_BASE_DATE.year) * 12 + (value.month - DIARY_PERIOD_BASE_DATE.month)
    return (months_since_base // DIARY_PERIOD_MONTH_SPAN) + 1


def init_diary_table(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS diary_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          period_id INTEGER,
          entry_date TEXT NOT NULL,
          body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS diary_entries_period_id_idx
        ON diary_entries (period_id DESC, entry_date DESC, id DESC)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS diary_entries_entry_date_idx
        ON diary_entries (entry_date DESC, id DESC)
        """
    )
    conn.commit()


def init_diary_table_postgres(conn):
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS diary_entries (
              id BIGSERIAL PRIMARY KEY,
              period_id INTEGER,
              entry_date DATE NOT NULL,
              body TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS diary_entries_period_id_idx
            ON diary_entries (period_id DESC, entry_date DESC, id DESC)
            """
        )
        cur.execute(
            """
            CREATE INDEX IF NOT EXISTS diary_entries_entry_date_idx
            ON diary_entries (entry_date DESC, id DESC)
            """
        )
    conn.commit()


def upsert_entries_sqlite(entries, db_path: Path):
    with sqlite3.connect(db_path) as conn:
        init_diary_table(conn)
        for entry in entries:
            entry_date = datetime.strptime(entry["entry_date"], "%Y-%m-%d").date()
            period_id = compute_diary_period_id(entry_date)
            conn.execute("DELETE FROM diary_entries WHERE entry_date = ?", (entry["entry_date"],))
            conn.execute(
                """
                INSERT INTO diary_entries (period_id, entry_date, body)
                VALUES (?, ?, ?)
                """,
                (period_id, entry["entry_date"], entry["body"]),
            )
        conn.commit()


def upsert_entries_postgres(entries, database_url: str):
    import psycopg

    with psycopg.connect(database_url) as conn:
        init_diary_table_postgres(conn)
        with conn.cursor() as cur:
            for entry in entries:
                entry_date = datetime.strptime(entry["entry_date"], "%Y-%m-%d").date()
                period_id = compute_diary_period_id(entry_date)
                cur.execute("DELETE FROM diary_entries WHERE entry_date = %s", (entry_date,))
                cur.execute(
                    """
                    INSERT INTO diary_entries (period_id, entry_date, body, updated_at)
                    VALUES (%s, %s, %s, NOW())
                    """,
                    (period_id, entry_date, entry["body"]),
                )
        conn.commit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source",
        default="/Users/ashizawasoichiro/Desktop/diary.txt",
        help="Source diary text file with '## yyyy-mm-dd' headings.",
    )
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB_PATH),
        help="SQLite database path to import into.",
    )
    parser.add_argument(
        "--database-url",
        default="",
        help="PostgreSQL connection URL. If omitted, uses DATABASE_URL from env when present.",
    )
    args = parser.parse_args()

    source_path = Path(args.source)
    if not source_path.exists():
        raise SystemExit(f"Source file not found: {source_path}")

    entries = parse_diary_text(source_path.read_text(encoding="utf-8"))
    if not entries:
        raise SystemExit("No diary entries found in source file.")

    db_path = Path(args.db)
    database_url = args.database_url.strip() or os.getenv("DATABASE_URL", "").strip()
    if database_url:
        upsert_entries_postgres(entries, database_url)
        print(f"Imported {len(entries)} diary entries from {source_path} into PostgreSQL")
        return

    upsert_entries_sqlite(entries, db_path)
    print(f"Imported {len(entries)} diary entries from {source_path} into {db_path}")


if __name__ == "__main__":
    main()
