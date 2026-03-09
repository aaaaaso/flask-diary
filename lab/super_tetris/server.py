#!/usr/bin/env python3
import json
import os
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import psycopg

SCORES_FILE = os.path.join(os.path.dirname(__file__), "scores.json")
LOCK = threading.Lock()
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()


def load_scores():
  if not os.path.exists(SCORES_FILE):
    return []
  try:
    with open(SCORES_FILE, "r", encoding="utf-8") as f:
      data = json.load(f)
    if isinstance(data, list):
      return data
  except Exception:
    pass
  return []


def save_scores(rows):
  with open(SCORES_FILE, "w", encoding="utf-8") as f:
    json.dump(rows, f, ensure_ascii=False, indent=2)


def to_top3(rows):
  normalized = []
  for row in rows:
    try:
      score = int(row.get("score", 0) if isinstance(row, dict) else row[1])
    except Exception:
      score = 0
    if isinstance(row, dict):
      name = str(row.get("name", "NONAME"))[:16] or "NONAME"
      ts = str(row.get("ts", ""))
    else:
      name = str(row[0] if len(row) > 0 else "NONAME")[:16] or "NONAME"
      ts = str(row[2] if len(row) > 2 else "")
    normalized.append({"name": name, "score": score, "ts": ts})
  normalized.sort(key=lambda x: (-x["score"], x["ts"]))
  return normalized[:3]


def get_conn():
  if not DATABASE_URL:
    return None
  conninfo = DATABASE_URL
  if "sslmode=" not in conninfo:
    joiner = "&" if "?" in conninfo else "?"
    conninfo = f"{conninfo}{joiner}sslmode=require"
  return psycopg.connect(conninfo)


def ensure_schema():
  if not DATABASE_URL:
    return
  with get_conn() as conn:
    with conn.cursor() as cur:
      cur.execute(
        """
        CREATE TABLE IF NOT EXISTS scores (
          id BIGSERIAL PRIMARY KEY,
          name VARCHAR(16) NOT NULL,
          score INTEGER NOT NULL CHECK (score >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
      )
    conn.commit()


def db_fetch_top3():
  with get_conn() as conn:
    with conn.cursor() as cur:
      cur.execute(
        """
        SELECT name, score, created_at
        FROM scores
        ORDER BY score DESC, created_at ASC
        LIMIT 3
        """
      )
      return cur.fetchall()


def db_insert_score(name, score):
  with get_conn() as conn:
    with conn.cursor() as cur:
      cur.execute(
        """
        INSERT INTO scores (name, score)
        VALUES (%s, %s)
        """,
        (name, score),
      )
    conn.commit()


def fetch_top3():
  if DATABASE_URL:
    return to_top3(db_fetch_top3())
  return to_top3(load_scores())


def save_score(name, score):
  if DATABASE_URL:
    db_insert_score(name, score)
    return fetch_top3()
  row = {"name": name, "score": score}
  rows = load_scores()
  rows.append(row)
  rows = to_top3(rows + [])
  save_scores(rows)
  return rows


class Handler(SimpleHTTPRequestHandler):
  def _send_json(self, payload, status=HTTPStatus.OK):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    self.send_response(status)
    self.send_header("Content-Type", "application/json; charset=utf-8")
    self.send_header("Cache-Control", "no-store")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)

  def do_GET(self):
    path = urlparse(self.path).path
    if path == "/api/ranking":
      with LOCK:
        rows = fetch_top3()
      self._send_json(rows)
      return
    return super().do_GET()

  def do_POST(self):
    path = urlparse(self.path).path
    if path != "/api/ranking":
      self.send_error(HTTPStatus.NOT_FOUND)
      return
    try:
      length = int(self.headers.get("Content-Length", "0"))
    except ValueError:
      length = 0
    raw = self.rfile.read(length) if length > 0 else b"{}"
    try:
      payload = json.loads(raw.decode("utf-8"))
    except Exception:
      self._send_json({"error": "invalid json"}, status=HTTPStatus.BAD_REQUEST)
      return
    name = str(payload.get("name", "NONAME")).strip()[:16] or "NONAME"
    try:
      score = int(payload.get("score", 0))
    except Exception:
      score = 0
    score = max(0, score)
    with LOCK:
      top3 = save_score(name, score)
    self._send_json(top3)


def main():
  ensure_schema()
  host = "0.0.0.0"
  port = int(os.environ.get("PORT", "8000"))
  server = ThreadingHTTPServer((host, port), Handler)
  print(f"Serving on http://localhost:{port}")
  server.serve_forever()


if __name__ == "__main__":
  main()
