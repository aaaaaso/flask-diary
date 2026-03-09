const boardCanvas = document.getElementById("board");
const boardCtx = boardCanvas.getContext("2d");
const nextCanvas = document.getElementById("next");
const nextCtx = nextCanvas.getContext("2d");
const holdCanvas = document.getElementById("hold");
const holdCtx = holdCanvas.getContext("2d");
const scoreEl = document.getElementById("score");
const linesEl = document.getElementById("lines");
const levelEl = document.getElementById("level");
const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");
const pauseBtn = document.getElementById("pauseBtn");
const overlayEl = document.getElementById("overlay");
const appEl = document.querySelector(".app");
const boardWrapEl = document.querySelector(".board-wrap");
const touchPanelEl = document.getElementById("touchPanel");
const bgmButtons = Array.from(document.querySelectorAll(".bgm-btn"));
const mobileGameButtons = Array.from(document.querySelectorAll(".mobile-game-btn"));
const bgm = document.getElementById("bgm");
const bgmAlt = document.getElementById("bgmAlt");
const sfxDrop = document.getElementById("sfxDrop");
const sfxRotate = document.getElementById("sfxRotate");
const sfxMove = document.getElementById("sfxMove");
const sfxHold = document.getElementById("sfxHold");
const sfx2Dan = document.getElementById("sfx2dan");
const sfx2DanClear = document.getElementById("sfx2danClear");
const sfxClear = document.getElementById("sfxClear");
const sfxClearBig = document.getElementById("sfxClearBig");
const sfxGameOver = document.getElementById("sfxGameOver");
const sfxBell = document.getElementById("sfxBell");
const RANKING_API = "api/ranking";

const COLS = 10;
const ROWS = 22;
const CELL = 32;
const NEXT_CELL = 26;
const TICK_MIN = 90;
const TICK_BASE = 800;
const SOFT_DROP_SCORE = 1;
const HARD_DROP_SCORE = 2;
const LINE_CLEAR_SCORE = [0, 100, 300, 500, 800, 1200, 1700];
const T_SPIN_SCORE = [400, 800, 1200, 1600];
const COLORS = [
  "#d6aca4",
  "#c6a4d8",
  "#8fb7d8",
  "#98c9af",
  "#debd8f",
  "#d79eb8",
  "#a4becf",
  "#b7c99d",
  "#cab6a3",
  "#8f9f92",
  "#bea7cf",
  "#d1b79c",
];

let board = createBoard();
let shapesBySize = {
  4: [],
  5: [],
  6: [],
  7: [],
  8: [],
  9: [],
  10: [],
};
let bagBySize = {
  4: [],
  5: [],
  6: [],
  7: [],
  8: [],
  9: [],
  10: [],
};
let queue = [];
let currentPiece = null;
let score = 0;
let lines = 0;
let level = 1;
let lastTime = 0;
let fallAccumulator = 0;
let running = false;
let paused = false;
let gameOver = false;
let musicReady = false;
let holdShape = null;
let holdUsedInTurn = false;
let forcedFourRemaining = 0;
let bgmWasPlayingBeforePause = false;
let sfxFlushScheduled = false;
let pendingSfxKey = null;
let pendingSfxPriority = -1;
let lastMoveWasRotation = false;
let specialPieceQueued = false;
let specialPieceUsed = false;
let groundedMs = 0;
let tSpinFxTimer = null;
let activeBgm = bgm;
let standbyBgm = bgmAlt;
let bgmFadeRaf = null;
let sfxReady = false;
let clearPromptActive = false;
let gameClearReached = false;
let shouldResumeMusicAfterClear = false;
let rankingTop = [];
let rankInPromptActive = false;
let rankInPendingAction = null;
let rankInSubmitting = false;

const SFX_PRIORITY = {
  move: 1,
  hold: 1,
  rot: 2,
  drop: 3,
  clear: 4,
  two_line: 4,
  clear_big: 5,
  special_clear: 6,
  gameover: 7,
};

const SFX_AUDIO = {
  move: sfxMove,
  hold: sfxHold,
  rot: sfxRotate,
  drop: sfxDrop,
  clear: sfxClear,
  two_line: sfx2Dan,
  clear_big: sfxClearBig,
  special_clear: sfx2DanClear,
  gameover: sfxGameOver,
};

function primeSfxIfNeeded() {
  if (sfxReady) return;
  sfxReady = true;
  const primeTargets = [sfxMove, sfxRotate].filter(Boolean);
  for (const audioEl of primeTargets) {
    const prevVolume = audioEl.volume;
    audioEl.currentTime = 0;
    audioEl.volume = 0;
    audioEl.play()
      .then(() => {
        audioEl.pause();
        audioEl.currentTime = 0;
        audioEl.volume = prevVolume;
      })
      .catch(() => {
        audioEl.volume = prevVolume;
      });
  }
}

const SPECIAL_BAR_SHAPE = {
  id: "special-2x10",
  size: 20,
  color: "#d9d1a8",
  isTPiece: false,
  isSpecialBar: true,
  rotations: [
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, 0],
      [7, 0],
      [8, 0],
      [9, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
    ],
  ],
};

function createBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function normalize(cells) {
  let minX = Infinity;
  let minY = Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  return cells
    .map(([x, y]) => [x - minX, y - minY])
    .sort((a, b) => (a[1] - b[1] || a[0] - b[0]));
}

function encode(cells) {
  return cells.map(([x, y]) => `${x},${y}`).join(";");
}

function decode(key) {
  return key.split(";").map((point) => point.split(",").map(Number));
}

function rotateCW(cells) {
  const rotated = cells.map(([x, y]) => [y, -x]);
  return normalize(rotated);
}

function rotateCCW(cells) {
  const rotated = cells.map(([x, y]) => [-y, x]);
  return normalize(rotated);
}

function uniqueRotations(baseCells) {
  const seen = new Set();
  const rotations = [];
  let cells = normalize(baseCells);
  for (let i = 0; i < 4; i += 1) {
    const key = encode(cells);
    if (!seen.has(key)) {
      seen.add(key);
      rotations.push(cells);
    }
    cells = rotateCW(cells);
  }
  return rotations;
}

function getNeighbors([x, y]) {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
}

function canonicalRotationKey(cells) {
  let rotated = normalize(cells);
  let best = encode(rotated);
  for (let i = 0; i < 3; i += 1) {
    rotated = rotateCW(rotated);
    const key = encode(rotated);
    if (key < best) best = key;
  }
  return best;
}

const T_PIECE_CANONICAL_KEY = canonicalRotationKey([
  [0, 0],
  [1, 0],
  [2, 0],
  [1, 1],
]);

function generateAllPolyominoes(size) {
  let current = new Set(["0,0"]);
  for (let n = 2; n <= size; n += 1) {
    const next = new Map();
    for (const shapeKey of current) {
      const cells = decode(shapeKey);
      const occupied = new Set(cells.map(([x, y]) => `${x},${y}`));
      for (const cell of cells) {
        for (const [nx, ny] of getNeighbors(cell)) {
          const nKey = `${nx},${ny}`;
          if (occupied.has(nKey)) continue;
          const expanded = normalize([...cells, [nx, ny]]);
          const canKey = canonicalRotationKey(expanded);
          if (!next.has(canKey)) {
            next.set(canKey, expanded);
          }
        }
      }
    }
    current = new Set(next.keys());
  }
  return [...current].map((key, idx) => {
    const base = decode(key);
    const isTPiece = size === 4 && canonicalRotationKey(base) === T_PIECE_CANONICAL_KEY;
    return {
      id: `${size}-${idx}`,
      size,
      color: COLORS[idx % COLORS.length],
      isTPiece,
      rotations: uniqueRotations(base),
    };
  });
}

function buildShapeSets() {
  shapesBySize[4] = generateAllPolyominoes(4);
  shapesBySize[5] = generateAllPolyominoes(5);
  shapesBySize[6] = generateAllPolyominoes(6);
  shapesBySize[7] = generateAllPolyominoes(7);
  shapesBySize[8] = generateAllPolyominoes(8);
  shapesBySize[9] = generateAllPolyominoes(9);
  shapesBySize[10] = generateAllPolyominoes(10);
  refillBag(4);
  refillBag(5);
  refillBag(6);
  refillBag(7);
  refillBag(8);
  refillBag(9);
  refillBag(10);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function refillBag(size) {
  bagBySize[size] = shuffle([...shapesBySize[size]]);
}

function drawTextOverlay(text) {
  overlayEl.classList.remove("hidden");
  overlayEl.classList.remove("overlay-game-clear");
  overlayEl.classList.remove("overlay-rank-in");
  overlayEl.textContent = text;
}

function rankingLine(index) {
  const row = rankingTop[index];
  if (!row) return `${index + 1}. ---- / ---`;
  return `${index + 1}. ${row.score} / ${row.name}`;
}

function drawStartOverlay() {
  overlayEl.classList.remove("hidden");
  overlayEl.classList.remove("overlay-game-clear");
  overlayEl.classList.remove("overlay-rank-in");
  overlayEl.innerHTML = `
    <div class="overlay-start">
      <div class="overlay-start-title">GAME START</div>
      <div class="overlay-start-note">30段消したらクリア!</div>
      <div class="overlay-ranking">
        <div class="overlay-ranking-title">RANKING</div>
        <div class="overlay-ranking-line">${rankingLine(0)}</div>
        <div class="overlay-ranking-line">${rankingLine(1)}</div>
        <div class="overlay-ranking-line">${rankingLine(2)}</div>
      </div>
    </div>
  `;
}

function hideOverlay() {
  if (rankInPromptActive) {
    // Fallback: if rank-in prompt is ever closed unexpectedly, record as NONAME.
    saveRankingEntry("NONAME", score).then(() => fetchRankingTop3()).then((rows) => {
      rankingTop = rows;
      drawStartOverlay();
    }).catch(() => {});
    rankInPromptActive = false;
    rankInPendingAction = null;
    rankInSubmitting = false;
  }
  overlayEl.classList.add("hidden");
  overlayEl.classList.remove("overlay-game-clear");
  overlayEl.classList.remove("overlay-rank-in");
  overlayEl.textContent = "";
}

async function fetchRankingTop3() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(RANKING_API, { cache: "no-store", signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.slice(0, 3).map((row) => ({
      name: String(row.name || "---"),
      score: Number(row.score) || 0,
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function saveRankingEntry(name, value) {
  try {
    const res = await fetch(RANKING_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, score: value }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    if (Array.isArray(data)) {
      rankingTop = data.slice(0, 3).map((row) => ({
        name: String(row.name || "---"),
        score: Number(row.score) || 0,
      }));
    }
    return true;
  } catch {
    return false;
  }
}

function isRankInScore(value) {
  if (value <= 0) return false;
  if (rankingTop.length < 3) return true;
  return value > rankingTop[rankingTop.length - 1].score;
}

function drawRankInOverlay() {
  overlayEl.classList.remove("hidden");
  overlayEl.classList.add("overlay-rank-in");
  overlayEl.classList.remove("overlay-game-clear");
  overlayEl.innerHTML = `
    <div class="overlay-card">
      <div class="overlay-title">RANK IN!</div>
      <div class="overlay-score">SCORE: ${score}</div>
      <div class="overlay-subtitle">nameを入力してください</div>
      <div class="overlay-rankin-form">
        <input class="overlay-input" data-rank-name maxlength="16" placeholder="name" />
        <button class="overlay-btn" data-rank-submit>OK</button>
      </div>
    </div>
  `;
  const input = overlayEl.querySelector("[data-rank-name]");
  if (input) input.focus();
}

function openRankInPrompt(nextAction) {
  rankInPromptActive = true;
  rankInPendingAction = nextAction;
  drawRankInOverlay();
}

async function submitRankIn() {
  if (!rankInPromptActive || rankInSubmitting) return;
  const input = overlayEl.querySelector("[data-rank-name]");
  const rawName = input instanceof HTMLInputElement ? input.value : "";
  const name = (rawName || "").trim().slice(0, 16) || "NONAME";
  rankInSubmitting = true;
  await saveRankingEntry(name, score);
  rankingTop = await fetchRankingTop3();
  rankInSubmitting = false;
  rankInPromptActive = false;
  rankInPendingAction = null;
  returnToStartScreen();
}

function drawGameClearOverlay() {
  overlayEl.classList.remove("hidden");
  overlayEl.classList.add("overlay-game-clear");
  overlayEl.innerHTML = `
    <div class="overlay-card">
      <div class="overlay-title">GAME CLEAR</div>
      <div class="overlay-score">SCORE: ${score}</div>
      <div class="overlay-divider"></div>
      <div class="overlay-subtitle">つづけますか？</div>
      <div class="overlay-actions">
        <button class="overlay-btn" data-clear-action="yes">YES</button>
        <button class="overlay-btn" data-clear-action="no">NO</button>
      </div>
    </div>
  `;
}

function returnToStartScreen() {
  running = false;
  paused = false;
  gameOver = false;
  clearPromptActive = false;
  gameClearReached = false;
  rankInPromptActive = false;
  rankInPendingAction = null;
  rankInSubmitting = false;
  shouldResumeMusicAfterClear = false;
  board = createBoard();
  queue = [];
  currentPiece = null;
  holdShape = null;
  holdUsedInTurn = false;
  score = 0;
  lines = 0;
  level = 1 + Math.floor(lines / 10);
  lastTime = 0;
  fallAccumulator = 0;
  groundedMs = 0;
  forcedFourRemaining = 3;
  specialPieceQueued = false;
  specialPieceUsed = false;
  lastMoveWasRotation = false;
  appEl.classList.remove("paused-view");
  pauseBtn.textContent = "Pause";
  for (const btn of mobileGameButtons) {
    if (btn.dataset.mobileAction === "pause") btn.textContent = "Pause";
  }
  drawBoard();
  drawNext();
  drawHold();
  syncStats();
  drawStartOverlay();
  fetchRankingTop3().then((rows) => {
    rankingTop = rows;
    if (!running && !gameOver && !clearPromptActive && !rankInPromptActive) {
      drawStartOverlay();
    }
  });
}

function triggerGameClear() {
  if (gameClearReached || clearPromptActive || rankInPromptActive) return;
  gameClearReached = true;
  running = false;
  paused = false;
  shouldResumeMusicAfterClear = musicReady && !activeBgm.paused;
  activeBgm.pause();
  standbyBgm.pause();
  if (sfxBell) {
    sfxBell.currentTime = 0;
    sfxBell.play().catch(() => {});
  }
  clearPromptActive = true;
  drawGameClearOverlay();
}

function resolveGameClear(shouldContinue) {
  if (!clearPromptActive) return;
  clearPromptActive = false;
  hideOverlay();
  if (shouldContinue) {
    running = true;
    lastTime = 0;
    if (shouldResumeMusicAfterClear) {
      activeBgm.play().catch(() => {});
    }
    shouldResumeMusicAfterClear = false;
    requestAnimationFrame(gameLoop);
    return;
  }
  if (isRankInScore(score)) {
    openRankInPrompt(returnToStartScreen);
    return;
  }
  shouldResumeMusicAfterClear = false;
  returnToStartScreen();
}

function pickPieceSize() {
  const aRate = Math.max(0.5, 0.8 - lines * 0.01);
  if (Math.random() < aRate) return 4;

  const bSizes = [5];
  if (lines >= 5) bSizes.push(6);
  if (lines >= 10) bSizes.push(7);
  if (lines >= 15) bSizes.push(8);
  if (lines >= 20) bSizes.push(9);
  if (lines >= 25) bSizes.push(10);
  return bSizes[Math.floor(Math.random() * bSizes.length)];
}

function pullShape(size) {
  if (bagBySize[size].length === 0) {
    refillBag(size);
  }
  return bagBySize[size].pop();
}

function createPiece(shape) {
  const rotationIndex = 0;
  const cells = shape.rotations[rotationIndex];
  const width = Math.max(...cells.map(([x]) => x)) + 1;
  const height = Math.max(...cells.map(([, y]) => y)) + 1;
  return {
    shape,
    x: Math.floor((COLS - width) / 2),
    y: -height,
    rotationIndex,
  };
}

function makeRandomPiece() {
  const size = forcedFourRemaining > 0 ? 4 : pickPieceSize();
  if (forcedFourRemaining > 0) forcedFourRemaining -= 1;
  return createPiece(pullShape(size));
}

function getPieceCells(piece, offsetX = 0, offsetY = 0, rotationDelta = 0) {
  const rotations = piece.shape.rotations;
  const idx = (piece.rotationIndex + rotationDelta + rotations.length) % rotations.length;
  return rotations[idx].map(([x, y]) => [x + piece.x + offsetX, y + piece.y + offsetY]);
}

function collides(piece, offsetX = 0, offsetY = 0, rotationDelta = 0) {
  const cells = getPieceCells(piece, offsetX, offsetY, rotationDelta);
  return cells.some(([x, y]) => {
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y < 0) return false;
    return board[y][x] !== 0;
  });
}

function mergePiece(piece) {
  for (const [x, y] of getPieceCells(piece)) {
    if (y >= 0) board[y][x] = piece.shape.color;
  }
}

function getPieceScoreMultiplier(piece) {
  const size = piece?.shape?.size ?? 4;
  const multipliers = {
    5: 1.5,
    6: 2,
    7: 2.5,
    8: 3,
    9: 3.5,
    10: 4,
  };
  return multipliers[size] || 1;
}

function clearLines() {
  let removed = 0;
  for (let y = ROWS - 1; y >= 0; y -= 1) {
    if (board[y].every((cell) => cell !== 0)) {
      board.splice(y, 1);
      board.unshift(Array(COLS).fill(0));
      removed += 1;
      y += 1;
    }
  }
  return removed;
}

function spawnPiece(resetHold = true) {
  if (queue.length < 2) queue.push(makeRandomPiece(), makeRandomPiece());
  currentPiece = queue.shift();
  if (currentPiece?.shape?.isSpecialBar) {
    specialPieceQueued = false;
    specialPieceUsed = true;
    requestSfx("two_line");
  }
  queue.push(makeRandomPiece());
  lastMoveWasRotation = false;
  groundedMs = 0;
  if (resetHold) holdUsedInTurn = false;
  if (collides(currentPiece)) {
    triggerGameOver();
  }
}

function tryMove(dx, dy, playMoveSfx = false) {
  if (!currentPiece || paused || gameOver) return false;
  if (!collides(currentPiece, dx, dy, 0)) {
    currentPiece.x += dx;
    currentPiece.y += dy;
    lastMoveWasRotation = false;
    if (dy > 0) groundedMs = 0;
    if (playMoveSfx && (dx !== 0 || dy !== 0)) requestSfx("move");
    return true;
  }
  return false;
}

function getTPieceKickTests(from, to) {
  const key = `${from}->${to}`;
  const kicks = {
    "0->1": [
      [0, 0],
      [-1, 0],
      [-1, -1],
      [0, 2],
      [-1, 2],
    ],
    "1->0": [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, -2],
      [1, -2],
    ],
    "1->2": [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, -2],
      [1, -2],
    ],
    "2->1": [
      [0, 0],
      [-1, 0],
      [-1, -1],
      [0, 2],
      [-1, 2],
    ],
    "2->3": [
      [0, 0],
      [1, 0],
      [1, -1],
      [0, 2],
      [1, 2],
    ],
    "3->2": [
      [0, 0],
      [-1, 0],
      [-1, 1],
      [0, -2],
      [-1, -2],
    ],
    "3->0": [
      [0, 0],
      [-1, 0],
      [-1, 1],
      [0, -2],
      [-1, -2],
    ],
    "0->3": [
      [0, 0],
      [1, 0],
      [1, -1],
      [0, 2],
      [1, 2],
    ],
  };
  return kicks[key] || [[0, 0]];
}

function toCellKey(x, y) {
  return `${x},${y}`;
}

function canPlaceWorldCells(cells) {
  for (const [x, y] of cells) {
    if (x < 0 || x >= COLS || y >= ROWS) return false;
    if (y < 0) continue;
    if (board[y][x] !== 0) return false;
  }
  return true;
}

function rotateWorldCellsAroundPivot(cells, pivotX, pivotY, dir) {
  return cells.map(([x, y]) => {
    const dx = x - pivotX;
    const dy = y - pivotY;
    if (dir === 1) return [pivotX + dy, pivotY - dx];
    return [pivotX - dy, pivotY + dx];
  });
}

function applyRotatedWorldCells(piece, toRotation, worldCells) {
  const minX = Math.min(...worldCells.map(([x]) => x));
  const minY = Math.min(...worldCells.map(([, y]) => y));
  piece.x = minX;
  piece.y = minY;
  piece.rotationIndex = toRotation;
}

function isPieceEdgeTouchingWallOrBlocks(piece) {
  const cells = getPieceCells(piece);
  for (const [x, y] of cells) {
    const neighbors = [
      [x + 1, y],
      [x - 1, y],
      [x, y + 1],
      [x, y - 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
      if (ny < 0) continue;
      if (board[ny][nx] !== 0) return true;
    }
  }
  return false;
}

function tryTPivotSearchRotate(piece, dir) {
  const fromRotation = piece.rotationIndex;
  const rotationsLen = piece.shape.rotations.length;
  const toForward = (fromRotation + dir + rotationsLen) % rotationsLen;
  const toReverse = (fromRotation - dir + rotationsLen) % rotationsLen;

  const originalWorld = getPieceCells(piece);
  const shiftedWorld = originalWorld.map(([x, y]) => [x, y + 1]);
  const originalSet = new Set(originalWorld.map(([x, y]) => toCellKey(x, y)));
  const shiftedSet = new Set(shiftedWorld.map(([x, y]) => toCellKey(x, y)));

  const union = [];
  const seen = new Set();
  const push = (x, y) => {
    const key = toCellKey(x, y);
    if (seen.has(key)) return;
    seen.add(key);
    union.push([x, y]);
  };
  for (const [x, y] of originalWorld) push(x, y);
  for (const [x, y] of shiftedWorld) push(x, y);
  union.sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));

  const shiftedBottomY = Math.max(...shiftedWorld.map(([, y]) => y));
  const shiftedBottomAnchors = union.filter(
    ([x, y]) => y === shiftedBottomY && shiftedSet.has(toCellKey(x, y)),
  );

  // Priority 1: shifted-basis bottom-row pivots.
  for (const [px, py] of shiftedBottomAnchors) {
    // Shifted-basis only: try requested direction first, then reverse direction.
    for (const checkDir of [dir, -dir]) {
      const rotated = rotateWorldCellsAroundPivot(shiftedWorld, px, py, checkDir);
      if (!canPlaceWorldCells(rotated)) continue;
      const to = checkDir === dir ? toForward : toReverse;
      applyRotatedWorldCells(piece, to, rotated);
      return true;
    }
  }

  // Priority 2: union anchors from lower rows upward.
  // shifted-basis first, then original-basis.
  for (const [px, py] of union) {
    const key = toCellKey(px, py);
    if (shiftedSet.has(key)) {
      // Shifted-basis only: try requested direction first, then reverse direction.
      for (const checkDir of [dir, -dir]) {
        const rotated = rotateWorldCellsAroundPivot(shiftedWorld, px, py, checkDir);
        if (!canPlaceWorldCells(rotated)) continue;
        const to = checkDir === dir ? toForward : toReverse;
        applyRotatedWorldCells(piece, to, rotated);
        return true;
      }
    }
    if (originalSet.has(key)) {
      const rotated = rotateWorldCellsAroundPivot(originalWorld, px, py, dir);
      if (canPlaceWorldCells(rotated)) {
        applyRotatedWorldCells(piece, toForward, rotated);
        return true;
      }
    }
  }
  return false;
}

function triggerTSpinEffect() {
  boardWrapEl.classList.add("tspin-flash");
  if (tSpinFxTimer) clearTimeout(tSpinFxTimer);
  tSpinFxTimer = setTimeout(() => {
    boardWrapEl.classList.remove("tspin-flash");
    tSpinFxTimer = null;
  }, 260);
}

function tryRotate(dir) {
  if (!currentPiece || paused || gameOver) return;
  lastMoveWasRotation = false;
  const rotationsLen = currentPiece.shape.rotations.length;
  const from = currentPiece.rotationIndex;
  const to = (from + dir + rotationsLen) % rotationsLen;

  // T piece: pivot-search is only enabled when the piece is edge-touching
  // (wall or stacked blocks). Otherwise, rotate with normal logic only.
  if (currentPiece.shape.isTPiece && isPieceEdgeTouchingWallOrBlocks(currentPiece)) {
    if (tryTPivotSearchRotate(currentPiece, dir)) {
      lastMoveWasRotation = true;
      groundedMs = 0;
      requestSfx("rot");
      return;
    }
  }

  const baseKicks =
    currentPiece.shape.isTPiece && rotationsLen === 4
      ? getTPieceKickTests(from, to)
      : [
          [0, 0],
          [1, 0],
          [-1, 0],
          [2, 0],
          [-2, 0],
          [0, -1],
          [1, -1],
          [-1, -1],
        ];
  for (const [kx, ky] of baseKicks) {
    if (!collides(currentPiece, kx, ky, dir)) {
      currentPiece.x += kx;
      currentPiece.y += ky;
      currentPiece.rotationIndex = to;
      lastMoveWasRotation = true;
      groundedMs = 0;
      requestSfx("rot");
      return;
    }
  }
}

function hardDrop() {
  if (!currentPiece || paused || gameOver) return;
  let dropped = 0;
  while (tryMove(0, 1, false)) dropped += 1;
  score += Math.round(dropped * HARD_DROP_SCORE * getPieceScoreMultiplier(currentPiece));
  groundedMs = 0;
  lockCurrentPiece();
}

function lockCurrentPiece() {
  if (!currentPiece) return;
  const scoreMultiplier = getPieceScoreMultiplier(currentPiece);
  const lockedCells = getPieceCells(currentPiece);
  const hasBlockAboveTop = lockedCells.some(([, y]) => y < 0);
  const tSpin = isTSpin(currentPiece);
  const wasSpecialBar = Boolean(currentPiece.shape?.isSpecialBar);
  mergePiece(currentPiece);
  requestSfx("drop");
  if (hasBlockAboveTop) {
    triggerGameOver();
    return;
  }
  const removed = clearLines();
  if (removed > 0) {
    lines += removed;
    level = 1 + Math.floor(lines / 10);
    const scoreIndex = Math.min(removed, LINE_CLEAR_SCORE.length - 1);
    score += Math.round(LINE_CLEAR_SCORE[scoreIndex] * level * scoreMultiplier);
    if (wasSpecialBar) requestSfx("special_clear");
    else if (tSpin) requestSfx("clear_big");
    else if (removed >= 4) requestSfx("clear_big");
    else requestSfx("clear");
  }
  if (lines >= 30 && !gameClearReached) {
    triggerGameClear();
    return;
  }
  if (tSpin) {
    const scoreIdx = Math.min(removed, T_SPIN_SCORE.length - 1);
    score += T_SPIN_SCORE[scoreIdx] * level;
    syncStats();
    triggerTSpinEffect();
  }
  maybeQueueSpecialPiece();
  spawnPiece();
  syncStats();
}

function holdCurrentPiece() {
  if (!currentPiece || paused || gameOver || holdUsedInTurn) return;
  lastMoveWasRotation = false;
  groundedMs = 0;
  holdUsedInTurn = true;
  if (!holdShape) {
    holdShape = currentPiece.shape;
    spawnPiece(false);
  } else {
    const swap = holdShape;
    holdShape = currentPiece.shape;
    currentPiece = createPiece(swap);
    if (collides(currentPiece)) {
      triggerGameOver();
    }
  }
  drawHold();
  requestSfx("hold");
}

function isOccupiedOrWall(x, y) {
  if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return true;
  return board[y][x] !== 0;
}

function getTPivotLocal(cells) {
  const set = new Set(cells.map(([x, y]) => `${x},${y}`));
  for (const [x, y] of cells) {
    let neighbors = 0;
    if (set.has(`${x + 1},${y}`)) neighbors += 1;
    if (set.has(`${x - 1},${y}`)) neighbors += 1;
    if (set.has(`${x},${y + 1}`)) neighbors += 1;
    if (set.has(`${x},${y - 1}`)) neighbors += 1;
    if (neighbors >= 3) return [x, y];
  }
  return null;
}

function isTSpin(piece) {
  if (!piece?.shape?.isTPiece) return false;
  if (!lastMoveWasRotation) return false;
  const cells = piece.shape.rotations[piece.rotationIndex];
  const pivotLocal = getTPivotLocal(cells);
  if (!pivotLocal) return false;
  const pivotX = piece.x + pivotLocal[0];
  const pivotY = piece.y + pivotLocal[1];
  const corners = [
    [pivotX - 1, pivotY - 1],
    [pivotX + 1, pivotY - 1],
    [pivotX - 1, pivotY + 1],
    [pivotX + 1, pivotY + 1],
  ];
  let occupiedCorners = 0;
  for (const [x, y] of corners) {
    if (isOccupiedOrWall(x, y)) occupiedCorners += 1;
  }
  return occupiedCorners >= 3;
}

function getDropInterval() {
  return Math.max(TICK_MIN, TICK_BASE - (level - 1) * 60);
}

function getGhostOffset(piece) {
  let offset = 0;
  while (!collides(piece, 0, offset + 1)) offset += 1;
  return offset;
}

function drawCell(ctx, x, y, color, cellSize) {
  ctx.fillStyle = color;
  ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
  ctx.strokeStyle = "rgba(38, 46, 47, 0.11)";
  ctx.lineWidth = 0.8;
  ctx.strokeRect(x * cellSize + 0.5, y * cellSize + 0.5, cellSize - 1, cellSize - 1);
}

function drawBoard() {
  boardCtx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
  boardCtx.fillStyle = "#c5d0d1";
  boardCtx.fillRect(0, 0, boardCanvas.width, boardCanvas.height);

  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const color = board[y][x];
      if (color) {
        drawCell(boardCtx, x, y, color, CELL);
      } else {
        boardCtx.strokeStyle = "rgba(55, 67, 69, 0.1)";
        boardCtx.lineWidth = 0.75;
        boardCtx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
      }
    }
  }

  if (currentPiece) {
    const ghostOffset = getGhostOffset(currentPiece);
    for (const [x, y] of getPieceCells(currentPiece, 0, ghostOffset)) {
      if (y < 0) continue;
      boardCtx.fillStyle = "rgba(71, 75, 83, 0.2)";
      boardCtx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
    }

    for (const [x, y] of getPieceCells(currentPiece)) {
      if (y < 0) continue;
      drawCell(boardCtx, x, y, currentPiece.shape.color, CELL);
    }
  }
}

function drawNext() {
  nextCtx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  const next = queue[0];
  if (!next) return;

  const cells = next.shape.rotations[0];
  const maxX = Math.max(...cells.map(([x]) => x));
  const maxY = Math.max(...cells.map(([, y]) => y));
  const widthPx = (maxX + 1) * NEXT_CELL;
  const heightPx = (maxY + 1) * NEXT_CELL;
  const ox = Math.floor((nextCanvas.width - widthPx) / 2 / NEXT_CELL);
  const oy = Math.floor((nextCanvas.height - heightPx) / 2 / NEXT_CELL);
  for (const [x, y] of cells) {
    drawCell(nextCtx, x + ox, y + oy, next.shape.color, NEXT_CELL);
  }
}

function drawHold() {
  holdCtx.clearRect(0, 0, holdCanvas.width, holdCanvas.height);
  if (!holdShape) return;

  const cells = holdShape.rotations[0];
  const maxX = Math.max(...cells.map(([x]) => x));
  const maxY = Math.max(...cells.map(([, y]) => y));
  const widthPx = (maxX + 1) * NEXT_CELL;
  const heightPx = (maxY + 1) * NEXT_CELL;
  const ox = Math.floor((holdCanvas.width - widthPx) / 2 / NEXT_CELL);
  const oy = Math.floor((holdCanvas.height - heightPx) / 2 / NEXT_CELL);
  for (const [x, y] of cells) {
    drawCell(holdCtx, x + ox, y + oy, holdShape.color, NEXT_CELL);
  }
}

function getSpawnTierLabelByLines(currentLines) {
  if (currentLines >= 25) return "S";
  if (currentLines >= 20) return "A";
  if (currentLines >= 15) return "B";
  if (currentLines >= 10) return "C";
  if (currentLines >= 5) return "D";
  return "E";
}

function syncStats() {
  scoreEl.textContent = String(score);
  linesEl.textContent = String(lines);
  levelEl.textContent = `${getSpawnTierLabelByLines(lines)}-${level}`;
}

function resetGame() {
  board = createBoard();
  queue = [];
  score = 0;
  lines = 0;
  level = 1 + Math.floor(lines / 10);
  running = true;
  paused = false;
  gameOver = false;
  clearPromptActive = false;
  gameClearReached = false;
  shouldResumeMusicAfterClear = false;
  holdShape = null;
  holdUsedInTurn = false;
  lastMoveWasRotation = false;
  specialPieceQueued = false;
  specialPieceUsed = false;
  groundedMs = 0;
  forcedFourRemaining = 3;
  fallAccumulator = 0;
  lastTime = 0;
  appEl.classList.remove("paused-view");
  pauseBtn.textContent = "Pause";
  bgmWasPlayingBeforePause = false;
  hideOverlay();
  refillBag(4);
  refillBag(5);
  refillBag(6);
  refillBag(7);
  refillBag(8);
  refillBag(9);
  refillBag(10);
  spawnPiece();
  syncStats();
  drawBoard();
  drawNext();
  drawHold();
}

function maybeQueueSpecialPiece() {
  if (specialPieceUsed || specialPieceQueued) return;
  if (score < 1000) return;
  queue.unshift(createPiece(SPECIAL_BAR_SHAPE));
  specialPieceQueued = true;
}

function gameLoop(ts) {
  if (!running) return;
  if (!lastTime) lastTime = ts;
  const delta = ts - lastTime;
  lastTime = ts;
  if (!paused && !gameOver && currentPiece) {
    fallAccumulator += delta;
    const interval = getDropInterval();
    while (fallAccumulator >= interval) {
      fallAccumulator -= interval;
      if (!tryMove(0, 1)) break;
    }

    if (collides(currentPiece, 0, 1)) {
      groundedMs += delta;
      if (groundedMs >= interval) {
        groundedMs = 0;
        lockCurrentPiece();
      }
    } else {
      groundedMs = 0;
    }
  }
  drawBoard();
  drawNext();
  drawHold();
  requestAnimationFrame(gameLoop);
}

function startMusic() {
  activeBgm.volume = 0.35;
  activeBgm.playbackRate = 1.3;
  if (musicReady) {
    if (activeBgm.paused) {
      activeBgm.play().catch(() => {});
    }
    return;
  }
  musicReady = true;
  activeBgm.play().catch(() => {
    musicReady = false;
  });
}

function setActiveBgmButton(src) {
  for (const btn of bgmButtons) {
    const active = btn.dataset.bgmSrc === src;
    btn.classList.toggle("is-active", active);
  }
}

function switchBgm(nextSrc) {
  const currentSrc = activeBgm.getAttribute("src");
  if (!nextSrc || currentSrc === nextSrc) {
    setActiveBgmButton(nextSrc || currentSrc);
    return;
  }
  if (bgmFadeRaf) {
    cancelAnimationFrame(bgmFadeRaf);
    bgmFadeRaf = null;
  }
  const shouldCrossFade = musicReady && !activeBgm.paused && !paused && !gameOver;
  if (!shouldCrossFade) {
    activeBgm.pause();
    activeBgm.currentTime = 0;
    activeBgm.setAttribute("src", nextSrc);
    activeBgm.load();
    activeBgm.playbackRate = 1.3;
    activeBgm.volume = 0.35;
    if (musicReady && !paused && !gameOver) {
      activeBgm.play().catch(() => {});
    }
    setActiveBgmButton(nextSrc);
    return;
  }
  standbyBgm.pause();
  standbyBgm.currentTime = 0;
  standbyBgm.setAttribute("src", nextSrc);
  standbyBgm.load();
  standbyBgm.playbackRate = 1.3;
  standbyBgm.volume = 0;
  standbyBgm.play().then(() => {
    const from = activeBgm;
    const to = standbyBgm;
    const targetVolume = 0.35;
    const durationMs = 450;
    const startedAt = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      from.volume = targetVolume * (1 - t);
      to.volume = targetVolume * t;
      if (t < 1) {
        bgmFadeRaf = requestAnimationFrame(tick);
        return;
      }
      from.pause();
      from.currentTime = 0;
      from.volume = targetVolume;
      to.volume = targetVolume;
      activeBgm = to;
      standbyBgm = from;
      bgmFadeRaf = null;
    };
    bgmFadeRaf = requestAnimationFrame(tick);
  }).catch(() => {
    activeBgm.pause();
    activeBgm.currentTime = 0;
    activeBgm.setAttribute("src", nextSrc);
    activeBgm.load();
    activeBgm.playbackRate = 1.3;
    activeBgm.volume = 0.35;
    activeBgm.play().catch(() => {});
  });
  setActiveBgmButton(nextSrc);
}

function flushPendingSfx() {
  sfxFlushScheduled = false;
  if (!pendingSfxKey || paused) {
    pendingSfxKey = null;
    pendingSfxPriority = -1;
    return;
  }
  const audioEl = SFX_AUDIO[pendingSfxKey];
  pendingSfxKey = null;
  pendingSfxPriority = -1;
  if (!audioEl) return;
  audioEl.currentTime = 0;
  audioEl.play().catch(() => {});
}

function requestSfx(key) {
  if (paused) return;
  const priority = SFX_PRIORITY[key];
  if (!priority) return;
  if (priority >= pendingSfxPriority) {
    pendingSfxPriority = priority;
    pendingSfxKey = key;
  }
  if (!sfxFlushScheduled) {
    sfxFlushScheduled = true;
    queueMicrotask(flushPendingSfx);
  }
}

function triggerGameOver() {
  running = false;
  gameOver = true;
  activeBgm.pause();
  standbyBgm.pause();
  bgmWasPlayingBeforePause = false;
  requestSfx("gameover");
  const showGameOver = () => drawTextOverlay("GAME OVER");
  if (isRankInScore(score)) {
    openRankInPrompt(showGameOver);
    return;
  }
  showGameOver();
}

function performAction(action) {
  if (rankInPromptActive) return;
  if (!running) {
    startGame();
  }
  if (!running || paused || gameOver) return;
  switch (action) {
    case "left":
      tryMove(-1, 0, false);
      requestSfx("move");
      break;
    case "right":
      tryMove(1, 0, false);
      requestSfx("move");
      break;
    case "down":
      if (tryMove(0, 1, true)) {
        score += Math.round(SOFT_DROP_SCORE * getPieceScoreMultiplier(currentPiece));
        syncStats();
      }
      break;
    case "hard-drop":
      hardDrop();
      syncStats();
      break;
    case "rot-left":
      tryRotate(-1);
      break;
    case "rot-right":
      tryRotate(1);
      break;
    case "hold":
      holdCurrentPiece();
      break;
    default:
      break;
  }
}

function pauseMusic() {
  if (!musicReady) return;
  bgmWasPlayingBeforePause = !activeBgm.paused;
  activeBgm.pause();
  standbyBgm.pause();
}

function resumeMusic() {
  if (!musicReady || !bgmWasPlayingBeforePause) return;
  activeBgm.play().catch(() => {});
  bgmWasPlayingBeforePause = false;
}

function setPaused(nextPaused) {
  if (!running || gameOver) return;
  paused = nextPaused;
  appEl.classList.toggle("paused-view", paused);
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  for (const btn of mobileGameButtons) {
    if (btn.dataset.mobileAction === "pause") {
      btn.textContent = paused ? "Resume" : "Pause";
    }
  }
  if (paused) {
    drawTextOverlay("PAUSED");
    pauseMusic();
  } else {
    hideOverlay();
    resumeMusic();
  }
}

function togglePause() {
  if (rankInPromptActive) return;
  setPaused(!paused);
}

function startGame() {
  if (rankInPromptActive) return;
  if (running && !gameOver) return;
  startMusic();
  resetGame();
  requestAnimationFrame(gameLoop);
}

function restartGame() {
  if (rankInPromptActive) return;
  returnToStartScreen();
}

document.addEventListener("keydown", (e) => {
  if (rankInPromptActive) {
    if (e.code === "Enter") {
      e.preventDefault();
      submitRankIn();
    }
    return;
  }
  if (clearPromptActive) {
    if (e.code === "KeyY" || e.code === "Enter") {
      e.preventDefault();
      resolveGameClear(true);
      return;
    }
    if (e.code === "KeyN" || e.code === "Escape") {
      e.preventDefault();
      resolveGameClear(false);
      return;
    }
  }
  primeSfxIfNeeded();
  if (e.code === "KeyR") {
    e.preventDefault();
    restartGame();
    return;
  }
  if (!running && e.code === "Space") {
    e.preventDefault();
    startGame();
    return;
  }
  if (!running) return;
  if (e.code === "KeyP") {
    togglePause();
    return;
  }
  if (paused || gameOver) return;

  switch (e.code) {
    case "ArrowLeft":
      e.preventDefault();
      tryMove(-1, 0, true);
      break;
    case "ArrowRight":
      e.preventDefault();
      tryMove(1, 0, true);
      break;
    case "ArrowDown":
      e.preventDefault();
      if (tryMove(0, 1, true)) {
        score += Math.round(SOFT_DROP_SCORE * getPieceScoreMultiplier(currentPiece));
        syncStats();
      }
      break;
    case "ArrowUp":
      e.preventDefault();
      hardDrop();
      syncStats();
      break;
    case "KeyZ":
      e.preventDefault();
      tryRotate(-1);
      break;
    case "KeyX":
      e.preventDefault();
      tryRotate(1);
      break;
    case "Space":
      e.preventDefault();
      holdCurrentPiece();
      break;
    default:
      break;
  }
});

startBtn.addEventListener("click", startGame);
restartBtn.addEventListener("click", restartGame);
pauseBtn.addEventListener("click", togglePause);
boardWrapEl.addEventListener("click", () => {
  if (!running) startGame();
});
overlayEl.addEventListener("click", (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.hasAttribute("data-rank-submit")) {
    submitRankIn();
    return;
  }
  if (!clearPromptActive) return;
  const action = target.dataset.clearAction;
  if (action === "yes") resolveGameClear(true);
  if (action === "no") resolveGameClear(false);
});
for (const btn of bgmButtons) {
  btn.addEventListener("click", () => {
    switchBgm(btn.dataset.bgmSrc);
  });
}
for (const btn of mobileGameButtons) {
  btn.addEventListener("click", () => {
    const action = btn.dataset.mobileAction;
    if (action === "start") startGame();
    else if (action === "restart") restartGame();
    else if (action === "pause") togglePause();
  });
}

if (touchPanelEl) {
  for (const btn of touchPanelEl.querySelectorAll(".touch-btn")) {
    const action = btn.dataset.action;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      primeSfxIfNeeded();
      performAction(action);
    });
  }
}

document.body.addEventListener(
  "pointerdown",
  () => {
    primeSfxIfNeeded();
    startMusic();
  },
  { once: true },
);

function init() {
  buildShapeSets();
  lines = 0;
  level = 1 + Math.floor(lines / 10);
  rankingTop = [];
  syncStats();
  setActiveBgmButton(activeBgm.getAttribute("src"));
  drawBoard();
  drawNext();
  drawHold();
  drawStartOverlay();
  fetchRankingTop3().then((rows) => {
    rankingTop = rows;
    if (!running && !gameOver && !clearPromptActive && !rankInPromptActive) {
      drawStartOverlay();
    }
  });
}

init();
