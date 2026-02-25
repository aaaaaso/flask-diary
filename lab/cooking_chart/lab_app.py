import json
import os
import re
import sqlite3
from pathlib import Path

from flask import Blueprint, abort, jsonify, render_template, request

LAB_TITLE = "Cooking Chart"
LAB_DESCRIPTION = "料理工程を可視化して保存できるチャートツール。"

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "recipes.db"
EDITOR_TOKEN = (os.getenv("COOKING_CHART_EDITOR_TOKEN") or "").strip()
DATABASE_URL = (
    os.getenv("COOKING_CHART_DATABASE_URL")
    or os.getenv("DATABASE_URL")
    or ""
).strip()
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://") :]
USE_POSTGRES = DATABASE_URL.startswith(("postgresql://", "postgres://"))
default_table = "cooking_chart_recipes" if USE_POSTGRES else "recipes"
TABLE_NAME = (os.getenv("COOKING_CHART_TABLE") or default_table).strip()
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", TABLE_NAME):
    raise RuntimeError("COOKING_CHART_TABLE must be a valid SQL identifier")

psycopg = None
dict_row = None
if USE_POSTGRES:
    try:
        import psycopg
        from psycopg.rows import dict_row
    except Exception as exc:
        raise RuntimeError(
            "PostgreSQL is enabled but psycopg is not available. "
            "Install psycopg[binary] and redeploy."
        ) from exc

bp = Blueprint(
    "cooking_chart",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)


def db_conn():
    if USE_POSTGRES:
        conn = psycopg.connect(DATABASE_URL, row_factory=dict_row)
    else:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db_conn()
    if USE_POSTGRES:
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
                id BIGSERIAL PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                content JSONB NOT NULL,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                sort_order INTEGER
            )
            """
        )
        next_order = conn.execute(
            f"SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM {TABLE_NAME}"
        ).fetchone()["n"]
        rows = conn.execute(
            f"SELECT id FROM {TABLE_NAME} WHERE sort_order IS NULL ORDER BY id ASC"
        ).fetchall()
        for row in rows:
            conn.execute(
                f"UPDATE {TABLE_NAME} SET sort_order = %s WHERE id = %s",
                (next_order, row["id"]),
            )
            next_order += 1
    else:
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                content TEXT NOT NULL,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                sort_order INTEGER
            )
            """
        )
        cols = [row["name"] for row in conn.execute(f"PRAGMA table_info({TABLE_NAME})").fetchall()]
        if "sort_order" not in cols:
            conn.execute(f"ALTER TABLE {TABLE_NAME} ADD COLUMN sort_order INTEGER")

        next_order = conn.execute(
            f"SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM {TABLE_NAME}"
        ).fetchone()["n"]
        rows = conn.execute(
            f"SELECT id FROM {TABLE_NAME} WHERE sort_order IS NULL ORDER BY id ASC"
        ).fetchall()
        for row in rows:
            conn.execute(
                f"UPDATE {TABLE_NAME} SET sort_order = ? WHERE id = ?",
                (next_order, row["id"]),
            )
            next_order += 1

    conn.commit()
    conn.close()


init_db()


@bp.get("/")
def index():
    return render_template("cooking_chart/index.html", editable=False)


@bp.get("/edit")
def edit():
    key = (request.args.get("key") or "").strip()
    if not EDITOR_TOKEN or key != EDITOR_TOKEN:
        abort(403)
    return render_template("cooking_chart/index.html", editable=True)


def _require_editor_key():
    key = (request.args.get("key") or "").strip()
    if not EDITOR_TOKEN or key != EDITOR_TOKEN:
        abort(403)


@bp.get("/api/recipes")
def list_recipes():
    conn = db_conn()
    rows = conn.execute(
        f"""
        SELECT name
        FROM {TABLE_NAME}
        ORDER BY sort_order ASC, updated_at DESC, name ASC
        """
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@bp.get("/api/recipes/<string:name>")
def get_recipe(name: str):
    conn = db_conn()
    if USE_POSTGRES:
        row = conn.execute(
            f"SELECT name, content, updated_at FROM {TABLE_NAME} WHERE name=%s",
            (name,),
        ).fetchone()
    else:
        row = conn.execute(
            f"SELECT name, content, updated_at FROM {TABLE_NAME} WHERE name=?",
            (name,),
        ).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "not found"}), 404
    data = dict(row)
    if isinstance(data.get("content"), str):
        data["content"] = json.loads(data["content"])
    return jsonify(data)


@bp.post("/api/recipes")
def save_recipe():
    _require_editor_key()
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    content = payload.get("content")

    if not name:
        return jsonify({"error": "name is required"}), 400
    if not isinstance(content, dict):
        return jsonify({"error": "content must be an object"}), 400

    text = json.dumps(content, ensure_ascii=False)
    conn = db_conn()
    if USE_POSTGRES:
        conn.execute(
            f"""
            INSERT INTO {TABLE_NAME}(name, content, updated_at, sort_order)
            VALUES(
                %s,
                %s::jsonb,
                NOW(),
                COALESCE((SELECT MAX(sort_order) + 1 FROM {TABLE_NAME}), 1)
            )
            ON CONFLICT(name) DO UPDATE SET
                content=excluded.content,
                updated_at=NOW()
            """,
            (name, text),
        )
    else:
        conn.execute(
            f"""
            INSERT INTO {TABLE_NAME}(name, content, updated_at, sort_order)
            VALUES(
                ?,
                ?,
                CURRENT_TIMESTAMP,
                COALESCE((SELECT MAX(sort_order) + 1 FROM {TABLE_NAME}), 1)
            )
            ON CONFLICT(name) DO UPDATE SET
                content=excluded.content,
                updated_at=CURRENT_TIMESTAMP
            """,
            (name, text),
        )
    conn.commit()
    conn.close()

    return jsonify({"ok": True})


@bp.delete("/api/recipes/<string:name>")
def delete_recipe(name: str):
    _require_editor_key()
    conn = db_conn()
    if USE_POSTGRES:
        cur = conn.execute(f"DELETE FROM {TABLE_NAME} WHERE name = %s", (name,))
    else:
        cur = conn.execute(f"DELETE FROM {TABLE_NAME} WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@bp.patch("/api/recipes/order")
def update_recipe_order():
    _require_editor_key()
    payload = request.get_json(silent=True) or {}
    names = payload.get("names")
    if not isinstance(names, list) or not all(isinstance(n, str) and n.strip() for n in names):
        return jsonify({"error": "names must be a non-empty string array"}), 400

    normalized = [n.strip() for n in names]
    conn = db_conn()
    if normalized:
        placeholders = ",".join(["%s"] * len(normalized)) if USE_POSTGRES else ",".join(["?"] * len(normalized))
        existing_rows = conn.execute(
            f"SELECT name FROM {TABLE_NAME} WHERE name IN ({placeholders})",
            normalized,
        ).fetchall()
        existing = {row["name"] for row in existing_rows}
    else:
        existing = set()

    for idx, name in enumerate(normalized, start=1):
        if name in existing:
            if USE_POSTGRES:
                conn.execute(
                    f"UPDATE {TABLE_NAME} SET sort_order = %s WHERE name = %s",
                    (idx, name),
                )
            else:
                conn.execute(
                    f"UPDATE {TABLE_NAME} SET sort_order = ? WHERE name = ?",
                    (idx, name),
                )

    if normalized:
        placeholders = ",".join(["%s"] * len(normalized)) if USE_POSTGRES else ",".join(["?"] * len(normalized))
        tail = conn.execute(
            f"SELECT name FROM {TABLE_NAME} WHERE name NOT IN ({placeholders}) ORDER BY sort_order ASC, id ASC",
            normalized,
        ).fetchall()
    else:
        tail = conn.execute(
            f"SELECT name FROM {TABLE_NAME} ORDER BY sort_order ASC, id ASC"
        ).fetchall()
    tail_start = len(normalized) + 1
    for i, row in enumerate(tail, start=tail_start):
        if USE_POSTGRES:
            conn.execute(
                f"UPDATE {TABLE_NAME} SET sort_order = %s WHERE name = %s",
                (i, row["name"]),
            )
        else:
            conn.execute(
                f"UPDATE {TABLE_NAME} SET sort_order = ? WHERE name = ?",
                (i, row["name"]),
            )

    conn.commit()
    conn.close()
    return jsonify({"ok": True})
