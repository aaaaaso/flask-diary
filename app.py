from flask import Flask, render_template, abort
from settings import TOTAL_PAGES, PAGE_IDS     # settings.pyから読む
from notion_fetcher import fetch_diary_entries

app = Flask(__name__)

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

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=True)