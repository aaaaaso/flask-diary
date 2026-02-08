const CSV_PATH = "spotify_data.csv";

const rangeToggle = document.getElementById("rangeToggle");
const monthPanel = document.getElementById("monthPanel");
const monthBackdrop = document.getElementById("monthBackdrop");
const rangeValueEl = document.getElementById("rangeValue");
const monthGridEl = document.getElementById("monthGrid");
const typeMusicBtn = document.getElementById("typeMusic");
const typePodcastBtn = document.getElementById("typePodcast");
const reasonFilteredBtn = document.getElementById("reasonFiltered");
const reasonAllBtn = document.getElementById("reasonAll");
const chartEl = document.getElementById("chart");
const emptyHint = document.getElementById("emptyHint");
const rankMinutesEl = document.getElementById("rankMinutes");
const rankPlaysEl = document.getElementById("rankPlays");
const rankUniqueEl = document.getElementById("rankUnique");
const rankUniqueLabelEl = document.getElementById("rankUniqueLabel");
const pagerMinutesEl = document.getElementById("pagerMinutes");
const pagerPlaysEl = document.getElementById("pagerPlays");
const pagerUniqueEl = document.getElementById("pagerUnique");
const scatterEl = document.getElementById("scatter");
const scatterSubEl = document.getElementById("scatterSub");
const artistSearchEl = document.getElementById("artistSearch");
const artistResultsEl = document.getElementById("artistResults");
const artistLegendEl = document.getElementById("artistLegend");
const artistChartEl = document.getElementById("artistChart");
const artistTopToggle = document.getElementById("artistTopToggle");
let scatterTooltip = null;

let rawData = [];
let dataRange = { min: null, max: null };
let selectedStart = null;
let selectedEnd = null;
let selectedType = "music";
let useReasonFilter = true;
const rankState = {
  minutes: { page: 1, totalPages: 1, items: [] },
  plays: { page: 1, totalPages: 1, items: [] },
  unique: { page: 1, totalPages: 1, items: [] },
};
let artistList = [];
let selectedArtists = new Set();
let topArtistSet = new Set();

function toDateOnly(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = splitCsvLine(lines[0]);
  const idx = {
    ts: header.indexOf("ts"),
    ms: header.indexOf("ms_played"),
    type: header.indexOf("content_type"),
    artist: header.indexOf("artist_name"),
    reasonStart: header.indexOf("reason_start"),
    track: header.indexOf("track_name"),
  };
  if (idx.ts === -1 || idx.ms === -1 || idx.type === -1 || idx.artist === -1 || idx.track === -1) return [];

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const tsRaw = String(cols[idx.ts] || "").trim();
    if (!tsRaw) continue;
    const tsNormalized = tsRaw.includes("T") ? tsRaw : tsRaw.replace(" ", "T");
    const ts = new Date(tsNormalized);
    if (Number.isNaN(ts.getTime())) continue;
    const ms = Number(cols[idx.ms] || 0);
    const rawType = String(cols[idx.type] || "").trim().toLowerCase();
    const type = rawType === "episode" ? "podcast" : rawType;
    if (type !== "music" && type !== "podcast") continue;
    const artist = String(cols[idx.artist] || "").trim();
    const reasonStart = String(cols[idx.reasonStart] || "").trim().toLowerCase();
    const track = String(cols[idx.track] || "").trim();
    items.push({ ts, ms, type, artist, reasonStart, track });
  }
  return items;
}

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function getRange(data) {
  let min = null;
  let max = null;
  for (const d of data) {
    if (!min || d.ts < min) min = d.ts;
    if (!max || d.ts > max) max = d.ts;
  }
  return { min, max };
}

function monthKey(d) {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function monthSequence(startDate, endDate) {
  const months = [];
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1));
  while (cursor <= end) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function monthToDateStart(monthKey) {
  return new Date(`${monthKey}-01T00:00:00Z`);
}

function monthToDateEnd(monthKey) {
  const base = new Date(`${monthKey}-01T00:00:00Z`);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0, 23, 59, 59));
}

function aggregateByMonth(data, startDate, endDate) {
  const byMonth = new Map();
  let totalMusic = 0;
  let totalPodcast = 0;

  for (const item of data) {
    if (item.ts < startDate || item.ts > endDate) continue;
    const key = monthKey(item.ts);
    if (!byMonth.has(key)) {
      byMonth.set(key, { music: 0, podcast: 0 });
    }
    const bucket = byMonth.get(key);
    bucket[item.type] += item.ms;

    if (item.type === "music") totalMusic += item.ms;
    if (item.type === "podcast") totalPodcast += item.ms;
  }

  const labels = monthSequence(startDate, endDate);
  const music = labels.map((label) => (byMonth.get(label)?.music || 0) / 60000);
  const podcast = labels.map((label) => (byMonth.get(label)?.podcast || 0) / 60000);

  return {
    labels,
    music,
    podcast,
    totalMusic: totalMusic / 60000,
    totalPodcast: totalPodcast / 60000,
  };
}

function renderChart({ labels, music, podcast }) {
  if (labels.length === 0) {
    chartEl.innerHTML = "";
    emptyHint.style.display = "block";
    return;
  }
  emptyHint.style.display = "none";

  const rect = chartEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 0));
  const height = Math.max(260, Math.floor(rect.height || 0));
  const padding = { top: 20, right: 20, bottom: 48, left: 52 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const rawMax = Math.max(1, ...music, ...podcast);
  const desiredTicks = 5;
  const step = niceStep(rawMax / desiredTicks);
  const maxVal = Math.max(step, Math.ceil(rawMax / step) * step);
  const xStep = labels.length > 1 ? innerW / (labels.length - 1) : 0;

  const yScale = (v) => padding.top + innerH - (v / maxVal) * innerH;
  const xScale = (i) => padding.left + i * xStep;

  const pathFor = (arr) => {
    if (arr.length === 0) return "";
    return arr
      .map((v, i) => `${i === 0 ? "M" : "L"}${xScale(i)} ${yScale(v)}`)
      .join(" ");
  };

  const areaFor = (arr) => {
    if (arr.length === 0) return "";
    const top = pathFor(arr);
    const lastX = xScale(arr.length - 1);
    const firstX = xScale(0);
    const baseY = padding.top + innerH;
    return `${top} L${lastX} ${baseY} L${firstX} ${baseY} Z`;
  };

  const gridLines = Math.round(maxVal / step);
  const grid = Array.from({ length: gridLines + 1 }, (_, i) => {
    const y = padding.top + (innerH / gridLines) * i;
    const value = Math.round(maxVal - step * i);
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--grid)" />
      <text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" class="legend">${formatNumber(value)}</text>`;
  }).join("");

  const maxLabels = Math.max(1, Math.floor(innerW / 60));
  const labelStep = Math.max(1, Math.ceil(labels.length / maxLabels));
  const xLabels = labels
    .map((label, i) => {
      if (i % labelStep !== 0) return "";
      const x = xScale(i);
      const y = height - 20;
      return `<text x="${x}" y="${y}" text-anchor="middle" class="legend">${label}</text>`;
    })
    .join("");

  const legendY = height - 6;
  const legendX = width / 2 - 70;
  const svg = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" aria-label="Listening chart">
      ${grid}
      <path d="${areaFor(podcast)}" fill="rgba(156,156,156,0.18)" stroke="none" />
      <path d="${areaFor(music)}" fill="rgba(75,75,75,0.18)" stroke="none" />
      <path d="${pathFor(music)}" fill="none" stroke="var(--accent-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <path d="${pathFor(podcast)}" fill="none" stroke="var(--accent-2)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      ${xLabels}
      <text x="${padding.left}" y="${padding.top - 6}" class="legend">分</text>
      <rect x="${legendX}" y="${legendY}" width="16" height="3" fill="var(--accent-1)" />
      <text x="${legendX + 24}" y="${legendY + 4}" class="legend">music</text>
      <rect x="${legendX + 90}" y="${legendY}" width="16" height="3" fill="var(--accent-2)" />
      <text x="${legendX + 114}" y="${legendY + 4}" class="legend">podcast</text>
    </svg>
  `;

  chartEl.innerHTML = svg;
}

function computeArtistRanks(data, startDate, endDate) {
  const minutes = new Map();
  const plays = new Map();
  const uniqueTracks = new Map();
  const playReasons = new Set(["playbtn", "clickrow"]);
  const minPlayMs = 10000;

  for (const item of data) {
    if (item.ts < startDate || item.ts > endDate) continue;
    if (selectedType && item.type !== selectedType) continue;
    if (useReasonFilter && !playReasons.has(item.reasonStart)) continue;
    const artist = item.artist || "Unknown";
    minutes.set(artist, (minutes.get(artist) || 0) + item.ms);
    if (item.ms >= minPlayMs) {
      plays.set(artist, (plays.get(artist) || 0) + 1);
      if (!uniqueTracks.has(artist)) uniqueTracks.set(artist, new Set());
      if (item.track) uniqueTracks.get(artist).add(item.track);
    }
  }

  const topMinutes = Array.from(minutes.entries())
    .map(([name, ms]) => ({ name, value: ms / 60000 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 100);

  const topPlays = Array.from(plays.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 100);

  const topUnique = Array.from(uniqueTracks.entries())
    .map(([name, set]) => ({ name, value: set.size }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 100);

  return { topMinutes, topPlays, topUnique, playsMap: plays, uniqueMap: uniqueTracks };
}

function renderRank(targetEl, items, page, pagerEl, formatFn) {
  if (!items.length) {
    targetEl.innerHTML = "<div class=\"empty\">データがありません</div>";
    pagerEl.textContent = "0/0";
    const block = targetEl.closest(".rank-block");
    if (block) {
      const buttons = block.querySelectorAll(".pager-btn");
      buttons.forEach((btn) => (btn.disabled = true));
    }
    return;
  }
  const start = (page - 1) * 10;
  const pageItems = items.slice(start, start + 10);
  const max = Math.max(1, ...items.map((i) => i.value));
  const totalPages = Math.max(1, Math.ceil(items.length / 10));
  pagerEl.textContent = `${page}/${totalPages}`;
  const block = targetEl.closest(".rank-block");
  if (block) {
    const buttons = block.querySelectorAll(".pager-btn");
    buttons.forEach((btn) => {
      const dir = Number(btn.dataset.dir || 0);
      btn.disabled = (dir < 0 && page <= 1) || (dir > 0 && page >= totalPages);
    });
  }
  targetEl.innerHTML = pageItems
    .map((item) => {
      const width = Math.max(6, Math.round((item.value / max) * 100));
      return `
        <div class="rank-row">
          <div class="rank-name">${escapeHtml(item.name)}</div>
          <div class="rank-bar"><div class="rank-bar-fill" style="width:${width}%"></div></div>
          <div class="rank-value">${formatFn(item.value)}</div>
        </div>
      `;
    })
    .join("");
}

function renderScatter(ranks) {
  const items = [];
  const topPlaysSet = new Set(ranks.topPlays.slice(0, 20).map((d) => d.name));
  const topUniqueSet = new Set(ranks.topUnique.slice(0, 20).map((d) => d.name));
  const union = new Set([...topPlaysSet, ...topUniqueSet]);

  for (const name of union) {
    const plays = ranks.playsMap.get(name) || 0;
    const unique = ranks.uniqueMap.get(name)?.size || 0;
    items.push({ name, plays, unique });
  }

  if (!items.length) {
    scatterEl.innerHTML = "<div class=\"empty\">データがありません</div>";
    return;
  }

  const rect = scatterEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 0));
  const height = Math.max(260, Math.floor(rect.height || 0));
  const padding = { top: 20, right: 20, bottom: 48, left: 60 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const maxX = Math.max(1, ...items.map((i) => i.unique));
  const maxY = Math.max(1, ...items.map((i) => i.plays));
  const xStep = niceStep(maxX / 4);
  const yStep = niceStep(maxY / 4);
  const xMax = Math.ceil(maxX / xStep) * xStep;
  const yMax = Math.ceil(maxY / yStep) * yStep;

  const xScale = (v) => padding.left + (v / xMax) * innerW;
  const yScale = (v) => padding.top + innerH - (v / yMax) * innerH;

  const gridY = Array.from({ length: Math.round(yMax / yStep) + 1 }, (_, i) => {
    const y = padding.top + (innerH / (yMax / yStep)) * i;
    const value = Math.round(yMax - yStep * i);
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--grid)" />
      <text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" class="legend">${formatNumber(value)}</text>`;
  }).join("");

  const gridX = Array.from({ length: Math.round(xMax / xStep) + 1 }, (_, i) => {
    const x = padding.left + (innerW / (xMax / xStep)) * i;
    const value = Math.round(xStep * i);
    return `<line x1="${x}" y1="${padding.top}" x2="${x}" y2="${height - padding.bottom}" stroke="var(--grid)" />
      <text x="${x}" y="${height - 20}" text-anchor="middle" class="legend">${formatNumber(value)}</text>`;
  }).join("");

  const xLabel = selectedType === "podcast" ? "エピソード数" : "曲数";
  const points = items
    .map((d) => {
      const x = xScale(d.unique);
      const y = yScale(d.plays);
      return `
        <circle class="scatter-point" cx="${x}" cy="${y}" r="4" fill="var(--accent-1)" opacity="0.85"
          data-name="${escapeHtml(d.name)}" data-unique="${formatNumber(d.unique)}" data-plays="${formatNumber(d.plays)}"></circle>
      `;
    })
    .join("");

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" aria-label="Artist scatter">
      ${gridY}
      ${gridX}
      ${points}
      <text x="${padding.left}" y="${padding.top - 6}" class="legend">再生数</text>
      <text x="${width / 2}" y="${height - 6}" text-anchor="middle" class="legend">${xLabel}</text>
    </svg>
  `;

  scatterEl.innerHTML = svg;
  scatterTooltip = document.createElement("div");
  scatterTooltip.className = "scatter-tooltip";
  scatterEl.appendChild(scatterTooltip);
  scatterSubEl.textContent = selectedType === "podcast"
    ? "エピソード数 or 再生数 上位20アーティスト"
    : "曲数 or 再生数 上位20アーティスト";
  const pointsEls = scatterEl.querySelectorAll(".scatter-point");
  pointsEls.forEach((pt) => {
    pt.addEventListener("mouseenter", (e) => {
      const name = pt.dataset.name || "";
      const unique = pt.dataset.unique || "0";
      const plays = pt.dataset.plays || "0";
      scatterTooltip.textContent = `${name} | ${xLabel}:${unique} / 再生数:${plays}`;
      scatterTooltip.classList.add("show");
    });
    pt.addEventListener("mouseleave", () => {
      scatterTooltip.classList.remove("show");
    });
    pt.addEventListener("mousemove", (e) => {
      const rect = scatterEl.getBoundingClientRect();
      const x = e.clientX - rect.left + 10;
      const y = e.clientY - rect.top - 10;
      scatterTooltip.style.left = `${x}px`;
      scatterTooltip.style.top = `${y}px`;
    });
  });
}

function buildArtistList(data) {
  const set = new Set();
  for (const item of data) {
    if (!item.artist) continue;
    set.add(item.artist);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function renderArtistResults(query) {
  const q = query.trim().toLowerCase();
  const results = q
    ? artistList.filter((name) => name.toLowerCase().includes(q)).slice(0, 60)
    : [];

  artistResultsEl.innerHTML = results
    .map((name) => {
      const checked = selectedArtists.has(name) ? "checked" : "";
      const encoded = encodeURIComponent(name);
      return `
        <label class="artist-item">
          <input type="checkbox" data-artist="${encoded}" ${checked} />
          <span>${escapeHtml(name)}</span>
        </label>
      `;
    })
    .join("");
}

function aggregateArtistTrends(data, startDate, endDate, artists) {
  const labels = monthSequence(startDate, endDate);
  const indexByLabel = new Map(labels.map((label, i) => [label, i]));
  const series = new Map();
  for (const name of artists) {
    series.set(name, new Array(labels.length).fill(0));
  }
  for (const item of data) {
    if (item.ts < startDate || item.ts > endDate) continue;
    if (!artists.has(item.artist)) continue;
    const idx = indexByLabel.get(monthKey(item.ts));
    if (idx === undefined) continue;
    const arr = series.get(item.artist);
    if (arr) arr[idx] += item.ms / 60000;
  }
  return { labels, series };
}

function topArtistsByMinutes(data, startDate, endDate, limit = 10) {
  const totals = new Map();
  for (const item of data) {
    if (item.ts < startDate || item.ts > endDate) continue;
    if (item.type !== "music") continue;
    const name = item.artist || "Unknown";
    totals.set(name, (totals.get(name) || 0) + item.ms);
  }
  return Array.from(totals.entries())
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map((d) => d.name);
}

function updateTopArtistSet(start, end) {
  const top = topArtistsByMinutes(rawData, start, end, 10);
  topArtistSet = new Set(top);
  return top;
}

function syncTopToggleState() {
  if (!artistTopToggle) return;
  if (topArtistSet.size === 0) {
    artistTopToggle.checked = false;
    return;
  }
  let allMatch = selectedArtists.size === topArtistSet.size;
  if (allMatch) {
    for (const name of topArtistSet) {
      if (!selectedArtists.has(name)) {
        allMatch = false;
        break;
      }
    }
  }
  artistTopToggle.checked = allMatch;
}

function renderArtistChart(trend) {
  if (!trend || trend.labels.length === 0 || trend.series.size === 0) {
    artistChartEl.innerHTML = "<div class=\"empty\">アーティストを選択してください</div>";
    artistLegendEl.innerHTML = "";
    return;
  }

  const rect = artistChartEl.getBoundingClientRect();
  const width = Math.max(320, Math.floor(rect.width || 0));
  const height = Math.max(260, Math.floor(rect.height || 0));
  const padding = { top: 20, right: 20, bottom: 48, left: 52 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const labels = trend.labels;
  const xStep = labels.length > 1 ? innerW / (labels.length - 1) : 0;
  const xScale = (i) => padding.left + i * xStep;

  let maxVal = 1;
  trend.series.forEach((arr) => {
    for (const v of arr) maxVal = Math.max(maxVal, v);
  });
  const step = niceStep(maxVal / 5);
  maxVal = Math.max(step, Math.ceil(maxVal / step) * step);
  const yScale = (v) => padding.top + innerH - (v / maxVal) * innerH;

  const gridLines = Math.round(maxVal / step);
  const grid = Array.from({ length: gridLines + 1 }, (_, i) => {
    const y = padding.top + (innerH / gridLines) * i;
    const value = Math.round(maxVal - step * i);
    return `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--grid)" />
      <text x="${padding.left - 10}" y="${y + 4}" text-anchor="end" class="legend">${formatNumber(value)}</text>`;
  }).join("");

  const maxLabels = Math.max(1, Math.floor(innerW / 60));
  const labelStep = Math.max(1, Math.ceil(labels.length / maxLabels));
  const xLabels = labels
    .map((label, i) => {
      if (i % labelStep !== 0) return "";
      const x = xScale(i);
      const y = height - 20;
      return `<text x="${x}" y="${y}" text-anchor="middle" class="legend">${label}</text>`;
    })
    .join("");

  const palette = ["#5a7fa3", "#a57373", "#7aa37a", "#8c7fb4", "#b38a5a", "#5a9aa0", "#b28aa6", "#7a6b5b"];
  let idx = 0;
  const legend = [];
  const lines = Array.from(trend.series.entries()).map(([name, arr]) => {
    const color = palette[idx++ % palette.length];
    legend.push({ name, color });
    const d = arr.map((v, i) => `${i === 0 ? "M" : "L"}${xScale(i)} ${yScale(v)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <title>${escapeHtml(name)}</title>
    </path>`;
  }).join("");

  const svg = `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" aria-label="Artist trend">
      ${grid}
      ${lines}
      ${xLabels}
      <text x="${padding.left}" y="${padding.top - 6}" class="legend">分</text>
    </svg>
  `;
  artistChartEl.innerHTML = svg;
  artistLegendEl.innerHTML = legend
    .map((item) => {
      return `
        <button class="artist-legend-item" type="button" data-artist="${encodeURIComponent(item.name)}">
          <span class="artist-legend-swatch" style="background:${item.color}"></span>
          <span>${escapeHtml(item.name)}</span>
        </button>
      `;
    })
    .join("");
}

function niceStep(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const candidates = [1, 2, 5, 10].map((n) => n * base);
  for (const c of candidates) {
    if (c >= value) return c;
  }
  return 10 * base;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString("en-US");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applyFilter() {
  if (!selectedStart) return;
  const start = monthToDateStart(selectedStart);
  const end = monthToDateEnd(selectedEnd || selectedStart);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return;

  const top = updateTopArtistSet(start, end);
  if (artistTopToggle && artistTopToggle.checked) {
    selectedArtists = new Set(top);
  }

  const result = aggregateByMonth(rawData, start, end);
  renderChart(result);
  const ranks = computeArtistRanks(rawData, start, end);
  rankState.minutes.items = ranks.topMinutes;
  rankState.plays.items = ranks.topPlays;
  rankState.unique.items = ranks.topUnique;
  rankState.minutes.totalPages = Math.max(1, Math.ceil(ranks.topMinutes.length / 10));
  rankState.plays.totalPages = Math.max(1, Math.ceil(ranks.topPlays.length / 10));
  rankState.unique.totalPages = Math.max(1, Math.ceil(ranks.topUnique.length / 10));
  rankState.minutes.page = Math.min(rankState.minutes.page, rankState.minutes.totalPages);
  rankState.plays.page = Math.min(rankState.plays.page, rankState.plays.totalPages);
  rankState.unique.page = Math.min(rankState.unique.page, rankState.unique.totalPages);

  renderRank(rankMinutesEl, rankState.minutes.items, rankState.minutes.page, pagerMinutesEl, (v) => `${formatNumber(v)} 分`);
  renderRank(rankPlaysEl, rankState.plays.items, rankState.plays.page, pagerPlaysEl, (v) => `${formatNumber(v)} 回`);
  if (selectedType === "podcast") {
    rankUniqueLabelEl.textContent = "エピソード数";
    renderRank(rankUniqueEl, rankState.unique.items, rankState.unique.page, pagerUniqueEl, (v) => `${formatNumber(v)} episodes`);
  } else {
    rankUniqueLabelEl.textContent = "曲数";
    renderRank(rankUniqueEl, rankState.unique.items, rankState.unique.page, pagerUniqueEl, (v) => `${formatNumber(v)} 曲`);
  }

  renderScatter(ranks);

  const trends = aggregateArtistTrends(rawData, start, end, selectedArtists);
  renderArtistChart(trends);
  syncTopToggleState();
}

function setType(type) {
  selectedType = type;
  typeMusicBtn.classList.toggle("active", type === "music");
  typePodcastBtn.classList.toggle("active", type === "podcast");
  applyFilter();
}

function setReasonFilter(useFilter) {
  useReasonFilter = useFilter;
  reasonFilteredBtn.classList.toggle("active", useFilter);
  reasonAllBtn.classList.toggle("active", !useFilter);
  applyFilter();
}

function renderMonthPicker(months) {
  monthGridEl.innerHTML = "";
  const byYear = new Map();
  for (const m of months) {
    const year = m.slice(0, 4);
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year).push(m);
  }

  for (const [year, yearMonths] of byYear.entries()) {
    const block = document.createElement("div");
    block.className = "year-block";
    const label = document.createElement("div");
    label.className = "year-label";
    label.textContent = year;
    const monthsWrap = document.createElement("div");
    monthsWrap.className = "months";

    for (const m of yearMonths) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "month-btn";
      btn.dataset.month = m;
      btn.textContent = m.slice(5);
      btn.addEventListener("click", () => handleMonthClick(m));
      monthsWrap.appendChild(btn);
    }

    block.appendChild(label);
    block.appendChild(monthsWrap);
    monthGridEl.appendChild(block);
  }

  updateMonthStyles();
}

function handleMonthClick(monthKey) {
  if (!selectedStart || (selectedStart && selectedEnd)) {
    selectedStart = monthKey;
    selectedEnd = null;
  } else if (monthKey < selectedStart) {
    selectedEnd = selectedStart;
    selectedStart = monthKey;
  } else {
    selectedEnd = monthKey;
  }

  updateMonthStyles();
  updateRangeLabel();
  if (selectedEnd || selectedStart) applyFilter();
}

function updateMonthStyles() {
  const buttons = monthGridEl.querySelectorAll(".month-btn");
  buttons.forEach((btn) => {
    const m = btn.dataset.month;
    btn.classList.remove("start", "end", "in-range");
    if (selectedStart && m === selectedStart) btn.classList.add("start");
    if (selectedEnd && m === selectedEnd) btn.classList.add("end");
    if (selectedStart && selectedEnd && m > selectedStart && m < selectedEnd) {
      btn.classList.add("in-range");
    }
  });
}

function updateRangeLabel() {
  if (!selectedStart) {
    rangeValueEl.textContent = "-";
    return;
  }
  const end = selectedEnd || selectedStart;
  rangeValueEl.textContent = `${selectedStart} 〜 ${end}`;
}

function openMonthPanel() {
  const rect = rangeToggle.getBoundingClientRect();
  monthPanel.classList.add("open");
  monthPanel.setAttribute("aria-hidden", "false");
  monthBackdrop.classList.add("open");
  const panelWidth = monthPanel.offsetWidth || 0;
  const rightAlignedLeft = rect.right + window.scrollX - panelWidth;
  const minLeft = 16 + window.scrollX;
  const maxLeft = window.innerWidth + window.scrollX - panelWidth - 16;
  monthPanel.style.top = `${rect.bottom + 10 + window.scrollY}px`;
  monthPanel.style.left = `${Math.max(minLeft, Math.min(rightAlignedLeft, maxLeft))}px`;
  requestAnimationFrame(() => {
    monthGridEl.scrollTop = monthGridEl.scrollHeight;
  });
}

function closeMonthPanel() {
  monthPanel.classList.remove("open");
  monthPanel.setAttribute("aria-hidden", "true");
  monthBackdrop.classList.remove("open");
}

async function init() {
  const res = await fetch(CSV_PATH, { cache: "no-store" });
  const text = await res.text();
  rawData = parseCsv(text);

  const { min, max } = getRange(rawData);
  if (!min || !max) {
    renderChart({ labels: [], music: [], podcast: [] });
    return;
  }
  dataRange = { min, max };
  const maxMonth = new Date(Date.UTC(max.getUTCFullYear(), max.getUTCMonth(), 1));
  const defaultEnd = new Date(Date.UTC(maxMonth.getUTCFullYear(), maxMonth.getUTCMonth() - 1, 1));
  const defaultStart = new Date(Date.UTC(defaultEnd.getUTCFullYear(), defaultEnd.getUTCMonth() - 12, 1));
  selectedStart = toDateOnly(defaultStart < min ? min : defaultStart);
  selectedEnd = toDateOnly(defaultEnd);
  artistList = buildArtistList(rawData);
  renderArtistResults("");
  renderMonthPicker(monthSequence(min, max));
  updateRangeLabel();
  applyFilter();
}

rangeToggle.addEventListener("click", () => {
  if (monthPanel.classList.contains("open")) {
    closeMonthPanel();
  } else {
    openMonthPanel();
  }
});
monthBackdrop.addEventListener("click", closeMonthPanel);
window.addEventListener("resize", () => {
  if (monthPanel.classList.contains("open")) openMonthPanel();
});
typeMusicBtn.addEventListener("click", () => setType("music"));
typePodcastBtn.addEventListener("click", () => setType("podcast"));
reasonFilteredBtn.addEventListener("click", () => setReasonFilter(true));
reasonAllBtn.addEventListener("click", () => setReasonFilter(false));

document.querySelectorAll(".pager-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const target = btn.dataset.target;
    const dir = Number(btn.dataset.dir || 0);
    if (!rankState[target]) return;
    const state = rankState[target];
    const next = Math.min(state.totalPages, Math.max(1, state.page + dir));
    if (next === state.page) return;
    state.page = next;
    const formatFn = target === "minutes"
      ? (v) => `${formatNumber(v)} 分`
      : target === "plays"
        ? (v) => `${formatNumber(v)} 回`
        : selectedType === "podcast"
          ? (v) => `${formatNumber(v)} episodes`
          : (v) => `${formatNumber(v)} 曲`;

    const targetEl = target === "minutes" ? rankMinutesEl : target === "plays" ? rankPlaysEl : rankUniqueEl;
    const pagerEl = target === "minutes" ? pagerMinutesEl : target === "plays" ? pagerPlaysEl : pagerUniqueEl;
    renderRank(targetEl, state.items, state.page, pagerEl, formatFn);
  });
});

artistSearchEl.addEventListener("input", () => {
  renderArtistResults(artistSearchEl.value);
});

artistSearchEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = artistSearchEl.value.trim().toLowerCase();
  if (!q) return;
  const results = artistList.filter((name) => name.toLowerCase().includes(q));
  if (results.length === 1) {
    const only = results[0];
    selectedArtists.add(only);
    renderArtistResults(artistSearchEl.value);
    applyFilter();
  }
});

artistResultsEl.addEventListener("change", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLInputElement)) return;
  const name = target.dataset.artist ? decodeURIComponent(target.dataset.artist) : "";
  if (!name) return;
  if (target.checked) selectedArtists.add(name);
  else {
    selectedArtists.delete(name);
    if (artistTopToggle && artistTopToggle.checked) {
      artistTopToggle.checked = false;
    }
  }
  applyFilter();
});

artistLegendEl.addEventListener("click", (e) => {
  const target = e.target;
  const btn = target.closest(".artist-legend-item");
  if (!btn) return;
  const name = btn.dataset.artist ? decodeURIComponent(btn.dataset.artist) : "";
  if (!name) return;
  selectedArtists.delete(name);
  if (artistTopToggle && artistTopToggle.checked) {
    artistTopToggle.checked = false;
  }
  renderArtistResults(artistSearchEl.value);
  applyFilter();
});

artistTopToggle.addEventListener("change", () => {
  if (!selectedStart) return;
  if (!artistTopToggle.checked) {
    selectedArtists.clear();
    renderArtistResults(artistSearchEl.value);
    applyFilter();
    return;
  }
  const start = monthToDateStart(selectedStart);
  const end = monthToDateEnd(selectedEnd || selectedStart);
  const top = updateTopArtistSet(start, end);
  selectedArtists = new Set(top);
  renderArtistResults(artistSearchEl.value);
  applyFilter();
});

init().catch((err) => {
  console.error("init error", err);
});
