import json
import sqlite3
from pathlib import Path

from flask import Blueprint, jsonify, render_template, request

LAB_TITLE = "Cooking Chart"
LAB_DESCRIPTION = "料理工程を可視化して保存できるチャートツール。"

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "recipes.db"

bp = Blueprint(
    "cooking_chart",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)


def db_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = db_conn()
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS recipes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            content TEXT NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            sort_order INTEGER
        )
        """
    )
    cols = [row["name"] for row in conn.execute("PRAGMA table_info(recipes)").fetchall()]
    if "sort_order" not in cols:
        conn.execute("ALTER TABLE recipes ADD COLUMN sort_order INTEGER")

    next_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM recipes").fetchone()["n"]
    rows = conn.execute("SELECT id FROM recipes WHERE sort_order IS NULL ORDER BY id ASC").fetchall()
    for row in rows:
        conn.execute("UPDATE recipes SET sort_order = ? WHERE id = ?", (next_order, row["id"]))
        next_order += 1

    conn.commit()
    conn.close()


init_db()


@bp.get("/")
def index():
    return render_template("index.html")


@bp.get("/api/recipes")
def list_recipes():
    conn = db_conn()
    rows = conn.execute(
        """
        SELECT name
        FROM recipes
        ORDER BY sort_order ASC, updated_at DESC, name ASC
        """
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@bp.get("/api/recipes/<string:name>")
def get_recipe(name: str):
    conn = db_conn()
    row = conn.execute("SELECT name, content, updated_at FROM recipes WHERE name=?", (name,)).fetchone()
    conn.close()
    if not row:
        return jsonify({"error": "not found"}), 404
    data = dict(row)
    data["content"] = json.loads(data["content"])
    return jsonify(data)


@bp.post("/api/recipes")
def save_recipe():
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    content = payload.get("content")

    if not name:
        return jsonify({"error": "name is required"}), 400
    if not isinstance(content, dict):
        return jsonify({"error": "content must be an object"}), 400

    text = json.dumps(content, ensure_ascii=False)
    conn = db_conn()
    conn.execute(
        """
        INSERT INTO recipes(name, content, updated_at, sort_order)
        VALUES(
            ?,
            ?,
            CURRENT_TIMESTAMP,
            COALESCE((SELECT MAX(sort_order) + 1 FROM recipes), 1)
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
    conn = db_conn()
    cur = conn.execute("DELETE FROM recipes WHERE name = ?", (name,))
    conn.commit()
    conn.close()
    if cur.rowcount == 0:
        return jsonify({"error": "not found"}), 404
    return jsonify({"ok": True})


@bp.patch("/api/recipes/order")
def update_recipe_order():
    payload = request.get_json(silent=True) or {}
    names = payload.get("names")
    if not isinstance(names, list) or not all(isinstance(n, str) and n.strip() for n in names):
        return jsonify({"error": "names must be a non-empty string array"}), 400

    normalized = [n.strip() for n in names]
    conn = db_conn()
    existing = {
        row["name"]
        for row in conn.execute(
            "SELECT name FROM recipes WHERE name IN (%s)" % ",".join("?" * len(normalized)),
            normalized,
        ).fetchall()
    } if normalized else set()
    for idx, name in enumerate(normalized, start=1):
        if name in existing:
            conn.execute("UPDATE recipes SET sort_order = ? WHERE name = ?", (idx, name))

    tail = conn.execute(
        "SELECT name FROM recipes WHERE name NOT IN (%s) ORDER BY sort_order ASC, id ASC"
        % ",".join("?" * len(normalized)),
        normalized,
    ).fetchall() if normalized else conn.execute("SELECT name FROM recipes ORDER BY sort_order ASC, id ASC").fetchall()
    tail_start = len(normalized) + 1
    for i, row in enumerate(tail, start=tail_start):
        conn.execute("UPDATE recipes SET sort_order = ? WHERE name = ?", (i, row["name"]))

    conn.commit()
    conn.close()
    return jsonify({"ok": True})
