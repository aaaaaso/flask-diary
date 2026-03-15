from flask import Flask, render_template, abort, request, jsonify, redirect, url_for, send_file
from settings import TOTAL_PAGES, PAGE_IDS     # settings.pyから読む
from notion_fetcher import fetch_diary_entries, clear_cache
from lab import lab_bp
import html
import ipaddress
import io
import json
import os
import re
import socket
import sqlite3
from contextlib import suppress
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.error import URLError, HTTPError
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

try:
    from PIL import Image, ImageOps, UnidentifiedImageError
except ImportError:
    Image = None
    ImageOps = None
    UnidentifiedImageError = Exception

try:
    from google.oauth2 import credentials as google_oauth_credentials
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaIoBaseUpload
except ImportError:
    google_oauth_credentials = None
    service_account = None
    build = None
    HttpError = None
    MediaIoBaseUpload = None

try:
    import psycopg
except ImportError:
    psycopg = None

app = Flask(__name__)

app.register_blueprint(lab_bp)

SQLITE_PATH = os.path.join(app.root_path, "mytimeline.db")
TAG_PATTERN = re.compile(r"#([0-9A-Za-z_ぁ-んァ-ヶ一-龠ー]+)")
URL_PATTERN = re.compile(r"(https?://[^\s<>'\"`]+)")
TOKYO_TZ = ZoneInfo("Asia/Tokyo")
OGP_CACHE_TTL_SECONDS = 60 * 60 * 24
FETCH_USER_AGENT = "Mozilla/5.0 (compatible; diary-timeline-bot/1.0; +https://diary.aaaaaso.com)"
MYTIMELINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024
MYTIMELINE_IMAGE_MAX_DIMENSION = 1600
MYTIMELINE_JPEG_QUALITY = 82
MYTIMELINE_WEBP_QUALITY = 80
MYTIMELINE_ALLOWED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP", "GIF"}
DRIVE_UPLOAD_SCOPES = ("https://www.googleapis.com/auth/drive",)


def _timeline_database_url() -> str:
    return os.getenv("MYTIMELINE_DATABASE_URL") or os.getenv("DATABASE_URL", "")


def _timeline_edit_token() -> str:
    return os.getenv("MYTIMELINE_EDIT_TOKEN", "")


def _timeline_db_kind() -> str:
    db_url = _timeline_database_url()
    if db_url.startswith(("postgres://", "postgresql://")):
        return "postgres"
    return "sqlite"


def _timeline_drive_folder_id() -> str:
    return os.getenv("MYTIMELINE_DRIVE_FOLDER_ID", "").strip()


def _timeline_google_service_account_source():
    raw_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "").strip()
    if raw_json:
        return ("json", raw_json)
    raw_path = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "").strip()
    if raw_path:
        return ("file", raw_path)
    return (None, "")


def _timeline_google_oauth_config():
    client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID", "").strip()
    client_secret = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET", "").strip()
    refresh_token = os.getenv("GOOGLE_OAUTH_REFRESH_TOKEN", "").strip()
    if client_id and client_secret and refresh_token:
        return {
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
        }
    return None


def _timeline_image_upload_enabled() -> bool:
    oauth_config = _timeline_google_oauth_config()
    if oauth_config:
        return bool(_timeline_drive_folder_id())
    source_kind, source_value = _timeline_google_service_account_source()
    return bool(_timeline_drive_folder_id() and source_kind and source_value)


def _timeline_image_error(message: str) -> ValueError:
    return ValueError(message)


def _get_drive_service():
    if build is None or MediaIoBaseUpload is None:
        raise RuntimeError("Google Drive dependencies are not installed. Install requirements.txt first.")

    oauth_config = _timeline_google_oauth_config()
    if oauth_config:
        if google_oauth_credentials is None:
            raise RuntimeError("Google OAuth dependencies are not installed. Install requirements.txt first.")
        credentials = google_oauth_credentials.Credentials(
            token=None,
            refresh_token=oauth_config["refresh_token"],
            token_uri="https://oauth2.googleapis.com/token",
            client_id=oauth_config["client_id"],
            client_secret=oauth_config["client_secret"],
            scopes=DRIVE_UPLOAD_SCOPES,
        )
        return build("drive", "v3", credentials=credentials, cache_discovery=False)

    if service_account is None:
        raise RuntimeError("Google service account dependencies are not installed. Install requirements.txt first.")

    source_kind, source_value = _timeline_google_service_account_source()
    if not source_kind or not source_value:
        raise RuntimeError("Google OAuth or service account credentials are not configured.")

    if source_kind == "json":
        info = json.loads(source_value)
        credentials = service_account.Credentials.from_service_account_info(info, scopes=DRIVE_UPLOAD_SCOPES)
    else:
        credentials = service_account.Credentials.from_service_account_file(source_value, scopes=DRIVE_UPLOAD_SCOPES)

    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def _normalize_uploaded_image(file_storage):
    if not file_storage or not getattr(file_storage, "filename", ""):
        return None
    if Image is None:
        raise RuntimeError("Pillow is not installed. Install requirements.txt first.")

    raw_bytes = file_storage.read()
    file_storage.stream.seek(0)

    if not raw_bytes:
        return None
    if len(raw_bytes) > MYTIMELINE_IMAGE_MAX_BYTES:
        raise _timeline_image_error("画像は8MB以内にしてください。")

    try:
        with Image.open(io.BytesIO(raw_bytes)) as image:
            image.verify()
        with Image.open(io.BytesIO(raw_bytes)) as image:
            image_format = (image.format or "").upper()
            if image_format not in MYTIMELINE_ALLOWED_IMAGE_FORMATS:
                raise _timeline_image_error("画像は JPEG / PNG / WEBP / GIF のみ対応です。")
            if image_format == "GIF":
                width, height = image.size
                normalized_bytes = raw_bytes
                mime_type = Image.MIME.get(image_format, file_storage.mimetype or "application/octet-stream")
            else:
                working = ImageOps.exif_transpose(image) if ImageOps is not None else image.copy()
                if working.mode not in {"RGB", "RGBA"}:
                    if "A" in working.getbands():
                        working = working.convert("RGBA")
                    else:
                        working = working.convert("RGB")

                working.thumbnail(
                    (MYTIMELINE_IMAGE_MAX_DIMENSION, MYTIMELINE_IMAGE_MAX_DIMENSION),
                    Image.Resampling.LANCZOS,
                )
                width, height = working.size

                output = io.BytesIO()
                has_alpha = "A" in working.getbands()
                if has_alpha:
                    working.save(output, format="WEBP", quality=MYTIMELINE_WEBP_QUALITY, method=6)
                    image_format = "WEBP"
                else:
                    if working.mode != "RGB":
                        working = working.convert("RGB")
                    working.save(
                        output,
                        format="JPEG",
                        quality=MYTIMELINE_JPEG_QUALITY,
                        optimize=True,
                        progressive=True,
                    )
                    image_format = "JPEG"
                normalized_bytes = output.getvalue()
                mime_type = Image.MIME.get(image_format, file_storage.mimetype or "application/octet-stream")
    except UnidentifiedImageError as exc:
        raise _timeline_image_error("画像ファイルを読み取れませんでした。") from exc

    if len(normalized_bytes) > MYTIMELINE_IMAGE_MAX_BYTES:
        raise _timeline_image_error("圧縮後も画像サイズが大きすぎます。もう少し小さい画像を使ってください。")

    return {
        "bytes": normalized_bytes,
        "mime_type": mime_type,
        "width": int(width),
        "height": int(height),
        "filename": os.path.basename(file_storage.filename or "upload"),
    }


def _upload_image_to_drive(image_payload: dict):
    folder_id = _timeline_drive_folder_id()
    if not folder_id:
        raise RuntimeError("MYTIMELINE_DRIVE_FOLDER_ID is not configured.")

    service = _get_drive_service()
    timestamp = datetime.now(TOKYO_TZ).strftime("%Y%m%d-%H%M%S")
    filename = image_payload.get("filename") or f"mytimeline-{timestamp}"
    metadata = {
        "name": f"mytimeline-{timestamp}-{filename}",
        "parents": [folder_id],
    }
    media = MediaIoBaseUpload(
        io.BytesIO(image_payload["bytes"]),
        mimetype=image_payload["mime_type"],
        resumable=False,
    )
    created = service.files().create(
        body=metadata,
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return {
        "drive_file_id": created["id"],
        "mime_type": image_payload["mime_type"],
        "width": image_payload["width"],
        "height": image_payload["height"],
    }


def _delete_drive_file(file_id: str) -> None:
    if not file_id or not _timeline_image_upload_enabled():
        return
    try:
        service = _get_drive_service()
        service.files().delete(fileId=file_id, supportsAllDrives=True).execute()
    except Exception as exc:
        app.logger.warning("Failed to delete Drive image %s: %s", file_id, exc)


def _download_drive_file(file_id: str) -> bytes:
    service = _get_drive_service()
    return service.files().get_media(fileId=file_id, supportsAllDrives=True).execute()


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


def _strip_tags_from_content(content: str) -> str:
    # Remove hashtag tokens while keeping surrounding text structure.
    cleaned = re.sub(r"(^|[\s\u3000])#([0-9A-Za-z_ぁ-んァ-ヶ一-龠ー]+)", r"\1", content)
    lines = []
    for line in cleaned.splitlines():
        normalized = re.sub(r"[ \t]{2,}", " ", line).strip()
        lines.append(normalized)
    return "\n".join(lines).strip()


def _timeline_search_posts(posts, query: str):
    if not query:
        return posts
    q = query.lower().strip()
    hashtag_terms = [_normalize_tag(tag) for tag in TAG_PATTERN.findall(query)]
    text_query = TAG_PATTERN.sub(" ", query)
    text_query = re.sub(r"\s+", " ", text_query).strip().lower()
    filtered = []
    for post in posts:
        content = (post.get("content") or "").lower()
        tags = [str(t).lower() for t in (post.get("tags") or [])]
        hashtag_match = all(term in tags for term in hashtag_terms) if hashtag_terms else True
        text_match = (not text_query) or (text_query in content) or any(text_query in t for t in tags)
        fallback_match = q in content or any(q in t for t in tags)
        if hashtag_match and text_match and (hashtag_terms or text_query or fallback_match):
            filtered.append(post)
    return filtered


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


def _clean_detected_url(url: str) -> str:
    cleaned = url.rstrip(".,!?;:)]}")
    cleaned = cleaned.lstrip("(")
    return cleaned


def _extract_urls(content: str, max_urls: int = 3):
    urls = []
    seen = set()
    for match in URL_PATTERN.finditer(content):
        raw = match.group(1)
        url = _clean_detected_url(raw)
        if not url or url in seen:
            continue
        if not _is_public_fetchable_url(url):
            continue
        seen.add(url)
        urls.append(url)
        if len(urls) >= max_urls:
            break
    return urls


def _is_public_fetchable_url(url: str) -> bool:
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False
    if host in {"localhost", "127.0.0.1", "::1"}:
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            return False
    except ValueError:
        # Hostname (non-literal IP)
        pass
    return True


def _linkify_text(text: str) -> str:
    parts = []
    last_index = 0
    for match in URL_PATTERN.finditer(text):
        start, end = match.span(1)
        raw = match.group(1)
        url = _clean_detected_url(raw)
        raw_visible = raw

        parts.append(html.escape(text[last_index:start]))

        if url and _is_public_fetchable_url(url):
            safe_href = html.escape(url, quote=True)
            safe_label = html.escape(url)
            parts.append(
                f'<a href="{safe_href}" target="_blank" rel="noopener noreferrer nofollow ugc">{safe_label}</a>'
            )
            trailing = raw_visible[len(url):]
            if trailing:
                parts.append(html.escape(trailing))
        else:
            parts.append(html.escape(raw_visible))

        last_index = end

    parts.append(html.escape(text[last_index:]))
    return "".join(parts)


def _linkify_content(content: str) -> str:
    rendered_lines = []
    for raw_line in content.splitlines():
        stripped = raw_line.lstrip()
        if stripped.startswith(">"):
            quote_body = stripped[1:].lstrip()
            quote_html = _linkify_text(quote_body)
            rendered_lines.append(f'<span class="timeline-quote">{quote_html or "&nbsp;"}</span>')
        else:
            rendered_lines.append(_linkify_text(raw_line))
    return "<br>".join(rendered_lines)


def _remove_urls_from_content(content: str, urls_to_remove):
    if not urls_to_remove:
        return content
    cleaned = content
    for url in urls_to_remove:
        if not url:
            continue
        cleaned = cleaned.replace(url, "")

    lines = []
    for line in cleaned.splitlines():
        normalized = re.sub(r"[ \t]{2,}", " ", line).strip()
        lines.append(normalized)
    return "\n".join(lines).strip()


def _fetch_text(url: str, timeout: int = 5, max_bytes: int = 250_000):
    req = Request(url, headers={"User-Agent": FETCH_USER_AGENT})
    with urlopen(req, timeout=timeout) as res:
        raw = res.read(max_bytes + 1)
        if len(raw) > max_bytes:
            raw = raw[:max_bytes]
        content_type = res.headers.get("Content-Type", "")
        charset = "utf-8"
        if "charset=" in content_type:
            charset = content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
        return raw.decode(charset, errors="replace")


def _fetch_json(url: str, timeout: int = 5):
    text = _fetch_text(url, timeout=timeout, max_bytes=200_000)
    return json.loads(text)


def _extract_attr(tag: str, attr_name: str):
    pattern = rf'{attr_name}\s*=\s*["\']([^"\']+)["\']'
    match = re.search(pattern, tag, flags=re.IGNORECASE)
    return match.group(1).strip() if match else ""


def _extract_ogp_from_html(page_url: str, html_text: str):
    head = html_text[:200_000]
    metas = re.findall(r"<meta\s+[^>]*>", head, flags=re.IGNORECASE)

    by_property = {}
    by_name = {}
    for meta_tag in metas:
        prop = _extract_attr(meta_tag, "property").lower()
        name = _extract_attr(meta_tag, "name").lower()
        content = _extract_attr(meta_tag, "content")
        if not content:
            continue
        if prop:
            by_property[prop] = content
        if name:
            by_name[name] = content

    title = by_property.get("og:title") or by_name.get("twitter:title")
    if not title:
        title_match = re.search(r"<title[^>]*>(.*?)</title>", head, flags=re.IGNORECASE | re.DOTALL)
        title = title_match.group(1).strip() if title_match else ""

    description = (
        by_property.get("og:description")
        or by_name.get("twitter:description")
        or by_name.get("description")
        or ""
    )
    image_url = by_property.get("og:image") or by_name.get("twitter:image") or ""
    site_name = by_property.get("og:site_name") or urlsplit(page_url).hostname or ""

    if image_url:
        image_url = urljoin(page_url, image_url)

    if not title:
        return None

    return {
        "url": page_url,
        "title": title,
        "description": description,
        "image_url": image_url,
        "site_name": site_name,
    }


def _fetch_spotify_preview(url: str):
    oembed_url = f"https://open.spotify.com/oembed?url={url}"
    data = _fetch_json(oembed_url, timeout=5)
    title = (data.get("title") or "").strip()
    image_url = (data.get("thumbnail_url") or "").strip()
    if not title:
        return None
    return {
        "url": url,
        "title": title,
        "description": "",
        "image_url": image_url,
        "site_name": (data.get("provider_name") or "Spotify"),
    }


def _fetch_link_preview(url: str):
    host = (urlsplit(url).hostname or "").lower()
    try:
        if host.endswith("open.spotify.com"):
            preview = _fetch_spotify_preview(url)
            if preview:
                return preview

        page = _fetch_text(url, timeout=5, max_bytes=250_000)
        return _extract_ogp_from_html(url, page)
    except (URLError, HTTPError, TimeoutError, socket.timeout, ValueError, json.JSONDecodeError):
        return None
    except Exception:
        return None


def _init_timeline_preview_table() -> None:
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS mytimeline_link_previews (
                      url TEXT PRIMARY KEY,
                      title TEXT NOT NULL,
                      description TEXT NOT NULL DEFAULT '',
                      image_url TEXT NOT NULL DEFAULT '',
                      site_name TEXT NOT NULL DEFAULT '',
                      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS mytimeline_link_previews (
              url TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              description TEXT NOT NULL DEFAULT '',
              image_url TEXT NOT NULL DEFAULT '',
              site_name TEXT NOT NULL DEFAULT '',
              fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()


def _parse_cached_time(value):
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except ValueError:
            try:
                return datetime.fromisoformat(value.replace("Z", "+00:00"))
            except ValueError:
                return None
    return None


def _get_cached_preview(url: str):
    _init_timeline_preview_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT url, title, description, image_url, site_name, fetched_at
                    FROM mytimeline_link_previews
                    WHERE url = %s
                    """,
                    (url,),
                )
                row = cur.fetchone()
        if not row:
            return None
        url_value, title, description, image_url, site_name, fetched_at = row
        return {
            "url": url_value,
            "title": title,
            "description": description,
            "image_url": image_url,
            "site_name": site_name,
            "fetched_at": _parse_cached_time(fetched_at),
        }

    with _open_timeline_db() as conn:
        row = conn.execute(
            """
            SELECT url, title, description, image_url, site_name, fetched_at
            FROM mytimeline_link_previews
            WHERE url = ?
            """,
            (url,),
        ).fetchone()
    if not row:
        return None
    return {
        "url": row["url"],
        "title": row["title"],
        "description": row["description"],
        "image_url": row["image_url"],
        "site_name": row["site_name"],
        "fetched_at": _parse_cached_time(row["fetched_at"]),
    }


def _upsert_preview(preview: dict):
    _init_timeline_preview_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO mytimeline_link_previews (url, title, description, image_url, site_name, fetched_at)
                    VALUES (%s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (url)
                    DO UPDATE SET
                      title = EXCLUDED.title,
                      description = EXCLUDED.description,
                      image_url = EXCLUDED.image_url,
                      site_name = EXCLUDED.site_name,
                      fetched_at = NOW()
                    """,
                    (
                        preview["url"],
                        preview.get("title", ""),
                        preview.get("description", ""),
                        preview.get("image_url", ""),
                        preview.get("site_name", ""),
                    ),
                )
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute(
            """
            INSERT INTO mytimeline_link_previews (url, title, description, image_url, site_name, fetched_at)
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(url) DO UPDATE SET
              title=excluded.title,
              description=excluded.description,
              image_url=excluded.image_url,
              site_name=excluded.site_name,
              fetched_at=CURRENT_TIMESTAMP
            """,
            (
                preview["url"],
                preview.get("title", ""),
                preview.get("description", ""),
                preview.get("image_url", ""),
                preview.get("site_name", ""),
            ),
        )
        conn.commit()


def _is_preview_stale(cached: dict) -> bool:
    fetched_at = cached.get("fetched_at")
    if not isinstance(fetched_at, datetime):
        return True
    if fetched_at.tzinfo is None:
        fetched_at = fetched_at.replace(tzinfo=timezone.utc)
    age = datetime.now(timezone.utc) - fetched_at.astimezone(timezone.utc)
    return age.total_seconds() > OGP_CACHE_TTL_SECONDS


def _get_preview_with_cache(url: str):
    cached = _get_cached_preview(url)
    if cached and not _is_preview_stale(cached):
        return cached

    fetched = _fetch_link_preview(url)
    if fetched:
        _upsert_preview(fetched)
        fetched["fetched_at"] = datetime.now(timezone.utc)
        return fetched
    return cached


def _timeline_prepare_posts(posts):
    prepared = []
    prev_date_label = None
    runtime_preview_cache = {}
    for index, post in enumerate(posts):
        created_at = post.get("created_at")
        if hasattr(created_at, "month") and hasattr(created_at, "day") and hasattr(created_at, "hour") and hasattr(created_at, "minute"):
            if getattr(created_at, "tzinfo", None) is None:
                display_dt = created_at.replace(tzinfo=timezone.utc).astimezone(TOKYO_TZ)
            else:
                display_dt = created_at.astimezone(TOKYO_TZ)
            date_label = f"{display_dt.month}/{display_dt.day}"
            time_label = f"{display_dt.hour:02d}:{display_dt.minute:02d}"
            edit_datetime_local = display_dt.strftime("%Y-%m-%dT%H:%M")
        else:
            date_label = ""
            time_label = str(created_at)
            edit_datetime_local = ""

        content = post.get("content", "")
        urls = _extract_urls(content)
        link_previews = []
        for link_url in urls:
            if link_url in runtime_preview_cache:
                preview = runtime_preview_cache[link_url]
            else:
                preview = _get_preview_with_cache(link_url)
                runtime_preview_cache[link_url] = preview
            if preview:
                link_previews.append(preview)

        preview_urls = [p.get("url", "") for p in link_previews]
        display_content = _remove_urls_from_content(content, preview_urls)

        item = dict(post)
        item["date_label"] = date_label
        item["time_label"] = time_label
        item["show_date_divider"] = bool(date_label) and (date_label != prev_date_label)
        item["content_html"] = _linkify_content(display_content)
        item["link_previews"] = link_previews
        item["edit_datetime_local"] = edit_datetime_local
        item["image_url"] = url_for("mytimeline_image", post_id=post["id"]) if post.get("image_drive_file_id") else ""
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
                      image_drive_file_id TEXT NOT NULL DEFAULT '',
                      image_mime_type TEXT NOT NULL DEFAULT '',
                      image_width INTEGER,
                      image_height INTEGER,
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
                cur.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN IF NOT EXISTS image_drive_file_id TEXT NOT NULL DEFAULT ''
                    """
                )
                cur.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN IF NOT EXISTS image_mime_type TEXT NOT NULL DEFAULT ''
                    """
                )
                cur.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN IF NOT EXISTS image_width INTEGER
                    """
                )
                cur.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN IF NOT EXISTS image_height INTEGER
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
                  image_drive_file_id TEXT NOT NULL DEFAULT '',
                  image_mime_type TEXT NOT NULL DEFAULT '',
                  image_width INTEGER,
                  image_height INTEGER,
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
            if "image_drive_file_id" not in column_names:
                conn.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN image_drive_file_id TEXT NOT NULL DEFAULT ''
                    """
                )
            if "image_mime_type" not in column_names:
                conn.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN image_mime_type TEXT NOT NULL DEFAULT ''
                    """
                )
            if "image_width" not in column_names:
                conn.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN image_width INTEGER
                    """
                )
            if "image_height" not in column_names:
                conn.execute(
                    """
                    ALTER TABLE mytimeline_posts
                    ADD COLUMN image_height INTEGER
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
                    SELECT id, content, tags, image_drive_file_id, image_mime_type, image_width, image_height, created_at
                    FROM mytimeline_posts
                    ORDER BY created_at DESC, id DESC
                    LIMIT %s
                    """,
                    (limit,),
                )
                rows = cur.fetchall()

        posts = []
        for row in rows:
            post_id, content, tags_raw, image_drive_file_id, image_mime_type, image_width, image_height, created_at = row
            try:
                tags = json.loads(tags_raw or "[]")
            except (ValueError, TypeError):
                tags = []
            posts.append({
                "id": post_id,
                "content": content,
                "tags": tags,
                "image_drive_file_id": image_drive_file_id or "",
                "image_mime_type": image_mime_type or "",
                "image_width": image_width,
                "image_height": image_height,
                "created_at": created_at,
            })
        return posts

    with _open_timeline_db() as conn:
        rows = conn.execute(
            """
            SELECT id, content, tags, image_drive_file_id, image_mime_type, image_width, image_height, created_at
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
            "image_drive_file_id": row["image_drive_file_id"] or "",
            "image_mime_type": row["image_mime_type"] or "",
            "image_width": row["image_width"],
            "image_height": row["image_height"],
            "created_at": parsed_created_at,
        })
    return posts


def _timeline_insert_post(content: str, tags, image_meta=None) -> None:
    tags_json = json.dumps(tags, ensure_ascii=False)
    image_meta = image_meta or {}
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO mytimeline_posts (content, tags, image_drive_file_id, image_mime_type, image_width, image_height)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        content,
                        tags_json,
                        image_meta.get("drive_file_id", ""),
                        image_meta.get("mime_type", ""),
                        image_meta.get("width"),
                        image_meta.get("height"),
                    ),
                )
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute(
            """
            INSERT INTO mytimeline_posts (content, tags, image_drive_file_id, image_mime_type, image_width, image_height)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                content,
                tags_json,
                image_meta.get("drive_file_id", ""),
                image_meta.get("mime_type", ""),
                image_meta.get("width"),
                image_meta.get("height"),
            ),
        )
        conn.commit()


def _parse_timeline_local_datetime(value: str):
    if not value:
        return None
    try:
        local_dt = datetime.strptime(value, "%Y-%m-%dT%H:%M")
    except ValueError:
        return None
    return local_dt.replace(tzinfo=TOKYO_TZ).astimezone(timezone.utc)


def _timeline_get_post(post_id: int):
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT id, content, tags, image_drive_file_id, image_mime_type, image_width, image_height, created_at
                    FROM mytimeline_posts
                    WHERE id = %s
                    """,
                    (post_id,),
                )
                row = cur.fetchone()
        if not row:
            return None
        post_id, content, tags_raw, image_drive_file_id, image_mime_type, image_width, image_height, created_at = row
        with suppress(ValueError, TypeError):
            tags = json.loads(tags_raw or "[]")
            return {
                "id": post_id,
                "content": content,
                "tags": tags,
                "image_drive_file_id": image_drive_file_id or "",
                "image_mime_type": image_mime_type or "",
                "image_width": image_width,
                "image_height": image_height,
                "created_at": created_at,
            }
        return {
            "id": post_id,
            "content": content,
            "tags": [],
            "image_drive_file_id": image_drive_file_id or "",
            "image_mime_type": image_mime_type or "",
            "image_width": image_width,
            "image_height": image_height,
            "created_at": created_at,
        }

    with _open_timeline_db() as conn:
        row = conn.execute(
            """
            SELECT id, content, tags, image_drive_file_id, image_mime_type, image_width, image_height, created_at
            FROM mytimeline_posts
            WHERE id = ?
            """,
            (post_id,),
        ).fetchone()
    if not row:
        return None
    try:
        tags = json.loads(row["tags"] or "[]")
    except (ValueError, TypeError):
        tags = []
    created_at = row["created_at"]
    try:
        parsed_created_at = datetime.strptime(created_at, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        parsed_created_at = created_at
    return {
        "id": row["id"],
        "content": row["content"],
        "tags": tags,
        "image_drive_file_id": row["image_drive_file_id"] or "",
        "image_mime_type": row["image_mime_type"] or "",
        "image_width": row["image_width"],
        "image_height": row["image_height"],
        "created_at": parsed_created_at,
    }


def _timeline_update_post(post_id: int, content: str, tags, created_at_utc: datetime, image_meta=None) -> None:
    tags_json = json.dumps(tags, ensure_ascii=False)
    image_meta = image_meta or {}
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE mytimeline_posts
                    SET content = %s, tags = %s, image_drive_file_id = %s, image_mime_type = %s, image_width = %s, image_height = %s, created_at = %s
                    WHERE id = %s
                    """,
                    (
                        content,
                        tags_json,
                        image_meta.get("drive_file_id", ""),
                        image_meta.get("mime_type", ""),
                        image_meta.get("width"),
                        image_meta.get("height"),
                        created_at_utc,
                        post_id,
                    ),
                )
            conn.commit()
        return

    created_at_str = created_at_utc.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    with _open_timeline_db() as conn:
        conn.execute(
            """
            UPDATE mytimeline_posts
            SET content = ?, tags = ?, image_drive_file_id = ?, image_mime_type = ?, image_width = ?, image_height = ?, created_at = ?
            WHERE id = ?
            """,
            (
                content,
                tags_json,
                image_meta.get("drive_file_id", ""),
                image_meta.get("mime_type", ""),
                image_meta.get("width"),
                image_meta.get("height"),
                created_at_str,
                post_id,
            ),
        )
        conn.commit()


def _timeline_delete_post(post_id: int) -> None:
    existing = _timeline_get_post(post_id)
    _init_timeline_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM mytimeline_posts WHERE id = %s", (post_id,))
            conn.commit()
    else:
        with _open_timeline_db() as conn:
            conn.execute("DELETE FROM mytimeline_posts WHERE id = ?", (post_id,))
            conn.commit()
    if existing and existing.get("image_drive_file_id"):
        _delete_drive_file(existing["image_drive_file_id"])


def _init_tetris_ranking_table() -> None:
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS super_tetris_scores (
                      id BIGSERIAL PRIMARY KEY,
                      name VARCHAR(16) NOT NULL,
                      score INTEGER NOT NULL CHECK (score >= 0),
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS super_tetris_scores (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              score INTEGER NOT NULL CHECK (score >= 0),
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()


def _tetris_insert_score(name: str, score: int) -> None:
    _init_tetris_ranking_table()
    safe_name = (name or "NONAME").strip()[:16] or "NONAME"
    safe_score = max(0, int(score))
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO super_tetris_scores (name, score)
                    VALUES (%s, %s)
                    """,
                    (safe_name, safe_score),
                )
            conn.commit()
        return

    with _open_timeline_db() as conn:
        conn.execute(
            """
            INSERT INTO super_tetris_scores (name, score)
            VALUES (?, ?)
            """,
            (safe_name, safe_score),
        )
        conn.commit()


def _tetris_top3():
    _init_tetris_ranking_table()
    if _timeline_db_kind() == "postgres":
        with _open_timeline_db() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT name, score, created_at
                    FROM super_tetris_scores
                    ORDER BY score DESC, created_at ASC
                    LIMIT 3
                    """
                )
                rows = cur.fetchall()
        return [
            {"name": str(name or "NONAME"), "score": int(score or 0), "created_at": str(created_at)}
            for name, score, created_at in rows
        ]

    with _open_timeline_db() as conn:
        rows = conn.execute(
            """
            SELECT name, score, created_at
            FROM super_tetris_scores
            ORDER BY score DESC, created_at ASC
            LIMIT 3
            """
        ).fetchall()
    return [
        {"name": str(row["name"] or "NONAME"), "score": int(row["score"] or 0), "created_at": str(row["created_at"])}
        for row in rows
    ]

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
    search_query = request.args.get("q", "").strip()
    all_posts = _timeline_list_posts()
    filtered_posts = _timeline_search_posts(all_posts, search_query)
    posts = _timeline_prepare_posts(filtered_posts)
    return render_template(
        "mytimeline.html",
        posts=posts,
        search_query=search_query,
    )


@app.route("/mytimeline/image/<int:post_id>")
def mytimeline_image(post_id: int):
    post = _timeline_get_post(post_id)
    if not post or not post.get("image_drive_file_id"):
        abort(404)
    try:
        image_bytes = _download_drive_file(post["image_drive_file_id"])
    except Exception as exc:
        app.logger.warning("Failed to fetch Drive image for post %s: %s", post_id, exc)
        abort(404)

    response = send_file(
        io.BytesIO(image_bytes),
        mimetype=post.get("image_mime_type") or "application/octet-stream",
        download_name=f"mytimeline-{post_id}",
    )
    response.headers["Cache-Control"] = "public, max-age=3600"
    return response


@app.route("/mytimeline/edit/<token>", methods=["GET", "POST"])
def mytimeline_edit(token: str):
    expected_token = _timeline_edit_token()
    if not expected_token or token != expected_token:
        abort(404)

    error_message = request.args.get("error", "").strip()
    search_query = request.args.get("q", "").strip()
    if request.method == "POST":
        is_ajax = request.headers.get("X-Requested-With", "").lower() == "xmlhttprequest"
        raw_content = request.form.get("content", "").strip()
        image_file = request.files.get("image")
        tags = _extract_tags(raw_content)
        content = _strip_tags_from_content(raw_content)
        validation_error = ""
        image_meta = None
        image_payload = None
        if len(content) > 100:
            validation_error = "投稿内容は100文字以内にしてください。"
        elif len(tags) > 3:
            validation_error = "タグは最大3つまでです。"
        else:
            try:
                image_payload = _normalize_uploaded_image(image_file)
                if not content and not image_payload:
                    validation_error = "投稿内容が空です。"
                if image_payload and not _timeline_image_upload_enabled():
                    validation_error = "画像アップロード設定が未完了です。"
                elif image_payload:
                    image_meta = _upload_image_to_drive(image_payload)
            except ValueError as exc:
                validation_error = str(exc)
            except Exception as exc:
                app.logger.warning("Failed to upload timeline image: %s", exc)
                validation_error = "画像のアップロードに失敗しました。"

        if validation_error:
            if is_ajax:
                return jsonify({"ok": False, "error": validation_error}), 400
            error_message = validation_error
        else:
            try:
                _timeline_insert_post(content, tags, image_meta=image_meta)
            except Exception:
                if image_meta and image_meta.get("drive_file_id"):
                    _delete_drive_file(image_meta["drive_file_id"])
                raise
            if is_ajax:
                latest_posts = _timeline_prepare_posts(_timeline_list_posts(limit=1))
                post_html = ""
                if latest_posts:
                    post_html = render_template(
                        "_mytimeline_edit_item.html",
                        post=latest_posts[0],
                        token=token,
                        search_query=search_query,
                    )
                return jsonify({"ok": True, "post_html": post_html})
            return redirect(url_for("mytimeline_edit", token=token, posted=1, q=search_query or None))

    all_posts = _timeline_list_posts()
    filtered_posts = _timeline_search_posts(all_posts, search_query)
    posts = _timeline_prepare_posts(filtered_posts)
    posted = request.args.get("posted") == "1"
    return render_template(
        "mytimeline_edit.html",
        posts=posts,
        search_query=search_query,
        token=token,
        posted=posted,
        error_message=error_message,
        image_upload_enabled=_timeline_image_upload_enabled(),
    )


@app.route("/mytimeline/edit/<token>/update/<int:post_id>", methods=["POST"])
def mytimeline_update(token: str, post_id: int):
    expected_token = _timeline_edit_token()
    if not expected_token or token != expected_token:
        abort(404)

    search_query = request.args.get("q", "").strip()
    raw_content = request.form.get("content", "").strip()
    raw_tags = request.form.get("tags", "").strip()
    raw_datetime = request.form.get("created_at_local", "").strip()
    remove_image = request.form.get("remove_image") == "1"
    image_file = request.files.get("image")
    existing_post = _timeline_get_post(post_id)
    if not existing_post:
        abort(404)

    tags = _extract_tags(raw_tags)
    content = raw_content
    created_at_utc = _parse_timeline_local_datetime(raw_datetime)

    if len(content) > 100:
        return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error="投稿内容は100文字以内にしてください。"))
    if len(tags) > 3:
        return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error="タグは最大3つまでです。"))
    if not created_at_utc:
        return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error="日時の形式が不正です。"))
    try:
        image_payload = _normalize_uploaded_image(image_file)
    except ValueError as exc:
        return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error=str(exc)))
    except Exception as exc:
        app.logger.warning("Failed to read timeline image: %s", exc)
        return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error="画像の読み込みに失敗しました。"))
    if not content and not image_payload and not existing_post.get("image_drive_file_id"):
        return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error="投稿内容が空です。"))

    current_image_meta = {
        "drive_file_id": existing_post.get("image_drive_file_id", ""),
        "mime_type": existing_post.get("image_mime_type", ""),
        "width": existing_post.get("image_width"),
        "height": existing_post.get("image_height"),
    }
    next_image_meta = dict(current_image_meta)
    old_drive_file_id = current_image_meta.get("drive_file_id", "")
    newly_uploaded_file_id = ""

    if image_payload:
        if not _timeline_image_upload_enabled():
            return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error="画像アップロード設定が未完了です。"))
        try:
            next_image_meta = _upload_image_to_drive(image_payload)
            newly_uploaded_file_id = next_image_meta.get("drive_file_id", "")
        except Exception as exc:
            app.logger.warning("Failed to replace timeline image: %s", exc)
            return redirect(url_for("mytimeline_edit", token=token, q=search_query or None, error="画像のアップロードに失敗しました。"))
    elif remove_image:
        next_image_meta = {"drive_file_id": "", "mime_type": "", "width": None, "height": None}

    try:
        _timeline_update_post(post_id, content, tags, created_at_utc, image_meta=next_image_meta)
    except Exception:
        if newly_uploaded_file_id:
            _delete_drive_file(newly_uploaded_file_id)
        raise

    if old_drive_file_id and old_drive_file_id != next_image_meta.get("drive_file_id", ""):
        _delete_drive_file(old_drive_file_id)
    return redirect(url_for("mytimeline_edit", token=token, q=search_query or None))


@app.route("/mytimeline/edit/<token>/delete/<int:post_id>", methods=["POST"])
def mytimeline_delete(token: str, post_id: int):
    expected_token = _timeline_edit_token()
    if not expected_token or token != expected_token:
        abort(404)
    _timeline_delete_post(post_id)
    search_query = request.args.get("q", "").strip()
    return redirect(url_for("mytimeline_edit", token=token, q=search_query or None))


@app.route("/api/ranking", methods=["GET", "POST"])
@app.route("/lab/super_tetris/api/ranking", methods=["GET", "POST"])
def super_tetris_ranking_api():
    if request.method == "GET":
        return jsonify(_tetris_top3())

    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name", "NONAME")).strip()[:16] or "NONAME"
    try:
        score = int(payload.get("score", 0))
    except (TypeError, ValueError):
        score = 0
    score = max(0, score)
    _tetris_insert_score(name, score)
    return jsonify(_tetris_top3())

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)
