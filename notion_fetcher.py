import os
from notion_client import Client
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

NOTION_TOKEN = os.getenv('NOTION_TOKEN')
NOTION_PAGE_ID = os.getenv('NOTION_PAGE_ID')

client = Client(auth=NOTION_TOKEN)

def fetch_diary_entries():
    blocks = client.blocks.children.list(NOTION_PAGE_ID)["results"]
    diary = []
    current_date = None
    current_lines = []

    for block in blocks:
        if block["type"] == "heading_2":
            if current_date and current_lines:
                html = "\n".join([f"<p class='diary-block'>{line}</p>" for line in current_lines])
                diary.append({"date": current_date, "html": html})
                current_lines = []

            # タイトルから日付取得
            date_text = block["heading_2"]["rich_text"][0]["plain_text"]
            try:
                date_obj = datetime.strptime(date_text, "%Y-%m-%d")
                # Mac/Linux: %-m, Windows: %#m（RenderはLinux）
                current_date = date_obj.strftime("%-m/%-d")
            except ValueError:
                current_date = date_text

        elif block["type"] == "paragraph":
            texts = block["paragraph"]["rich_text"]
            if texts:
                full_text = "".join([t["plain_text"] for t in texts])
                lines = full_text.split("\n")
                for line in lines:
                    if line.strip():
                        current_lines.append(line.strip())

    if current_date and current_lines:
        html = "\n".join([f"<p class='diary-block'>{line}</p>" for line in current_lines])
        diary.append({"date": current_date, "html": html})

    return diary