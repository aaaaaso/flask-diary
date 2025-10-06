from flask import Flask, render_template
import markdown
import re
from datetime import datetime
import os

from notion_fetcher import fetch_diary_entries

app = Flask(__name__)

# 各ルートパスと NotionページID の対応表（"" は `/` に対応）
PAGE_ID_MAP = {
    "": os.getenv("NOTION_PAGE_ID"),           # /
    "page2": os.getenv("NOTION_PAGE_ID_PAGE2"),  # /page2
    "page3": os.getenv("NOTION_PAGE_ID_PAGE3"),  # /page3（将来用）
    "page4": os.getenv("NOTION_PAGE_ID_PAGE4"),  # /page4（将来用）
}

def fetch_from_local_md():
    """Notionが取得できなかったときのフォールバックロジック（Markdownファイルから）"""
    try:
        with open('diary.md', encoding='utf-8') as f:
            content = f.read()
    except FileNotFoundError:
        return [{"date": "error", "html": "<p>ローカル日記ファイルが見つかりませんでした。</p>"}]

    entries = re.split(r'^## (\d{4}-\d{2}-\d{2})\n', content, flags=re.MULTILINE)

    diary = []
    for i in range(1, len(entries), 2):
        raw_date = entries[i]
        md_text = entries[i + 1]

        try:
            date_obj = datetime.strptime(raw_date, "%Y-%m-%d")
            display_date = date_obj.strftime("%-m/%-d")
        except ValueError:
            display_date = raw_date

        html = markdown.markdown(md_text.strip())
        diary.append({'date': display_date, 'html': html})
    return diary

@app.route('/')
@app.route('/<page>')
def dynamic_page(page=""):
    page_id = PAGE_ID_MAP.get(page)

    # 未定義のページは404扱い
    if not page_id:
        return "404 Not Found", 404

    try:
        diary = fetch_diary_entries(page_id)
    except Exception as e:
        print(f"[ERROR] Failed to fetch Notion data for /{page or 'root'}: {e}")

        # トップページだけMarkdownにフォールバック
        if page == "":
            diary = fetch_from_local_md()
        else:
            diary = [{"date": "error", "html": "<p>日記の取得に失敗しました。</p>"}]

    return render_template('index.html', diary=diary)