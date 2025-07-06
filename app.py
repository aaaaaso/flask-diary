from flask import Flask, render_template
import markdown
import re

app = Flask(__name__)

def load_diary():
    with open('diary.md', encoding='utf-8') as f:
        content = f.read()

    entries = re.split(r'^## (\d{4}-\d{2}-\d{2})\n', content, flags=re.MULTILINE)
    # entries = [ '', date1, text1, date2, text2, ... ]
    diary = []
    for i in range(1, len(entries), 2):
        date = entries[i]
        md_text = entries[i + 1]
        html = markdown.markdown(md_text.strip())
        diary.append({'date': date, 'html': html})
    return diary

@app.route('/')
def index():
    diary = load_diary()
    return render_template('index.html', diary=diary)