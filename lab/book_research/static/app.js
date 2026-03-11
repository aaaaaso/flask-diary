const form = document.getElementById("search-form");
const keywordInput = document.getElementById("keyword-input");
const searchButton = document.getElementById("search-button");
const statusEl = document.getElementById("status");
const filtersToggle = document.getElementById("filters-toggle");
const startYearInput = document.getElementById("start-year-input");
const endYearInput = document.getElementById("end-year-input");
const applyFiltersButton = document.getElementById("apply-filters-button");
const filtersPanel = document.getElementById("filters-panel");
const resultPanel = document.getElementById("result-panel");
const resultKeyword = document.getElementById("result-keyword");
const resultMeta = document.getElementById("result-meta");
const chartRange = document.getElementById("chart-range");
const tableSummary = document.getElementById("table-summary");
const resultsBody = document.getElementById("results-body");
const chart = document.getElementById("chart");
const chartTooltip = document.getElementById("chart-tooltip");
const booksPanel = document.getElementById("books-panel");
const booksMeta = document.getElementById("books-meta");
const booksStatus = document.getElementById("books-status");
const yearSelect = document.getElementById("year-select");
const loadBooksButton = document.getElementById("load-books-button");
const booksList = document.getElementById("books-list");
const prevPageButton = document.getElementById("prev-page-button");
const nextPageButton = document.getElementById("next-page-button");
const booksPageLabel = document.getElementById("books-page-label");
const booksPager = document.querySelector(".books-pager");
const searchApiUrl = new URL("./api/search", window.location.href);
const yearBooksApiUrl = new URL("./api/year-books", window.location.href);

const state = {
  keyword: "",
  years: [],
  selectedYear: null,
  page: 1,
  totalPages: 1,
  startYear: 1950,
  endYear: new Date().getFullYear(),
};

endYearInput.value = String(state.endYear);

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setBooksStatus(message, isError = false) {
  booksStatus.textContent = message;
  booksStatus.classList.toggle("error", isError);
}

function renderTable(rows) {
  resultsBody.innerHTML = rows
    .map(
      (row) => `
        <tr class="year-row" data-year="${row.year}">
          <td><button type="button" class="year-link" data-year="${row.year}">${row.year}</button></td>
          <td>${row.count.toLocaleString("ja-JP")}</td>
        </tr>
      `
    )
    .join("");
}

function renderEmptyChart() {
  chart.innerHTML = `
    <rect x="0" y="0" width="920" height="380" rx="24" fill="rgba(92, 102, 114, 0.05)"></rect>
    <text x="460" y="190" text-anchor="middle" fill="#707984" font-size="22">
      出版年ファセットの対象データがありません
    </text>
  `;
}

function getNiceStep(maxValue, tickCount) {
  if (maxValue <= 0) {
    return 1;
  }
  const roughStep = maxValue / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const residual = roughStep / magnitude;
  if (residual <= 1) {
    return magnitude;
  }
  if (residual <= 2) {
    return 2 * magnitude;
  }
  if (residual <= 5) {
    return 5 * magnitude;
  }
  return 10 * magnitude;
}

function hideChartTooltip() {
  chartTooltip.classList.add("hidden");
}

function updateChartTooltip(target) {
  const bounds = chart.getBoundingClientRect();
  const scaleX = bounds.width / 920;
  const scaleY = bounds.height / 380;
  const x = Number(target.dataset.x) * scaleX;
  const y = Number(target.dataset.y) * scaleY;
  chartTooltip.textContent = `${target.dataset.year}年: ${Number(target.dataset.count).toLocaleString("ja-JP")}件`;
  chartTooltip.style.left = `${x}px`;
  chartTooltip.style.top = `${y}px`;
  chartTooltip.classList.remove("hidden");
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
  const niceStep = getNiceStep(maxCount, 4);
  const niceMax = Math.max(niceStep, Math.ceil(maxCount / niceStep) * niceStep);
  const minYear = Math.min(...years);
  const maxYear = Math.max(...years);

  const x = (year) => {
    if (minYear === maxYear) {
      return margin.left + innerWidth / 2;
    }
    return margin.left + ((year - minYear) / (maxYear - minYear)) * innerWidth;
  };

  const y = (count) => {
    if (niceMax === 0) {
      return margin.top + innerHeight;
    }
    return margin.top + innerHeight - (count / niceMax) * innerHeight;
  };

  const path = rows
    .map((row, index) => `${index === 0 ? "M" : "L"} ${x(row.year).toFixed(2)} ${y(row.count).toFixed(2)}`)
    .join(" ");

  const grid = Array.from({ length: Math.floor(niceMax / niceStep) + 1 }, (_, index) => {
    const value = niceStep * index;
    const py = y(value);
    return `
      <line x1="${margin.left}" y1="${py}" x2="${width - margin.right}" y2="${py}" stroke="rgba(67, 75, 85, 0.08)" />
      <text x="${margin.left - 12}" y="${py + 5}" text-anchor="end" fill="#707984" font-size="12">${value.toLocaleString("ja-JP")}</text>
    `;
  }).join("");

  const xTicks = rows
    .filter((_, index) => rows.length <= 12 || index === 0 || index === rows.length - 1 || index % Math.ceil(rows.length / 6) === 0)
    .map((row) => `
      <text x="${x(row.year)}" y="${height - 16}" text-anchor="middle" fill="#707984" font-size="12">${row.year}</text>
    `)
    .join("");

  const points = rows
    .map(
      (row) => `
        <circle cx="${x(row.year)}" cy="${y(row.count)}" r="4.5" fill="#5c6672"></circle>
        <circle
          class="chart-hit-area"
          cx="${x(row.year)}"
          cy="${y(row.count)}"
          r="16"
          fill="transparent"
          data-year="${row.year}"
          data-count="${row.count}"
          data-x="${x(row.year)}"
          data-y="${y(row.count)}"
        ></circle>
      `
    )
    .join("");

  chart.innerHTML = `
    <rect x="0" y="0" width="${width}" height="${height}" rx="24" fill="rgba(92, 102, 114, 0.03)"></rect>
    ${grid}
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="rgba(67, 75, 85, 0.14)" />
    <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="rgba(67, 75, 85, 0.14)" />
    <path d="${path}" fill="none" stroke="#5c6672" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"></path>
    ${points}
    ${xTicks}
  `;

  chart.querySelectorAll(".chart-hit-area").forEach((node) => {
    node.addEventListener("mouseenter", () => updateChartTooltip(node));
    node.addEventListener("mousemove", () => updateChartTooltip(node));
    node.addEventListener("mouseleave", hideChartTooltip);
  });
}

function renderYearOptions(rows) {
  const years = [...rows].sort((a, b) => b.year - a.year);
  state.years = years.map((row) => row.year);
  yearSelect.innerHTML = years
    .map((row) => `<option value="${row.year}">${row.year}年</option>`)
    .join("");
}

function renderBooks(items) {
  if (!items.length) {
    booksList.innerHTML = '<li class="book-item empty">該当年の書誌が取得できませんでした。</li>';
    return;
  }

  booksList.innerHTML = items
    .map(
      (item) => `
        <li class="book-item">
          <span class="book-title">${item.title}</span>
        </li>
      `
    )
    .join("");
}

async function loadYearBooks(year, page = 1) {
  if (!state.keyword || !year) {
    return;
  }

  loadBooksButton.disabled = true;
  prevPageButton.disabled = true;
  nextPageButton.disabled = true;
  setBooksStatus(`${year}年の書誌一覧を取得中です...`);

  try {
    yearBooksApiUrl.search = new URLSearchParams({
      keyword: state.keyword,
      year: String(year),
      page: String(page),
    }).toString();
    const response = await fetch(yearBooksApiUrl.toString());
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "年別一覧の取得に失敗しました");
    }

    state.selectedYear = data.year;
    state.page = data.page;
    state.totalPages = data.totalPages;
    yearSelect.value = String(data.year);
    booksMeta.textContent = `「${data.keyword}」の ${data.year}年: ${data.totalCount.toLocaleString("ja-JP")}件`;
    booksPager.classList.toggle("hidden", data.totalPages <= 1);
    booksPageLabel.textContent = data.totalPages > 1 ? `${data.page} / ${data.totalPages} ページ` : "";
    prevPageButton.disabled = data.page <= 1;
    nextPageButton.disabled = data.page >= data.totalPages;
    prevPageButton.classList.toggle("hidden", data.page <= 1);
    nextPageButton.classList.toggle("hidden", data.page >= data.totalPages);
    renderBooks(data.items || []);
    setBooksStatus("年別の書誌一覧を更新しました。");
  } catch (error) {
    booksList.innerHTML = "";
    booksPageLabel.textContent = "";
    booksPager.classList.add("hidden");
    setBooksStatus(error.message, true);
  } finally {
    loadBooksButton.disabled = false;
  }
}

async function runSearch(keyword) {
  searchButton.disabled = true;
  setStatus("集計中...");

  try {
    const startYear = Number.parseInt(startYearInput.value, 10) || 1950;
    const endYear = Number.parseInt(endYearInput.value, 10) || new Date().getFullYear();
    searchApiUrl.search = new URLSearchParams({
      keyword,
      startYear: String(startYear),
      endYear: String(endYear),
    }).toString();
    const response = await fetch(searchApiUrl.toString());
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "検索に失敗しました");
    }

    const rows = data.yearCounts || [];
    state.keyword = data.keyword;
    state.startYear = data.startYear;
    state.endYear = data.endYear;
    startYearInput.value = String(data.startYear);
    endYearInput.value = String(data.endYear);
    state.selectedYear = rows.length ? rows[rows.length - 1].year : null;
    state.page = 1;
    state.totalPages = 1;

    resultPanel.classList.remove("hidden");
    booksPanel.classList.remove("hidden");
    resultKeyword.textContent = `「${data.keyword}」`;
    resultMeta.textContent = "";
    chartRange.textContent = rows.length ? `${rows[0].year}年 - ${rows[rows.length - 1].year}年` : "出版年なし";
    tableSummary.textContent = `${rows.length.toLocaleString("ja-JP")}年分`;

    renderChart(rows);
    renderTable(rows);
    renderYearOptions(rows);

    if (rows.length) {
      setStatus("");
      await loadYearBooks(Number(yearSelect.value), 1);
    } else {
      booksList.innerHTML = "";
      yearSelect.innerHTML = "";
      booksPageLabel.textContent = "";
      booksPager.classList.add("hidden");
      booksMeta.textContent = "年次データがないため一覧は表示できません。";
      setStatus("検索結果はありましたが、出版年ファセットに年次データがありませんでした。");
      setBooksStatus("年次データがないため一覧は表示できません。", true);
    }
  } catch (error) {
    resultPanel.classList.add("hidden");
    booksPanel.classList.add("hidden");
    setStatus(error.message, true);
  } finally {
    searchButton.disabled = false;
  }
}

applyFiltersButton.addEventListener("click", () => {
  const keyword = state.keyword || keywordInput.value.trim();
  if (!keyword) {
    return;
  }
  runSearch(keyword);
});

filtersToggle.addEventListener("click", () => {
  const isHidden = filtersPanel.classList.toggle("hidden");
  filtersToggle.setAttribute("aria-expanded", String(!isHidden));
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const keyword = keywordInput.value.trim();
  if (!keyword) {
    setStatus("キーワードを入力してください。", true);
    return;
  }
  runSearch(keyword);
});

loadBooksButton.addEventListener("click", () => {
  const year = Number(yearSelect.value);
  loadYearBooks(year, 1);
});

resultsBody.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-year]");
  if (!trigger) {
    return;
  }
  const year = Number(trigger.dataset.year);
  if (!Number.isFinite(year)) {
    return;
  }
  loadYearBooks(year, 1);
});

prevPageButton.addEventListener("click", () => {
  if (state.page > 1) {
    loadYearBooks(state.selectedYear, state.page - 1);
  }
});

nextPageButton.addEventListener("click", () => {
  if (state.page < state.totalPages) {
    loadYearBooks(state.selectedYear, state.page + 1);
  }
});
