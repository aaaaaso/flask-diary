# notion_fetcher.py
import os
from notion_client import Client
from datetime import datetime
from dotenv import load_dotenv
import time

load_dotenv()

NOTION_TOKEN = os.getenv('NOTION_TOKEN')
client = Client(auth=NOTION_TOKEN)

# In-memory cache for Notion fetches (per page_id)
_CACHE = {}
_CACHE_TTL_SECONDS = int(os.getenv('NOTION_CACHE_TTL_SECONDS', '300'))

def _get_cached(page_id: str):
    if _CACHE_TTL_SECONDS <= 0:
        return None
    cached = _CACHE.get(page_id)
    if not cached:
        return None
    expires_at, diary = cached
    if time.time() >= expires_at:
        _CACHE.pop(page_id, None)
        return None
    return diary

def _set_cache(page_id: str, diary):
    if _CACHE_TTL_SECONDS <= 0:
        return
    _CACHE[page_id] = (time.time() + _CACHE_TTL_SECONDS, diary)

def fetch_diary_entries(page_id=None):
    if page_id is None:
        page_id = os.getenv('NOTION_PAGE_ID')

    cached = _get_cached(page_id)
    if cached is not None:
        return cached

    diary = []
    current_date = None
    current_lines = []
    cursor = None

    while True:
        response = client.blocks.children.list(page_id, start_cursor=cursor)
        blocks = response["results"]

        for block in blocks:
            if block["type"] == "heading_2":
                if current_date and current_lines:
                    html = "\n".join([f"<p class='diary-block'>{line}</p>" for line in current_lines])
                    diary.append({"date": current_date, "html": html})
                    current_lines = []

                date_text = block["heading_2"]["rich_text"][0]["plain_text"]
                try:
                    date_obj = datetime.strptime(date_text, "%Y-%m-%d")
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

        if response.get("has_more"):
            cursor = response["next_cursor"]
        else:
            break

    if current_date and current_lines:
        html = "\n".join([f"<p class='diary-block'>{line}</p>" for line in current_lines])
        diary.append({"date": current_date, "html": html})

    _set_cache(page_id, diary)
    return diary
