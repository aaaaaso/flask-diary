import os
from notion_client import Client
import markdown

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
                html = markdown.markdown("\n".join(current_lines))
                diary.append({"date": current_date, "html": html})
                current_lines = []
            current_date = block["heading_2"]["rich_text"][0]["plain_text"]
        elif block["type"] == "paragraph":
            texts = block["paragraph"]["rich_text"]
            if texts:
                line = "".join([t["plain_text"] for t in texts])
                current_lines.append(line)

    if current_date and current_lines:
        html = markdown.markdown("\n".join(current_lines))
        diary.append({"date": current_date, "html": html})

    return diary