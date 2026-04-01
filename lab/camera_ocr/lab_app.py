import base64
import os
import re
import sqlite3
import subprocess
import tempfile
from pathlib import Path

from flask import Blueprint, jsonify, render_template, request

LAB_TITLE = "Camera OCR Tool"
LAB_DESCRIPTION = "撮影、トリミング、OCR、ラベル保存をひとつの流れで行う。"

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "camera_ocr.db"
DEFAULT_OCR_LANG = (os.getenv("CAMERA_OCR_LANG") or "jpn").strip() or "jpn"
TESSERACT_CMD = (os.getenv("CAMERA_OCR_TESSERACT_CMD") or "tesseract").strip() or "tesseract"

bp = Blueprint(
    "camera_ocr",
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
        CREATE TABLE IF NOT EXISTS captures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL,
            extracted_text TEXT NOT NULL DEFAULT '',
            image_blob BLOB NOT NULL,
            mime_type TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()
    conn.close()


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    if not data_url.startswith("data:"):
        raise ValueError("image must be a data URL")

    header, encoded = data_url.split(",", 1)
    match = re.match(r"data:(.*?);base64$", header)
    if not match:
        raise ValueError("image must be base64 encoded")

    mime_type = match.group(1).strip() or "application/octet-stream"
    try:
        data = base64.b64decode(encoded)
    except ValueError as exc:
        raise ValueError("invalid image encoding") from exc
    return data, mime_type


def _run_tesseract(image_bytes: bytes, mime_type: str, lang: str) -> str:
    suffix = ".png"
    if mime_type == "image/jpeg":
        suffix = ".jpg"
    elif mime_type == "image/webp":
        suffix = ".webp"

    with tempfile.TemporaryDirectory() as tmpdir:
        input_path = Path(tmpdir) / f"input{suffix}"
        output_base = Path(tmpdir) / "ocr_result"
        input_path.write_bytes(image_bytes)

        try:
            subprocess.run(
                [TESSERACT_CMD, str(input_path), str(output_base), "-l", lang],
                check=True,
                capture_output=True,
                text=True,
            )
        except FileNotFoundError as exc:
            raise RuntimeError("tesseract command is not installed") from exc
        except subprocess.CalledProcessError as exc:
            stderr = (exc.stderr or "").strip()
            raise RuntimeError(stderr or "tesseract failed") from exc

        text_path = output_base.with_suffix(".txt")
        if not text_path.exists():
            raise RuntimeError("OCR result file was not generated")
        return text_path.read_text(encoding="utf-8").strip()


init_db()


@bp.get("/")
def index():
    return render_template("camera_ocr/index.html")


@bp.post("/api/ocr")
def run_ocr():
    payload = request.get_json(silent=True) or {}
    image_data_url = (payload.get("image") or "").strip()
    lang = (payload.get("lang") or DEFAULT_OCR_LANG).strip() or DEFAULT_OCR_LANG

    if not image_data_url:
        return jsonify({"error": "image is required"}), 400

    try:
        image_bytes, mime_type = _decode_data_url(image_data_url)
        text = _run_tesseract(image_bytes, mime_type, lang)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except RuntimeError as exc:
        return jsonify({"error": str(exc)}), 503

    return jsonify({"text": text, "lang": lang})


@bp.post("/api/records")
def save_record():
    payload = request.get_json(silent=True) or {}
    label = (payload.get("label") or "").strip()
    image_data_url = (payload.get("image") or "").strip()
    extracted_text = (payload.get("extractedText") or "").strip()

    if not label:
        return jsonify({"error": "label is required"}), 400
    if not image_data_url:
        return jsonify({"error": "image is required"}), 400

    try:
        image_bytes, mime_type = _decode_data_url(image_data_url)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    conn = db_conn()
    cursor = conn.execute(
        """
        INSERT INTO captures(label, extracted_text, image_blob, mime_type)
        VALUES(?, ?, ?, ?)
        """,
        (label, extracted_text, image_bytes, mime_type),
    )
    conn.commit()
    record_id = cursor.lastrowid
    row = conn.execute(
        """
        SELECT id, label, extracted_text, mime_type, created_at
        FROM captures
        WHERE id = ?
        """,
        (record_id,),
    ).fetchone()
    conn.close()
    return jsonify(dict(row)), 201


@bp.get("/api/records")
def list_records():
    conn = db_conn()
    rows = conn.execute(
        """
        SELECT id, label, extracted_text, mime_type, created_at
        FROM captures
        ORDER BY created_at DESC, id DESC
        LIMIT 20
        """
    ).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])
