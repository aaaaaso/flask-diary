from flask import Flask, render_template
import markdown
import re
from datetime import datetime
import os

from notion_fetcher import fetch_diary_entries as fetch_from_notion
from notion_client.errors import APIResponseError

app = Flask(__name__)

def fetch_from_local_md():
    with open('diary.md', encoding='utf-8') as f:
        content = f.read()

    # "## 2025-06-22" のような形式にマッチ
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
def index():
    try:
        diary = fetch_diary_entries()
    except Exception as e:
        print(f"[WARN] Notion fetch failed, fallback to local file. Reason: {e}")
        diary = fetch_from_local_md()

    return render_template('index.html', diary=diary)

@app.route('/page2')
def page2():
    try:
        page2_id = os.getenv('NOTION_PAGE_ID_PAGE2')
        diary = fetch_diary_entries(page2_id)
    except Exception as e:
        print(f"[WARN] Notion page2 fetch failed. Reason: {e}")
        diary = [{"date": "error", "html": "<p>日記の取得に失敗しました。</p>"}]

    return render_template('index.html', diary=diary)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port, debug=True)