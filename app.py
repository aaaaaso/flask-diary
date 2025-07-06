from flask import Flask, render_template
from dotenv import load_dotenv
import os
from notion_fetcher import fetch_diary_entries

# .env を読み込む（NOTION_API_KEY, NOTION_PAGE_ID）
load_dotenv()

app = Flask(__name__)

@app.route('/')
def index():
    diary = fetch_diary_entries()
    return render_template('index.html', diary=diary)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))  # Render用にPORT環境変数、なければ5001
    app.run(host='0.0.0.0', port=port, debug=True)