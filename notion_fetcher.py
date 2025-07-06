import os
from notion_client import Client
from dotenv import load_dotenv

load_dotenv()

NOTION_TOKEN = os.getenv('NOTION_TOKEN')
NOTION_PAGE_ID = os.getenv('NOTION_PAGE_ID')

client = Client(auth=NOTION_TOKEN)

def fetch_diary_entries():
    blocks = client.blocks.children.list(NOTION_PAGE_ID)["results"]
    diary = []
    current_entry = None

    for block in blocks:
        if block["type"] == "heading_2":
            # 直前の日記を格納
            if current_entry:
                diary.append(current_entry)
            current_entry = {
                "date": block["heading_2"]["rich_text"][0]["plain_text"],
                "html": ""
            }
        elif block["type"] == "paragraph" and current_entry:
            texts = block["paragraph"]["rich_text"]
            if texts:
                content = "".join([t["plain_text"] for t in texts])
                current_entry["html"] += f"<p class='diary-block'>{content}</p>\n"

    # 最後のエントリを追加
    if current_entry:
        diary.append(current_entry)

    return diary