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
const bgm = document.getElementById("bgm");
const sfxDrop = document.getElementById("sfxDrop");
const sfxRotate = document.getElementById("sfxRotate");
const sfxMove = document.getElementById("sfxMove");
const sfxClear = document.getElementById("sfxClear");
const sfxClearBig = document.getElementById("sfxClearBig");

const COLS = 10;
const ROWS = 22;
const CELL = 32;
const NEXT_CELL = 26;
const TICK_MIN = 90;
const TICK_BASE = 800;
const SOFT_DROP_SCORE = 1;
const HARD_DROP_SCORE = 2;
const LINE_CLEAR_SCORE = [0, 100, 300, 500, 800, 1200, 1700];
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
};
let bagBySize = {
  4: [],
  5: [],
  6: [],
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

const SFX_PRIORITY = {
  move: 1,
  rot: 2,
  drop: 3,
  clear: 4,
  clear_big: 5,
};

const SFX_AUDIO = {
  move: sfxMove,
  rot: sfxRotate,
  drop: sfxDrop,
  clear: sfxClear,
  clear_big: sfxClearBig,
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
    return {
      id: `${size}-${idx}`,
      size,
      color: COLORS[idx % COLORS.length],
      rotations: uniqueRotations(base),
    };
  });
}

function buildShapeSets() {
  shapesBySize[4] = generateAllPolyominoes(4);
  shapesBySize[5] = generateAllPolyominoes(5);
  shapesBySize[6] = generateAllPolyominoes(6);
  refillBag(4);
  refillBag(5);
  refillBag(6);
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
  overlayEl.textContent = text;
}

function hideOverlay() {
  overlayEl.classList.add("hidden");
}

function pickPieceSize() {
  const r = Math.random();
  if (r < 0.8) return 4;
  if (r < 0.95) return 5;
  return 6;
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
  if (removed > 0) {
    if (removed >= 4) requestSfx("clear_big");
    else requestSfx("clear");
    lines += removed;
    const scoreIndex = Math.min(removed, LINE_CLEAR_SCORE.length - 1);
    score += LINE_CLEAR_SCORE[scoreIndex] * level;
    level = 1 + Math.floor(lines / 10);
    syncStats();
  }
}

function spawnPiece(resetHold = true) {
  if (queue.length < 2) queue.push(makeRandomPiece(), makeRandomPiece());
  currentPiece = queue.shift();
  queue.push(makeRandomPiece());
  if (resetHold) holdUsedInTurn = false;
  if (collides(currentPiece)) {
    running = false;
    gameOver = true;
    drawTextOverlay("GAME OVER");
  }
}

function tryMove(dx, dy, playMoveSfx = false) {
  if (!currentPiece || paused || gameOver) return false;
  if (!collides(currentPiece, dx, dy, 0)) {
    currentPiece.x += dx;
    currentPiece.y += dy;
    if (playMoveSfx && (dx !== 0 || dy !== 0)) requestSfx("move");
    return true;
  }
  return false;
}

function tryRotate(dir) {
  if (!currentPiece || paused || gameOver) return;
  const kicks = [
    [0, 0],
    [1, 0],
    [-1, 0],
    [2, 0],
    [-2, 0],
    [0, -1],
    [1, -1],
    [-1, -1],
  ];
  for (const [kx, ky] of kicks) {
    if (!collides(currentPiece, kx, ky, dir)) {
      currentPiece.x += kx;
      currentPiece.y += ky;
      currentPiece.rotationIndex =
        (currentPiece.rotationIndex + dir + currentPiece.shape.rotations.length) %
        currentPiece.shape.rotations.length;
      requestSfx("rot");
      return;
    }
  }
}

function hardDrop() {
  if (!currentPiece || paused || gameOver) return;
  let dropped = 0;
  while (tryMove(0, 1, false)) dropped += 1;
  score += dropped * HARD_DROP_SCORE;
  lockCurrentPiece();
}

function lockCurrentPiece() {
  mergePiece(currentPiece);
  requestSfx("drop");
  clearLines();
  spawnPiece();
  syncStats();
}

function holdCurrentPiece() {
  if (!currentPiece || paused || gameOver || holdUsedInTurn) return;
  holdUsedInTurn = true;
  if (!holdShape) {
    holdShape = currentPiece.shape;
    spawnPiece(false);
  } else {
    const swap = holdShape;
    holdShape = currentPiece.shape;
    currentPiece = createPiece(swap);
    if (collides(currentPiece)) {
      running = false;
      gameOver = true;
      drawTextOverlay("GAME OVER");
    }
  }
  drawHold();
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
  ctx.strokeStyle = "rgba(30,34,32,0.16)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x * cellSize + 0.5, y * cellSize + 0.5, cellSize - 1, cellSize - 1);
}

function drawBoard() {
  boardCtx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
  boardCtx.fillStyle = "#cfc8bc";
  boardCtx.fillRect(0, 0, boardCanvas.width, boardCanvas.height);

  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLS; x += 1) {
      const color = board[y][x];
      if (color) {
        drawCell(boardCtx, x, y, color, CELL);
      } else {
        boardCtx.strokeStyle = "rgba(45, 51, 48, 0.08)";
        boardCtx.strokeRect(x * CELL + 0.5, y * CELL + 0.5, CELL - 1, CELL - 1);
      }
    }
  }

  if (currentPiece) {
    const ghostOffset = getGhostOffset(currentPiece);
    for (const [x, y] of getPieceCells(currentPiece, 0, ghostOffset)) {
      if (y < 0) continue;
      boardCtx.fillStyle = "rgba(80, 95, 87, 0.18)";
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
  nextCtx.fillStyle = "#d2ccbf";
  nextCtx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
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
  holdCtx.fillStyle = "#d2ccbf";
  holdCtx.fillRect(0, 0, holdCanvas.width, holdCanvas.height);
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

function syncStats() {
  scoreEl.textContent = String(score);
  linesEl.textContent = String(lines);
  levelEl.textContent = String(level);
}

function resetGame() {
  board = createBoard();
  queue = [];
  score = 0;
  lines = 0;
  level = 1;
  running = true;
  paused = false;
  gameOver = false;
  holdShape = null;
  holdUsedInTurn = false;
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
  spawnPiece();
  syncStats();
  drawBoard();
  drawNext();
  drawHold();
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
      if (!tryMove(0, 1)) {
        lockCurrentPiece();
        break;
      }
    }
  }
  drawBoard();
  drawNext();
  drawHold();
  requestAnimationFrame(gameLoop);
}

function startMusic() {
  bgm.volume = 0.35;
  bgm.playbackRate = 1.3;
  if (musicReady) {
    if (bgm.paused) {
      bgm.play().catch(() => {});
    }
    return;
  }
  musicReady = true;
  bgm.play().catch(() => {
    musicReady = false;
  });
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

function pauseMusic() {
  if (!musicReady) return;
  bgmWasPlayingBeforePause = !bgm.paused;
  bgm.pause();
}

function resumeMusic() {
  if (!musicReady || !bgmWasPlayingBeforePause) return;
  bgm.play().catch(() => {});
  bgmWasPlayingBeforePause = false;
}

function setPaused(nextPaused) {
  if (!running || gameOver) return;
  paused = nextPaused;
  appEl.classList.toggle("paused-view", paused);
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  if (paused) {
    drawTextOverlay("PAUSED");
    pauseMusic();
  } else {
    hideOverlay();
    resumeMusic();
  }
}

function togglePause() {
  setPaused(!paused);
}

function startGame() {
  if (running && !gameOver) return;
  startMusic();
  resetGame();
  requestAnimationFrame(gameLoop);
}

function restartGame() {
  const wasRunning = running;
  startMusic();
  resetGame();
  if (!wasRunning) {
    requestAnimationFrame(gameLoop);
  }
}

document.addEventListener("keydown", (e) => {
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
        score += SOFT_DROP_SCORE;
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
document.body.addEventListener(
  "pointerdown",
  () => {
    startMusic();
  },
  { once: true },
);

function init() {
  buildShapeSets();
  syncStats();
  drawBoard();
  drawNext();
  drawHold();
  drawTextOverlay("PRESS START");
}

init();
