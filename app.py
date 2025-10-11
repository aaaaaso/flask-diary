from flask import Flask, render_template, abort
import os

from notion_fetcher import fetch_diary_entries

app = Flask(__name__)

# 総ページ数（Render環境変数で管理）。未設定なら2ページ想定。
TOTAL_PAGES = int(os.getenv("TOTAL_PAGES", "2"))

def env_key_for(n: int) -> str:
    # 1ページ目は NOTION_PAGE_ID、2ページ目以降は NOTION_PAGE_ID_PAGE{n}
    return "NOTION_PAGE_ID" if n == 1 else f"NOTION_PAGE_ID_PAGE{n}"

def fetch_diary_by_page(n: int):
    page_id = os.getenv(env_key_for(n))
    if not page_id:
        return [{
            "date": "error",
            "html": f"<p>ページ{n}の設定が見つかりません（{env_key_for(n)} 未設定）。</p>"
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
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=True)