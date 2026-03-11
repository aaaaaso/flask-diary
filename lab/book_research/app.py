import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from html import unescape
from pathlib import Path

from flask import Flask, jsonify, render_template, request

BASE_DIR = Path(__file__).resolve().parent
NDL_SRU_URL = "https://ndlsearch.ndl.go.jp/api/sru"
CACHE_TTL_SECONDS = 60 * 30
REQUEST_TIMEOUT_SECONDS = 20
MAX_KEYWORD_LENGTH = 120
FACET_BUCKET_LIMIT = 50
MIN_YEAR = 1000
BOOKS_PER_PAGE = 20
DEFAULT_START_YEAR = 1950
LAB_TITLE = "BOOK TREND RESEARCH"
LAB_DESCRIPTION = "指定したキーワードを含む書籍の出版数を年推移で見る。"

app = Flask(__name__, template_folder="templates", static_folder="static")


@dataclass
class CacheEntry:
    expires_at: float
    payload: dict


_cache: dict[str, CacheEntry] = {}
TITLE_TAG_RE = re.compile(r"<(?:[A-Za-z0-9_]+:)?title>(.*?)</(?:[A-Za-z0-9_]+:)?title>", re.DOTALL)


def _local_name(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[1]
    return tag


def _quote_cql_value(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _build_cql_query(keyword: str) -> str:
    return f"title={_quote_cql_value(keyword)} AND mediatype=\"books\""


def _build_year_range(keyword: str, start_year: int | None = None, end_year: int | None = None) -> str:
    parts = [_build_cql_query(keyword)]
    if start_year is not None:
        parts.append(f'from="{start_year}"')
    if end_year is not None:
        parts.append(f'until="{end_year}"')
    return " AND ".join(parts)


def _build_cache_key(keyword: str, start_year: int, end_year: int) -> str:
    return f"{keyword}\0{start_year}\0{end_year}"


def _fetch_ndl_xml_with_options(
    query_text: str,
    maximum_records: int = 1,
    start_record: int = 1,
    record_schema: str = "dc",
) -> bytes:
    query = urllib.parse.urlencode(
        {
            "operation": "searchRetrieve",
            "version": "1.2",
            "recordSchema": record_schema,
            "maximumRecords": str(maximum_records),
            "startRecord": str(start_record),
            "query": query_text,
        }
    )
    url = f"{NDL_SRU_URL}?{query}"
    with urllib.request.urlopen(url, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        return response.read()


def _fetch_ndl_xml(query_text: str) -> bytes:
    return _fetch_ndl_xml_with_options(query_text)


def _parse_year_facets(xml_bytes: bytes) -> tuple[int, dict[int, int]]:
    root = ET.fromstring(xml_bytes)

    diagnostics = [
        element
        for element in root.iter()
        if _local_name(element.tag) == "diagnostic"
    ]
    if diagnostics:
        details = []
        for diagnostic in diagnostics:
            parts = []
            for child in diagnostic:
                name = _local_name(child.tag)
                text = (child.text or "").strip()
                if name in {"message", "details"} and text:
                    parts.append(text)
            if parts:
                details.append(" / ".join(parts))
        message = details[0] if details else "NDL Search returned a diagnostic error."
        if "Record does not exist" in message:
            return 0, {}
        raise ValueError(message)

    number_of_records = 0
    year_counts: dict[int, int] = {}
    facets_xml = None

    for element in root.iter():
        name = _local_name(element.tag)
        text = (element.text or "").strip()

        if name == "numberOfRecords" and text.isdigit():
            number_of_records = int(text)

        if name == "extraResponseData" and text:
            facets_xml = text

    if facets_xml:
        facets_root = ET.fromstring(unescape(facets_xml))
        for element in facets_root.iter():
            if _local_name(element.tag) != "lst" or element.attrib.get("name") != "ISSUED_DATE":
                continue
            for child in element:
                if _local_name(child.tag) != "int":
                    continue
                year_text = (child.attrib.get("name") or "").strip()
                count_text = (child.text or "").strip()
                if not (year_text.isdigit() and count_text.isdigit()):
                    continue
                year_counts[int(year_text)] = int(count_text)
            break

    return number_of_records, year_counts


def _parse_title_records(xml_bytes: bytes) -> tuple[int, list[dict[str, str]]]:
    root = ET.fromstring(xml_bytes)
    number_of_records = 0
    items: list[dict[str, str]] = []

    for element in root.iter():
        name = _local_name(element.tag)
        text = (element.text or "").strip()
        if name == "numberOfRecords" and text.isdigit():
            number_of_records = int(text)

        if name != "recordData" or not text:
            continue

        title = ""
        match = TITLE_TAG_RE.search(unescape(text))
        if match:
            title = match.group(1).strip()
        if title:
            items.append({"title": title})

    return number_of_records, items


def _collect_year_counts(
    keyword: str,
    start_year: int,
    end_year: int,
    stats: dict[str, int],
) -> dict[int, int]:
    query_text = _build_year_range(keyword, start_year, end_year)
    xml_bytes = _fetch_ndl_xml(query_text)
    stats["requestCount"] += 1
    _, raw_year_counts = _parse_year_facets(xml_bytes)
    filtered_year_counts = {
        year: count
        for year, count in raw_year_counts.items()
        if start_year <= year <= end_year
    }

    if len(raw_year_counts) < FACET_BUCKET_LIMIT or start_year >= end_year:
        return filtered_year_counts

    mid_year = (start_year + end_year) // 2
    left_counts = _collect_year_counts(keyword, start_year, mid_year, stats)
    right_counts = _collect_year_counts(keyword, mid_year + 1, end_year, stats)
    return left_counts | right_counts


def _search_keyword(keyword: str, start_year: int, end_year: int) -> dict:
    base_query = _build_year_range(keyword, start_year, end_year)
    xml_bytes = _fetch_ndl_xml(base_query)
    total_count, base_year_counts = _parse_year_facets(xml_bytes)
    request_count = 1

    if len(base_year_counts) < FACET_BUCKET_LIMIT:
        year_counts = base_year_counts
    else:
        stats = {"requestCount": 0}
        bounded_start = max(MIN_YEAR, start_year)
        bounded_end = max(bounded_start, end_year)
        year_counts = _collect_year_counts(keyword, bounded_start, bounded_end, stats)
        request_count += stats["requestCount"]

    series = [
        {"year": year, "count": year_counts[year]}
        for year in sorted(year_counts)
    ]
    return {
        "keyword": keyword,
        "query": base_query,
        "source": NDL_SRU_URL,
        "totalCount": total_count,
        "yearCounts": series,
        "requestCount": request_count,
        "cached": False,
        "startYear": start_year,
        "endYear": end_year,
    }


def _fetch_year_books(keyword: str, year: int, page: int) -> dict:
    start_record = ((page - 1) * BOOKS_PER_PAGE) + 1
    query_text = _build_year_range(keyword, year, year)
    xml_bytes = _fetch_ndl_xml_with_options(
        query_text,
        maximum_records=BOOKS_PER_PAGE,
        start_record=start_record,
    )
    total_count, items = _parse_title_records(xml_bytes)
    total_pages = max(1, (total_count + BOOKS_PER_PAGE - 1) // BOOKS_PER_PAGE) if total_count else 1
    return {
        "keyword": keyword,
        "year": year,
        "page": page,
        "perPage": BOOKS_PER_PAGE,
        "totalCount": total_count,
        "totalPages": total_pages,
        "items": items,
    }


def _get_cached(keyword: str) -> dict | None:
    entry = _cache.get(keyword)
    if not entry:
        return None
    if entry.expires_at <= time.time():
        _cache.pop(keyword, None)
        return None
    return entry.payload


def _set_cached(keyword: str, payload: dict) -> None:
    _cache[keyword] = CacheEntry(
        expires_at=time.time() + CACHE_TTL_SECONDS,
        payload=payload,
    )


@app.get("/")
def index():
    return render_template("book_research/index.html")


def handle_search_request():
    keyword = (request.args.get("keyword") or "").strip()
    start_year_text = (request.args.get("startYear") or "").strip()
    end_year_text = (request.args.get("endYear") or "").strip()
    current_year = time.localtime().tm_year
    if not keyword:
        return jsonify({"error": "keyword is required"}), 400
    if len(keyword) > MAX_KEYWORD_LENGTH:
        return jsonify({"error": f"keyword must be {MAX_KEYWORD_LENGTH} characters or fewer"}), 400
    start_year = int(start_year_text) if start_year_text.isdigit() else DEFAULT_START_YEAR
    end_year = int(end_year_text) if end_year_text.isdigit() else current_year
    if start_year < MIN_YEAR or end_year < MIN_YEAR:
        return jsonify({"error": f"year must be {MIN_YEAR} or later"}), 400
    if start_year > end_year:
        return jsonify({"error": "startYear must be less than or equal to endYear"}), 400

    cache_key = _build_cache_key(keyword, start_year, end_year)
    cached = _get_cached(cache_key)
    if cached:
        return jsonify({**cached, "cached": True})

    try:
        payload = _search_keyword(keyword, start_year, end_year)
    except urllib.error.HTTPError as exc:
        return jsonify({"error": f"NDL Search returned HTTP {exc.code}"}), 502
    except urllib.error.URLError:
        return jsonify({"error": "Failed to reach NDL Search"}), 502
    except TimeoutError:
        return jsonify({"error": "Request to NDL Search timed out"}), 504
    except ET.ParseError:
        return jsonify({"error": "Failed to parse NDL Search response"}), 502
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 502

    _set_cached(cache_key, payload)
    return jsonify(payload)


@app.get("/api/search")
def search_books():
    return handle_search_request()


def handle_year_books_request():
    keyword = (request.args.get("keyword") or "").strip()
    year_text = (request.args.get("year") or "").strip()
    page_text = (request.args.get("page") or "1").strip()

    if not keyword:
        return jsonify({"error": "keyword is required"}), 400
    if not year_text.isdigit():
        return jsonify({"error": "year must be a number"}), 400
    if not page_text.isdigit() or int(page_text) < 1:
        return jsonify({"error": "page must be a positive number"}), 400

    try:
        payload = _fetch_year_books(keyword, int(year_text), int(page_text))
    except urllib.error.HTTPError as exc:
        return jsonify({"error": f"NDL Search returned HTTP {exc.code}"}), 502
    except urllib.error.URLError:
        return jsonify({"error": "Failed to reach NDL Search"}), 502
    except TimeoutError:
        return jsonify({"error": "Request to NDL Search timed out"}), 504
    except ET.ParseError:
        return jsonify({"error": "Failed to parse NDL Search response"}), 502
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 502

    return jsonify(payload)


@app.get("/api/year-books")
def year_books():
    return handle_year_books_request()


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5060"))
    app.run(debug=True, host=host, port=port)
