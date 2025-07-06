from flask import Flask, render_template
import markdown
import re
from datetime import datetime
import os

app = Flask(__name__)

def load_diary_from_file():
    try:
        with open('diary.md', encoding='utf-8') as f:
            content = f.read()
    except FileNotFoundError:
        return []

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

def load_diary():
    try:
        from notion_fetcher import fetch_diary_entries
        return fetch_diary_entries()
    except Exception as e:
        print(f"[Notion読み込み失敗] {e}\n→ diary.md を読み込みます")
        return load_diary_from_file()

@app.route('/')
def index():
    diary = load_diary()
    return render_template('index.html', diary=diary)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    app.run(host='0.0.0.0', port=port, debug=True)