import os
from notion_client import Client
from dotenv import load_dotenv
import re
import markdown

load_dotenv()

notion = Client(auth=os.environ["NOTION_TOKEN"])
page_id = os.environ["NOTION_PAGE_ID"]

def fetch_diary_entries():
    blocks = notion.blocks.children.list(page_id)["results"]

    diary = []
    current_date = ""
    current_content = ""

    for block in blocks:
        if block["type"] == "heading_2":
            if current_date:
                diary.append({
                    "date": current_date,
                    "html": markdown.markdown(current_content.strip())
                })
                current_content = ""
            current_date = block["heading_2"]["rich_text"][0]["plain_text"]
        elif block["type"] == "paragraph":
            texts = block["paragraph"]["rich_text"]
            if texts:
                current_content += texts[0]["plain_text"] + "\n"

    if current_date:
        diary.append({
            "date": current_date,
            "html": markdown.markdown(current_content.strip())
        })

    return diary