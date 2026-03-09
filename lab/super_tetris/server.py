#!/usr/bin/env python3
import json
import os
import threading
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

SCORES_FILE = os.path.join(os.path.dirname(__file__), "scores.json")
LOCK = threading.Lock()


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
      score = int(row.get("score", 0))
    except Exception:
      score = 0
    name = str(row.get("name", "NONAME"))[:16] or "NONAME"
    ts = str(row.get("ts", ""))
    normalized.append({"name": name, "score": score, "ts": ts})
  normalized.sort(key=lambda x: (-x["score"], x["ts"]))
  return normalized[:3]


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
        rows = to_top3(load_scores())
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
    row = {
      "name": name,
      "score": score,
      "ts": datetime.now(timezone.utc).isoformat(),
    }
    with LOCK:
      rows = load_scores()
      rows.append(row)
      rows.sort(key=lambda x: (-int(x.get("score", 0)), str(x.get("ts", ""))))
      rows = rows[:100]
      save_scores(rows)
      top3 = to_top3(rows)
    self._send_json(top3)


def main():
  host = "0.0.0.0"
  port = int(os.environ.get("PORT", "8000"))
  server = ThreadingHTTPServer((host, port), Handler)
  print(f"Serving on http://localhost:{port}")
  server.serve_forever()


if __name__ == "__main__":
  main()
