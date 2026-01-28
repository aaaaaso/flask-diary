import os
import re
from typing import Optional, Tuple
from flask import Blueprint, abort, render_template, send_from_directory, current_app

lab_bp = Blueprint("lab", __name__, url_prefix="/lab")

def _lab_root_dir() -> str:
    return os.path.join(current_app.root_path, "lab")

def _is_experiment_dir(dir_name: str) -> bool:
    if dir_name.startswith(".") or dir_name.startswith("_"):
        return False
    if dir_name in {"__pycache__"}:
        return False

    exp_dir = os.path.join(_lab_root_dir(), dir_name)
    if not os.path.isdir(exp_dir):
        return False

    return os.path.isfile(os.path.join(exp_dir, "index.html"))

def _extract_meta(path: str) -> Tuple[Optional[str], Optional[str]]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            html = f.read()
    except OSError:
        return None, None

    title_match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    title = title_match.group(1).strip() if title_match else None

    desc = None
    for tag in re.findall(r"<meta\s+[^>]*>", html, re.IGNORECASE | re.DOTALL):
        name_match = re.search(r"name\s*=\s*['\"]([^'\"]+)['\"]", tag, re.IGNORECASE)
        content_match = re.search(r"content\s*=\s*['\"]([^'\"]*)['\"]", tag, re.IGNORECASE)
        if not name_match or not content_match:
            continue
        if name_match.group(1).lower() == "description":
            desc = content_match.group(1).strip()
            break
    return title, desc

@lab_bp.route("/")
def lab_index():
    root = _lab_root_dir()
    experiments = []
    for name in sorted(os.listdir(root)):
        if _is_experiment_dir(name):
            exp_dir = os.path.join(root, name)
            index_path = os.path.join(exp_dir, "index.html")
            title, desc = _extract_meta(index_path)
            experiments.append({
                "name": name,
                "title": title or name,
                "desc": desc or "実験ページ。",
            })

    return render_template("lab_index.html", experiments=experiments)

@lab_bp.route("/<experiment>/")
def lab_experiment_index(experiment: str):
    if not _is_experiment_dir(experiment):
        abort(404)

    exp_dir = os.path.join(_lab_root_dir(), experiment)
    return send_from_directory(exp_dir, "index.html")

@lab_bp.route("/<experiment>/<path:filename>")
def lab_experiment_asset(experiment: str, filename: str):
    if not _is_experiment_dir(experiment):
        abort(404)

    exp_dir = os.path.join(_lab_root_dir(), experiment)
    return send_from_directory(exp_dir, filename)
