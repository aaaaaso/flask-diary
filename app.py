from flask import Flask, render_template, abort, request, jsonify, redirect, url_for
from settings import TOTAL_PAGES, PAGE_IDS     # settings.pyから読む
from notion_fetcher import fetch_diary_entries, clear_cache
from lab import lab_bp
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

try:
    import psycopg
except ImportError:
    psycopg = None

app = Flask(__name__)

app.register_blueprint(lab_bp)

SQLITE_PATH = os.path.join(app.root_path, "mytimeline.db")
TAG_PATTERN = re.compile(r"#([0-9A-Za-z_ぁ-んァ-ヶ一-龠ー]+)")
TOKYO_TZ = ZoneInfo("Asia/Tokyo")


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


def _normalize_tag(tag: str) -> str:
    return tag.strip().lstrip("#").lower()


def _extract_tags(content: str):
    tags = []
    seen = set()
    for raw in TAG_PATTERN.findall(content):
        tag = _normalize_tag(raw)
        if not tag or tag in seen:
            continue
        seen.add(tag)
        tags.append(tag)
    return tags


def _timeline_filter_posts(posts, selected_tag: str):
    if not selected_tag:
        return posts
    return [post for post in posts if selected_tag in post["tags"]]


def _timeline_collect_tags(posts):
    seen = set()
    tags = []
    for post in posts:
        for tag in post["tags"]:
            if tag in seen:
                continue
            seen.add(tag)
            tags.append(tag)
    return tags


def _timeline_prepare_posts(posts):
    prepared = []
    prev_date_label = None
    for index, post in enumerate(posts):
        created_at = post.get("created_at")
        if hasattr(created_at, "month") and hasattr(created_at, "day") and hasattr(created_at, "hour") and hasattr(created_at, "minute"):
            if getattr(created_at, "tzinfo", None) is None:
                display_dt = created_at.replace(tzinfo=timezone.utc).astimezone(TOKYO_TZ)
            else:
                display_dt = created_at.astimezone(TOKYO_TZ)
            date_label = f"{display_dt.month}/{display_dt.day}"
            time_label = f"{display_dt.hour:02d}:{display_dt.minute:02d}"
        else:
            date_label = ""
            time_label = str(created_at)

        item = dict(post)
        item["date_label"] = date_label
        item["time_label"] = time_label
        item["show_date_divider"] = bool(date_label) and (date_label != prev_date_label)
        prepared.append(item)

        if date_label:
            prev_date_label = date_label
    return prepared


def _init_timeline_table() -> None:
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS mytimeline_posts (
                      id BIGSERIAL PRIMARY KEY,
                      content TEXT NOT NULL,
                      tags TEXT NOT NULL DEFAULT '[]',
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cur.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]'
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
                  tags TEXT NOT NULL DEFAULT '[]',
                  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
                """
            )
            columns = conn.execute("PRAGMA table_info(mytimeline_posts)").fetchall()
            column_names = {col["name"] for col in columns}
            if "tags" not in column_names:
                conn.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'
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
                    SELECT id, content, tags, created_at
                    FROM mytimeline_posts
                    ORDER BY created_at DESC, id DESC
                    LIMIT %s
                    """,
                    (limit,),
                )
                rows = cur.fetchall()

        posts = []
        for row in rows:
            post_id, content, tags_raw, created_at = row
            try:
                tags = json.loads(tags_raw or "[]")
            except (ValueError, TypeError):
                tags = []
            posts.append({
                "id": post_id,
                "content": content,
                "tags": tags,
                "created_at": created_at,
            })
        return posts

    with _open_timeline_db() as conn:
        rows = conn.execute(
            """
            SELECT id, content, tags, created_at
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
        try:
            tags = json.loads(row["tags"] or "[]")
        except (ValueError, TypeError):
            tags = []
        posts.append({
            "id": row["id"],
            "content": row["content"],
            "tags": tags,
            "created_at": parsed_created_at,
        })
    return posts


def _timeline_insert_post(content: str, tags) -> None:
    tags_json = json.dumps(tags, ensure_ascii=False)
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO mytimeline_posts (content, tags)
                    VALUES (%s, %s)
                    """,
                    (content, tags_json),
                )
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute(
            """
            INSERT INTO mytimeline_posts (content, tags)
            VALUES (?, ?)
            """,
            (content, tags_json),
        )
        conn.commit()


def _timeline_delete_post(post_id: int) -> None:
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM mytimeline_posts WHERE id = %s", (post_id,))
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute("DELETE FROM mytimeline_posts WHERE id = ?", (post_id,))
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
    selected_tag = _normalize_tag(request.args.get("tag", ""))
    all_posts = _timeline_list_posts()
    filtered_posts = _timeline_filter_posts(all_posts, selected_tag)
    posts = _timeline_prepare_posts(filtered_posts)
    return render_template(
        "mytimeline.html",
        posts=posts,
        selected_tag=selected_tag,
        available_tags=_timeline_collect_tags(all_posts),
    )


@app.route("/mytimeline/edit/<token>", methods=["GET", "POST"])
def mytimeline_edit(token: str):
    expected_token = _timeline_edit_token()
    if not expected_token or token != expected_token:
        abort(404)

    error_message = ""
    selected_tag = _normalize_tag(request.args.get("tag", ""))
    if request.method == "POST":
        content = request.form.get("content", "").strip()
        tags = _extract_tags(content)
        if not content:
            error_message = "投稿内容が空です。"
        elif len(content) > 100:
            error_message = "投稿内容は100文字以内にしてください。"
        elif len(tags) > 3:
            error_message = "タグは最大3つまでです。"
        else:
            _timeline_insert_post(content, tags)
            return redirect(url_for("mytimeline_edit", token=token, posted=1, tag=selected_tag or None))

    all_posts = _timeline_list_posts()
    filtered_posts = _timeline_filter_posts(all_posts, selected_tag)
    posts = _timeline_prepare_posts(filtered_posts)
    posted = request.args.get("posted") == "1"
    return render_template(
        "mytimeline_edit.html",
        posts=posts,
        selected_tag=selected_tag,
        available_tags=_timeline_collect_tags(all_posts),
        token=token,
        posted=posted,
        error_message=error_message,
    )


@app.route("/mytimeline/edit/<token>/delete/<int:post_id>", methods=["POST"])
def mytimeline_delete(token: str, post_id: int):
    expected_token = _timeline_edit_token()
    if not expected_token or token != expected_token:
        abort(404)
    _timeline_delete_post(post_id)
    selected_tag = _normalize_tag(request.args.get("tag", ""))
    return redirect(url_for("mytimeline_edit", token=token, tag=selected_tag or None))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
