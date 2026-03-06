from flask import Flask, render_template, abort, request, jsonify, redirect, url_for
from settings import TOTAL_PAGES, PAGE_IDS     # settings.pyから読む
from notion_fetcher import fetch_diary_entries, clear_cache
from lab import lab_bp
import os
import sqlite3
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

try:
    import psycopg
except ImportError:
    psycopg = None

app = Flask(__name__)

app.register_blueprint(lab_bp)

SQLITE_PATH = os.path.join(app.root_path, "mytimeline.db")


def _timeline_database_url() -> str:
    return os.getenv("MYTIMELINE_DATABASE_URL") or os.getenv("DATABASE_URL", "")


def _timeline_edit_token() -> str:
    return os.getenv("MYTIMELINE_EDIT_TOKEN", "")


def _timeline_db_kind() -> str:
    db_url = _timeline_database_url()
    if db_url.startswith(("postgres://", "postgresql://")):
        return "postgres"
    return "sqlite"


def _postgres_conninfo() -> str:
    raw_url = _timeline_database_url()
    parts = urlsplit(raw_url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    if "sslmode" not in query:
        query["sslmode"] = "require"
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _open_timeline_db():
    if _timeline_db_kind() == "postgres":
        if psycopg is None:
            raise RuntimeError("psycopg is required when using PostgreSQL. Install dependencies from requirements.txt.")
        return psycopg.connect(_postgres_conninfo())

    conn = sqlite3.connect(SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_timeline_table() -> None:
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS mytimeline_posts (
                      id BIGSERIAL PRIMARY KEY,
                      content TEXT NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            conn.commit()
    else:
        with _open_timeline_db() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS mytimeline_posts (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  content TEXT NOT NULL,
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            conn.commit()


def _timeline_list_posts(limit: int = 200):
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, content, created_at
                    FROM mytimeline_posts
                    ORDER BY created_at DESC, id DESC
                    LIMIT %s
                    """,
                    (limit,),
                )
                rows = cur.fetchall()

        posts = []
        for row in rows:
            post_id, content, created_at = row
            posts.append({
                "id": post_id,
                "content": content,
                "created_at": created_at,
            })
        return posts

    with _open_timeline_db() as conn:
        rows = conn.execute(
            """
            SELECT id, content, created_at
            FROM mytimeline_posts
            ORDER BY created_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    posts = []
    for row in rows:
        created_at = row["created_at"]
        try:
            parsed_created_at = datetime.strptime(created_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            parsed_created_at = created_at
        posts.append({
            "id": row["id"],
            "content": row["content"],
            "created_at": parsed_created_at,
        })
    return posts


def _timeline_insert_post(content: str) -> None:
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO mytimeline_posts (content)
                    VALUES (%s)
                    """,
                    (content,),
                )
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute(
            """
            INSERT INTO mytimeline_posts (content)
            VALUES (?)
            """,
            (content,),
        )
        conn.commit()

def fetch_diary_by_page(n: int):
    page_id = PAGE_IDS.get(n)   # ← 直接PAGE_IDSから取得

    if not page_id:
        return [{
            "date": "error",
            "html": f"<p>ページ{n}の設定が settings.py に存在しません。</p>"
        }]

    try:
        return fetch_diary_entries(page_id)
    except Exception as e:
        return [{
            "date": "error",
            "html": f"<p>日記の取得に失敗しました。<br>{e}</p>"
        }]

@app.route("/")
def page1():
    diary = fetch_diary_by_page(1)
    return render_template("index.html", diary=diary, current_page=1, total_pages=TOTAL_PAGES)

@app.route("/page<int:page_no>")
def page_n(page_no: int):
    if page_no < 1 or page_no > TOTAL_PAGES:
        abort(404)

    diary = fetch_diary_by_page(page_no)
    return render_template("index.html", diary=diary, current_page=page_no, total_pages=TOTAL_PAGES)

@app.route("/admin/clear-cache")
def admin_clear_cache():
    key = request.args.get("key", "")
    expected = os.getenv("ADMIN_CLEAR_CACHE_KEY", "")
    if not expected or key != expected:
        abort(403)
    clear_cache()
    return jsonify({"status": "ok"})


@app.route("/mytimeline")
def mytimeline():
    posts = _timeline_list_posts()
    return render_template("mytimeline.html", posts=posts)


@app.route("/mytimeline/edit/<token>", methods=["GET", "POST"])
def mytimeline_edit(token: str):
    expected_token = _timeline_edit_token()
    if not expected_token or token != expected_token:
        abort(404)

    error_message = ""
    if request.method == "POST":
        content = request.form.get("content", "").strip()
        if not content:
            error_message = "投稿内容が空です。"
        elif len(content) > 5000:
            error_message = "投稿内容は5000文字以内にしてください。"
        else:
            _timeline_insert_post(content)
            return redirect(url_for("mytimeline_edit", token=token, posted=1))

    posts = _timeline_list_posts()
    posted = request.args.get("posted") == "1"
    return render_template(
        "mytimeline_edit.html",
        posts=posts,
        posted=posted,
        error_message=error_message,
    )

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
