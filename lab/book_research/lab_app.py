from flask import Blueprint, render_template

from .app import LAB_DESCRIPTION, LAB_TITLE, handle_search_request, handle_year_books_request

bp = Blueprint(
    "book_research",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)


@bp.get("/")
def index():
    return render_template("book_research/index.html")


@bp.get("/api/search")
def search_books():
    return handle_search_request()


@bp.get("/api/year-books")
def year_books():
    return handle_year_books_request()
