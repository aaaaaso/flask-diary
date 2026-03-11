const form = document.getElementById("search-form");
const keywordInput = document.getElementById("keyword-input");
const searchButton = document.getElementById("search-button");
const statusEl = document.getElementById("status");
const resultPanel = document.getElementById("result-panel");
const resultKeyword = document.getElementById("result-keyword");
const resultMeta = document.getElementById("result-meta");
const sourceLink = document.getElementById("source-link");
const chartRange = document.getElementById("chart-range");
const tableSummary = document.getElementById("table-summary");
const resultsBody = document.getElementById("results-body");
const chart = document.getElementById("chart");

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTable(rows) {
  resultsBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${row.year}</td>
          <td>${row.count.toLocaleString("ja-JP")}</td>
        </tr>
      `
    )
    .join("");
}

function renderEmptyChart() {
  chart.innerHTML = `
    <rect x="0" y="0" width="920" height="380" rx="24" fill="rgba(14, 109, 104, 0.05)"></rect>
    <text x="460" y="190" text-anchor="middle" fill="#5e6775" font-size="22">
      出版年ファセットの対象データがありません
    </text>
  `;
}

function renderChart(rows) {
  if (!rows.length) {
    renderEmptyChart();
    return;
  }

  const width = 920;
  const height = 380;
  const margin = { top: 26, right: 28, bottom: 50, left: 72 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const years = rows.map((row) => row.year);
  const counts = rows.map((row) => row.count);
  const maxCount = Math.max(...counts);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  const x = (year) => {
    if (minYear === maxYear) {
      return margin.left + innerWidth / 2;
    }
    return margin.left + ((year - minYear) / (maxYear - minYear)) * innerWidth;
  };

  const y = (count) => {
    if (maxCount === 0) {
      return margin.top + innerHeight;
    }
    return margin.top + innerHeight - (count / maxCount) * innerHeight;
  };

  const path = rows
    .map((row, index) => `${index === 0 ? "M" : "L"} ${x(row.year).toFixed(2)} ${y(row.count).toFixed(2)}`)
    .join(" ");

  const yTicks = 4;
  const grid = Array.from({ length: yTicks + 1 }, (_, index) => {
    const value = Math.round((maxCount / yTicks) * index);
    const py = y(value);
    return `
      <line x1="${margin.left}" y1="${py}" x2="${width - margin.right}" y2="${py}" stroke="rgba(28, 36, 48, 0.1)" />
      <text x="${margin.left - 12}" y="${py + 5}" text-anchor="end" fill="#5e6775" font-size="12">${value.toLocaleString("ja-JP")}</text>
    `;
  }).join("");

  const xTicks = rows
    .filter((_, index) => rows.length <= 12 || index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 6) === 0)
    .map((row) => `
      <text x="${x(row.year)}" y="${height - 16}" text-anchor="middle" fill="#5e6775" font-size="12">${row.year}</text>
    `)
    .join("");

  const points = rows
    .map(
      (row) => `
        <circle cx="${x(row.year)}" cy="${y(row.count)}" r="4.5" fill="#0e6d68"></circle>
        <title>${row.year}年: ${row.count.toLocaleString("ja-JP")}件</title>
      `
    )
    .join("");

  chart.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" rx="24" fill="rgba(14, 109, 104, 0.04)"></rect>
    ${grid}
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="rgba(28, 36, 48, 0.18)" />
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="rgba(28, 36, 48, 0.18)" />
    <path d="${path}" fill="none" stroke="#0e6d68" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
    ${points}
    ${xTicks}
  `;
}

async function runSearch(keyword) {
  searchButton.disabled = true;
  setStatus("NDL Search から集計中です...");

  try {
    const response = await fetch(`/api/search?keyword=${encodeURIComponent(keyword)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "検索に失敗しました");
    }

    const rows = data.yearCounts || [];
    resultPanel.classList.remove("hidden");
    resultKeyword.textContent = `「${data.keyword}」`;
    resultMeta.textContent = `${data.totalCount.toLocaleString("ja-JP")}件ヒット / ${data.requestCount.toLocaleString("ja-JP")} APIリクエスト / ${data.cached ? "キャッシュ" : "API"} 応答`;
    chartRange.textContent = rows.length ? `${rows[0].year}年 - ${rows[rows.length - 1].year}年` : "出版年なし";
    tableSummary.textContent = `${rows.length.toLocaleString("ja-JP")}年分`;
    sourceLink.href = data.source;
    sourceLink.textContent = "SRU エンドポイント";

    renderChart(rows);
    renderTable(rows);

    if (rows.length) {
      setStatus(`年次集計を更新しました。クエリ: ${data.query}`);
    } else {
      setStatus("検索結果はありましたが、出版年ファセットに年次データがありませんでした。");
    }
  } catch (error) {
    resultPanel.classList.add("hidden");
    setStatus(error.message, true);
  } finally {
    searchButton.disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    setStatus("キーワードを入力してください。", true);
    return;
  }
  runSearch(keyword);
});
