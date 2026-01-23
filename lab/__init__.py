import os
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

@lab_bp.route("/")
def lab_index():
    root = _lab_root_dir()
    names = []
    for name in sorted(os.listdir(root)):
        if _is_experiment_dir(name):
            names.append(name)

    return render_template("lab_index.html", experiments=names)

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