from flask import Flask, render_template
import markdown
import re
from datetime import datetime

app = Flask(__name__)

def load_diary():
    with open('diary.md', encoding='utf-8') as f:
        content = f.read()

    # "## 2025-06-22" のような形式にマッチ
    entries = re.split(r'^## (\d{4}-\d{2}-\d{2})\n', content, flags=re.MULTILINE)

    diary = []
    for i in range(1, len(entries), 2):
        raw_date = entries[i]  # e.g. "2025-06-22"
        md_text = entries[i + 1]
        
        try:
            date_obj = datetime.strptime(raw_date, "%Y-%m-%d")
            display_date = date_obj.strftime("%-m/%-d")  # 6/22 の形式（Mac/Linux）
        except ValueError:
            display_date = raw_date  # 変換失敗したらそのまま

        html = markdown.markdown(md_text.strip())
        diary.append({'date': display_date, 'html': html})
    return diary

@app.route('/')
def index():
    diary = load_diary()
    return render_template('index.html', diary=diary)