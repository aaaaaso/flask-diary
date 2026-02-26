const BOARD_W = 3200;
const BOARD_H = 4000;
const NODE_W = 220;
const NODE_H = 100;
const NODE_MIN_H = 56;
const AUTO_CHILD_DY = 50;
const GRID_SIZE = 20;
const MIN_VIEW_SCALE = 0.5;
const MAX_VIEW_SCALE = 2.5;
const VIEW_MODE_INITIAL_SCALE = 1;

const state = {
  nodes: [],
  edges: [],
  edgeArrows: [],
  stepLines: [],
  texts: [],
  nextId: 1,
  nextStepLineId: 1,
  nextTextId: 1,
  selectedNodeIds: [],
  selectedStepLineIds: [],
  selectedTextIds: [],
  selectedEdgeKeys: [],
};

const historyStack = [];
const HISTORY_LIMIT = 120;

const linkDraft = {
  active: false,
  fromId: null,
  fromSide: "bottom",
  toX: 0,
  toY: 0,
  targetId: null,
  targetEdgeKey: null,
};

const marquee = {
  active: false,
  baseNodeIds: [],
  baseStepLineIds: [],
  baseTextIds: [],
  baseEdgeKeys: [],
  additive: false,
  sx: 0,
  sy: 0,
  ex: 0,
  ey: 0,
  el: null,
};

const boardWrap = document.getElementById("board-wrap");
const board = document.getElementById("board");
const edgesSvg = document.getElementById("edges");
const cardTpl = document.getElementById("card-template");
const toggleJsonBtn = document.getElementById("toggle-json");
const jsonPanel = document.getElementById("json-panel");
const jsonOutput = document.getElementById("json-output");
const jsonStatus = document.getElementById("json-status");
const recipeTitleEl = document.getElementById("recipe-title");
const recipeItemsEl = document.getElementById("recipe-items");
const recipeDropIndicator = document.getElementById("recipe-drop-indicator");
const addStepLineBtn = document.getElementById("add-step-line");
const exportImageButtons = Array.from(document.querySelectorAll("[data-export-image]"));
const isEditable = document.body?.dataset?.mode === "edit";
const pageParams = new URLSearchParams(window.location.search);
const editorKey = (pageParams.get("key") || "").trim();

let currentRecipeName = "";
let currentRecipeLabel = "タイトルなし";
let lastSavedSignature = "";
let lastSavedLabel = "";
let recipeNames = [];
let isEditingJson = false;
let suppressJsonInput = false;
let jsonSyncTimer = null;
let draggingRecipeName = null;
let editingRecipeKey = null;
let draftListIndex = null;
let hasDraftRecipe = false;
let suppressRecipeDrag = false;
let armedRecipeDeleteKey = null;
let armedRecipeDeleteTimer = null;
let globalHeightSyncRaf = 0;
let selectionClipboard = null;
let clipboardPasteCount = 0;
let viewScale = 1;
let gestureStartScale = 1;

function withEditorKey(path) {
  if (!isEditable || !editorKey) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}key=${encodeURIComponent(editorKey)}`;
}

function refreshRecipeTitle() {
  if (!recipeTitleEl) return;
  recipeTitleEl.textContent = (currentRecipeLabel || "").trim() || "タイトルなし";
}

function clearArmedRecipeDelete() {
  armedRecipeDeleteKey = null;
  if (armedRecipeDeleteTimer) {
    clearTimeout(armedRecipeDeleteTimer);
    armedRecipeDeleteTimer = null;
  }
  if (recipeItemsEl) {
    recipeItemsEl.querySelectorAll(".recipe-remove-btn.is-armed").forEach((btn) => {
      btn.classList.remove("is-armed");
      btn.textContent = "-";
      btn.title = "削除";
    });
  }
}

function copySelectionToClipboard() {
  if (!state.selectedNodeIds.length && !state.selectedTextIds.length) return false;
  const selectedSet = new Set(state.selectedNodeIds);
  const nodes = state.nodes
    .filter((n) => selectedSet.has(n.id))
    .map((n) => ({
      x: n.x,
      y: n.y,
      h: nodeHeight(n),
      title: n.title || "",
      color: normalizeNodeColor(n.color),
      time: normalizeNodeTime(n.time),
      tags: normalizeNodeTags(n.tags),
      memos: normalizeNodeMemos(n.memos),
    }));
  const edges = state.edges
    .filter((e) => selectedSet.has(e.from) && selectedSet.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      fromSide: e.fromSide,
      toSide: e.toSide,
    }));
  const selectedTextSet = new Set(state.selectedTextIds);
  const texts = state.texts
    .filter((t) => selectedTextSet.has(t.id))
    .map((t) => ({
      x: t.x,
      y: t.y,
      w: Number.isFinite(Number(t.w)) ? Number(t.w) : 220,
      h: textHeight(t),
      text: String(t.text || ""),
      bold: Boolean(t.bold),
    }));
  if (!nodes.length && !texts.length) return false;
  selectionClipboard = {
    sourceIds: [...state.selectedNodeIds],
    sourceTextIds: [...state.selectedTextIds],
    nodes,
    edges,
    texts,
  };
  clipboardPasteCount = 0;
  return true;
}

function pasteSelectionFromClipboard() {
  if (!selectionClipboard) return false;
  const hasNodes = Array.isArray(selectionClipboard.nodes) && selectionClipboard.nodes.length > 0;
  const hasTexts = Array.isArray(selectionClipboard.texts) && selectionClipboard.texts.length > 0;
  if (!hasNodes && !hasTexts) return false;
  pushHistory();

  clipboardPasteCount += 1;
  const offset = GRID_SIZE * 3 * clipboardPasteCount;
  const idMap = new Map();
  const nextSelectedNodeIds = [];
  const nextSelectedTextIds = [];

  const sourceIds = selectionClipboard.sourceIds || [];
  (selectionClipboard.nodes || []).forEach((n, idx) => {
    const oldId = sourceIds[idx];
    const freshId = state.nextId;
    state.nextId += 1;
    const copied = {
      id: freshId,
      x: n.x + offset,
      y: n.y + offset,
      h: Number.isFinite(Number(n.h)) ? Number(n.h) : NODE_H,
      title: n.title || "",
      mode: "material",
      color: normalizeNodeColor(n.color),
      time: normalizeNodeTime(n.time),
      tags: normalizeNodeTags(n.tags),
      memos: normalizeNodeMemos(n.memos),
    };
    clampNode(copied);
    state.nodes.push(copied);
    nextSelectedNodeIds.push(freshId);
    if (Number.isFinite(Number(oldId))) idMap.set(Number(oldId), freshId);
  });

  (selectionClipboard.edges || []).forEach((e) => {
    const from = idMap.get(Number(e.from));
    const to = idMap.get(Number(e.to));
    if (!from || !to) return;
    upsertEdge(from, to, e.fromSide || "bottom", e.toSide || "top");
  });

  (selectionClipboard.texts || []).forEach((t) => {
    const freshId = state.nextTextId;
    state.nextTextId += 1;
    const copied = {
      id: freshId,
      x: Number(t.x) + offset,
      y: Number(t.y) + offset,
      w: Number.isFinite(Number(t.w)) ? Number(t.w) : 220,
      h: Number.isFinite(Number(t.h)) ? Number(t.h) : 26,
      text: String(t.text || ""),
      bold: Boolean(t.bold),
    };
    clampText(copied);
    state.texts.push(copied);
    nextSelectedTextIds.push(freshId);
  });

  state.selectedNodeIds = nextSelectedNodeIds;
  state.selectedStepLineIds = [];
  state.selectedTextIds = nextSelectedTextIds;
  state.selectedEdgeKeys = [];
  render();
  return true;
}

function uniqueIntArray(values) {
  return Array.from(new Set(values.map((v) => Number(v)).filter((v) => Number.isFinite(v))));
}

function setSelection(nodeIds = [], lineIds = []) {
  state.selectedNodeIds = uniqueIntArray(nodeIds);
  state.selectedStepLineIds = uniqueIntArray(lineIds);
  state.selectedTextIds = [];
  state.selectedEdgeKeys = [];
  refreshSelectionUI();
}

function clearSelection() {
  setSelection([], []);
}

function isNodeSelected(id) {
  return state.selectedNodeIds.includes(id);
}

function isStepLineSelected(id) {
  return state.selectedStepLineIds.includes(id);
}

function isTextSelected(id) {
  return state.selectedTextIds.includes(id);
}

function primarySelectedNodeId() {
  return state.selectedNodeIds.length ? state.selectedNodeIds[0] : null;
}

function primarySelectedStepLineId() {
  return state.selectedStepLineIds.length ? state.selectedStepLineIds[0] : null;
}

function edgeKey(edge) {
  return `${Number(edge.from)}:${Number(edge.to)}`;
}

function edgeByKey(key) {
  return state.edges.find((e) => edgeKey(e) === key) || null;
}

function setEdgeSelection(edgeKeys = [], keepNodeLineSelection = false) {
  if (!keepNodeLineSelection) {
    state.selectedNodeIds = [];
    state.selectedStepLineIds = [];
    state.selectedTextIds = [];
  }
  state.selectedEdgeKeys = Array.from(new Set(edgeKeys.filter(Boolean)));
  refreshSelectionUI();
}

function isEdgeSelected(edge) {
  return state.selectedEdgeKeys.includes(edgeKey(edge));
}

function signatureOfCurrent() {
  return JSON.stringify(snapshot());
}

function hasUnsavedChanges() {
  if (!currentRecipeName) return hasDraftRecipe;
  return signatureOfCurrent() !== lastSavedSignature || currentRecipeLabel !== lastSavedLabel;
}

function markSavedNow() {
  lastSavedSignature = signatureOfCurrent();
  lastSavedLabel = currentRecipeLabel;
}

function nodeById(id) {
  return state.nodes.find((n) => n.id === id);
}

function nodeHeight(node) {
  return Number.isFinite(Number(node?.h)) ? Number(node.h) : NODE_H;
}

function normalizeNodeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t || "").trim()).filter(Boolean);
}

function normalizeNodeMemos(memos) {
  if (!Array.isArray(memos)) return [];
  return memos.map((m) => String(m || "").trim()).filter(Boolean).slice(0, 1);
}

function normalizeNodeMode(mode) {
  return mode === "cook" ? "cook" : "material";
}

function normalizeNodeColor(color) {
  if (color === "green" || color === "orange") return color;
  return "gray";
}

function normalizeNodeTime(time) {
  const v = String(time || "").trim();
  return v;
}

function oppositeSide(side) {
  if (side === "top") return "bottom";
  if (side === "bottom") return "top";
  if (side === "left") return "right";
  return "left";
}

function anchorFor(node, side) {
  const h = nodeHeight(node);
  return {
    x:
      side === "left"
        ? node.x
        : side === "right"
          ? node.x + NODE_W
          : node.x + NODE_W / 2,
    y:
      side === "top"
        ? node.y
        : side === "bottom"
          ? node.y + h
          : node.y + h / 2,
  };
}

function centerFor(node) {
  return { x: node.x + NODE_W / 2, y: node.y + nodeHeight(node) / 2 };
}

function resolveEdgeSides(edge, fromNode, toNode) {
  return { fromSide: "bottom", toSide: "top" };
}

function snapshot() {
  return {
    nodes: state.nodes,
    edges: state.edges,
    edgeArrows: state.edgeArrows,
    stepLines: state.stepLines,
    texts: state.texts,
    nextId: state.nextId,
    nextStepLineId: state.nextStepLineId,
    nextTextId: state.nextTextId,
  };
}

function cloneEditorState() {
  return {
    nodes: state.nodes.map((n) => ({ ...n })),
    edges: state.edges.map((e) => ({ ...e })),
    edgeArrows: state.edgeArrows.map((a) => ({ ...a })),
    stepLines: state.stepLines.map((l) => ({ ...l })),
    texts: state.texts.map((t) => ({ ...t })),
    nextId: state.nextId,
    nextStepLineId: state.nextStepLineId,
    nextTextId: state.nextTextId,
    selectedNodeIds: [...state.selectedNodeIds],
    selectedStepLineIds: [...state.selectedStepLineIds],
    selectedTextIds: [...state.selectedTextIds],
    selectedEdgeKeys: [...state.selectedEdgeKeys],
  };
}

function restoreEditorState(prev) {
  state.nodes = prev.nodes.map((n) => ({ ...n }));
  state.edges = prev.edges.map((e) => ({ ...e }));
  state.edgeArrows = (prev.edgeArrows || []).map((a) => ({ ...a }));
  state.stepLines = (prev.stepLines || []).map((l) => ({ ...l }));
  state.texts = (prev.texts || []).map((t) => ({ ...t }));
  state.nextId = prev.nextId;
  state.nextStepLineId = prev.nextStepLineId || 1;
  state.nextTextId = prev.nextTextId || 1;
  state.selectedNodeIds = uniqueIntArray(prev.selectedNodeIds || []);
  state.selectedStepLineIds = uniqueIntArray(prev.selectedStepLineIds || []);
  state.selectedTextIds = uniqueIntArray(prev.selectedTextIds || []);
  state.selectedEdgeKeys = Array.from(new Set((prev.selectedEdgeKeys || []).map(String)));
  render();
}

function pushHistory(prevState = null) {
  historyStack.push(prevState || cloneEditorState());
  if (historyStack.length > HISTORY_LIMIT) historyStack.shift();
}

function undo() {
  if (!historyStack.length) return;
  restoreEditorState(historyStack.pop());
}

function refreshJsonText() {
  if (!jsonOutput || isEditingJson) {
    refreshRecipeDirtyIndicator();
    return;
  }
  suppressJsonInput = true;
  jsonOutput.value = JSON.stringify(snapshot(), null, 2);
  suppressJsonInput = false;
  if (jsonStatus) {
    jsonStatus.textContent = "";
    jsonStatus.classList.remove("error");
  }
  refreshRecipeDirtyIndicator();
}

function refreshSelectionUI() {
  board.querySelectorAll(".card").forEach((el) => {
    const id = Number(el.dataset.id);
    el.classList.toggle("selected", isNodeSelected(id));
  });
  board.querySelectorAll(".step-line").forEach((el) => {
    const id = Number(el.dataset.id);
    el.classList.toggle("active", isStepLineSelected(id));
  });
  board.querySelectorAll(".text-item").forEach((el) => {
    const id = Number(el.dataset.id);
    el.classList.toggle("selected", isTextSelected(id));
  });
  edgesSvg.querySelectorAll(".edge-path").forEach((el) => {
    const key = el.dataset.edgeKey || "";
    el.classList.toggle("active", state.selectedEdgeKeys.includes(key));
  });
  scheduleGlobalHeightSync();
}

function syncAllNodeHeightsFromDom() {
  let changed = false;
  board.querySelectorAll(".card").forEach((el) => {
    const id = Number(el.dataset.id);
    const node = nodeById(id);
    if (!node) return;
    const measured = Math.max(NODE_MIN_H, Math.ceil(el.getBoundingClientRect().height));
    if (node.h !== measured) {
      node.h = measured;
      clampNode(node);
      placeNodeEl(el, node);
      changed = true;
    }
  });
  if (changed) {
    renderEdges();
    refreshJsonText();
  }
}

function scheduleGlobalHeightSync() {
  if (globalHeightSyncRaf) return;
  globalHeightSyncRaf = requestAnimationFrame(() => {
    globalHeightSyncRaf = 0;
    syncAllNodeHeightsFromDom();
  });
}

function refreshLinkTargetUI() {
  board.querySelectorAll(".card").forEach((el) => {
    const id = Number(el.dataset.id);
    el.classList.toggle("link-target", linkDraft.active && id === linkDraft.targetId);
  });
}

function clampNode(node) {
  node.x = Math.max(0, Math.min(BOARD_W - NODE_W, node.x));
  node.y = Math.max(0, Math.min(BOARD_H - nodeHeight(node), node.y));
}

function snap(value) {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

function snapPoint(x, y) {
  return { x: snap(x), y: snap(y) };
}

function placeNodeEl(nodeEl, node) {
  nodeEl.style.left = `${node.x}px`;
  nodeEl.style.top = `${node.y}px`;
}

function textHeight(text) {
  return Number.isFinite(Number(text?.h)) ? Number(text.h) : 22;
}

function clampText(text) {
  const w = Number.isFinite(Number(text.w)) ? Number(text.w) : 220;
  const h = textHeight(text);
  text.x = Math.max(0, Math.min(BOARD_W - w, text.x));
  text.y = Math.max(0, Math.min(BOARD_H - h, text.y));
}

function edgeExists(from, to) {
  return state.edges.some((e) => e.from === from && e.to === to);
}

function upsertEdge(from, to, fromSide, toSide) {
  const idx = state.edges.findIndex((e) => e.from === from && e.to === to);
  const next = { from, to, fromSide, toSide };
  if (idx >= 0) state.edges[idx] = next;
  else state.edges.push(next);
}

function intersects(a, b, margin = 18) {
  const ah = Number.isFinite(Number(a.h)) ? Number(a.h) : NODE_H;
  const bh = nodeHeight(b);
  return !(
    a.x + NODE_W + margin <= b.x ||
    b.x + NODE_W + margin <= a.x ||
    a.y + ah + margin <= b.y ||
    b.y + bh + margin <= a.y
  );
}

function canPlaceNodeAt(x, y, h = NODE_H) {
  const candidate = { x, y, h };
  return !state.nodes.some((node) => intersects(candidate, node));
}

function clampedPoint(x, y, h = NODE_H) {
  const s = snapPoint(x, y);
  return {
    x: Math.max(0, Math.min(BOARD_W - NODE_W, s.x)),
    y: Math.max(0, Math.min(BOARD_H - h, s.y)),
  };
}

function findNearbyFreePosition(preferredX, preferredY, originY, yDir) {
  const isDirectionOk = (y) => (yDir > 0 ? y > originY : y < originY);
  const stepX = 34;
  const stepY = 28;
  const base = clampedPoint(preferredX, preferredY, NODE_H);
  if (isDirectionOk(base.y) && canPlaceNodeAt(base.x, base.y, NODE_H)) return base;

  // Keep the same x as long as possible; search vertically first.
  for (let i = 1; i <= 12; i += 1) {
    const p = clampedPoint(base.x, base.y + yDir * i * stepY, NODE_H);
    if (!isDirectionOk(p.y)) continue;
    if (canPlaceNodeAt(p.x, p.y, NODE_H)) return p;
  }

  const dxOrder = [0];
  for (let i = 1; i <= 10; i += 1) {
    dxOrder.push(i, -i);
  }
  for (let ring = 1; ring <= 10; ring += 1) {
    for (const dx of dxOrder) {
      if (Math.abs(dx) > ring) continue;
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const p = clampedPoint(base.x + dx * stepX, base.y + dy * stepY, NODE_H);
        if (!isDirectionOk(p.y)) continue;
        if (canPlaceNodeAt(p.x, p.y, NODE_H)) return p;
      }
    }
  }
  return null;
}

function autoChildPosition(fromNode, fromSide) {
  const yDir = fromSide === "top" ? -1 : 1;
  const preferredX = fromNode.x;
  const preferredY = fromNode.y + yDir * AUTO_CHILD_DY;
  const p = findNearbyFreePosition(preferredX, preferredY, fromNode.y, yDir);
  if (!p) return null;
  return { id: state.nextId, x: p.x, y: p.y, h: NODE_H, title: "", mode: "material", color: "gray", time: "", tags: [], memos: [] };
}

function createConnectedNode(fromId, fromSide) {
  const fromNode = nodeById(fromId);
  if (!fromNode) return;
  pushHistory();
  const newNode = autoChildPosition(fromNode, fromSide);
  if (!newNode) {
    historyStack.pop();
    alert(fromSide === "bottom" ? "下側に配置できる空きがありません" : "上側に配置できる空きがありません");
    return;
  }
  state.nodes.push(newNode);
  upsertEdge(fromId, newNode.id, fromSide, oppositeSide(fromSide));
  state.nextId += 1;
  setSelection([newNode.id], []);
  render();
}

function sideVector(side) {
  if (side === "top") return { x: 0, y: -1 };
  if (side === "bottom") return { x: 0, y: 1 };
  if (side === "left") return { x: -1, y: 0 };
  return { x: 1, y: 0 };
}

function bezierControls(fromPt, fromSide, toPt, toSide) {
  const gap = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y);
  const d = Math.max(14, Math.min(64, gap * 0.4));
  const v1 = sideVector(fromSide);
  const v2 = sideVector(toSide);
  return {
    c1: { x: fromPt.x + v1.x * d, y: fromPt.y + v1.y * d },
    c2: { x: toPt.x + v2.x * d, y: toPt.y + v2.y * d },
  };
}

function pathD(fromPt, fromSide, toPt, toSide) {
  const { c1, c2 } = bezierControls(fromPt, fromSide, toPt, toSide);
  return `M ${fromPt.x} ${fromPt.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${toPt.x} ${toPt.y}`;
}

function drawPath(d, stroke, dashed = false) {
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("stroke", stroke);
  path.setAttribute("stroke-width", "1.7");
  path.setAttribute("fill", "none");
  if (dashed) path.setAttribute("stroke-dasharray", "6 5");
  edgesSvg.appendChild(path);
}

function cubicPoint(t, p0, p1, p2, p3) {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return (
    uu * u * p0 +
    3 * uu * t * p1 +
    3 * u * tt * p2 +
    tt * t * p3
  );
}

function edgeMidpoint(edge) {
  const from = nodeById(edge.from);
  const to = nodeById(edge.to);
  if (!from || !to) return null;
  const sides = resolveEdgeSides(edge, from, to);
  const a = anchorFor(from, sides.fromSide);
  const b = anchorFor(to, sides.toSide);
  const { c1, c2 } = bezierControls(a, sides.fromSide, b, sides.toSide);
  const t = 0.5;
  return {
    x: cubicPoint(t, a.x, c1.x, c2.x, b.x),
    y: cubicPoint(t, a.y, c1.y, c2.y, b.y),
  };
}

function edgeKeyFromClient(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const p = el ? el.closest(".edge-hit,.edge-path") : null;
  if (!p) return null;
  return p.dataset.edgeKey || null;
}

function renderEdges() {
  edgesSvg.innerHTML = "";
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
  marker.setAttribute("id", "edge-arrowhead");
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("refX", "7");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  const tip = document.createElementNS("http://www.w3.org/2000/svg", "path");
  tip.setAttribute("d", "M 0 0 L 8 3 L 0 6 z");
  tip.setAttribute("fill", "#7a8591");
  marker.appendChild(tip);
  defs.appendChild(marker);
  edgesSvg.appendChild(defs);

  state.edges.forEach((edge) => {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    if (!from || !to) return;
    const sides = resolveEdgeSides(edge, from, to);
    const fromSide = sides.fromSide;
    const toSide = sides.toSide;
    const a = anchorFor(from, fromSide);
    const b = anchorFor(to, toSide);
    const d = pathD(a, fromSide, b, toSide);
    const key = edgeKey(edge);
    const selectEdge = (e) => {
      e.stopPropagation();
      const toggle = e.metaKey || e.ctrlKey || e.shiftKey;
      if (toggle) {
        if (state.selectedEdgeKeys.includes(key)) {
          setEdgeSelection(state.selectedEdgeKeys.filter((k) => k !== key), true);
        } else {
          setEdgeSelection([...state.selectedEdgeKeys, key], true);
        }
      } else {
        setEdgeSelection([key], false);
      }
    };

    const hit = document.createElementNS("http://www.w3.org/2000/svg", "path");
    hit.setAttribute("d", d);
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "18");
    hit.setAttribute("fill", "none");
    hit.setAttribute("class", "edge-hit");
    hit.dataset.edgeKey = key;
    if (isEditable) {
      hit.addEventListener("pointerdown", selectEdge);
      hit.addEventListener("click", selectEdge);
    }

    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "#09637E");
    path.setAttribute("stroke-width", "1.7");
    path.setAttribute("fill", "none");
    path.setAttribute("class", "edge-path");
    path.dataset.edgeKey = key;
    if (isEditable) {
      path.addEventListener("pointerdown", selectEdge);
      path.addEventListener("click", selectEdge);
    }

    edgesSvg.appendChild(hit);
    edgesSvg.appendChild(path);
  });

  state.edgeArrows.forEach((arrow) => {
    const from = nodeById(arrow.from);
    const targetEdge = edgeByKey(arrow.toEdgeKey || "");
    if (!from || !targetEdge) return;
    const to = edgeMidpoint(targetEdge);
    if (!to) return;
    const a = anchorFor(from, "bottom");
    const dy = Math.max(16, Math.min(56, Math.abs(to.y - a.y) * 0.45));
    const d = `M ${a.x} ${a.y} C ${a.x} ${a.y + dy}, ${to.x} ${to.y - dy}, ${to.x} ${to.y}`;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "#7a8591");
    path.setAttribute("stroke-width", "1.4");
    path.setAttribute("fill", "none");
    path.setAttribute("marker-end", "url(#edge-arrowhead)");
    edgesSvg.appendChild(path);
  });

  if (linkDraft.active && linkDraft.fromId) {
    const from = nodeById(linkDraft.fromId);
    if (!from) return;
    const a = anchorFor(from, linkDraft.fromSide);
    const b = { x: linkDraft.toX, y: linkDraft.toY };
    drawPath(pathD(a, linkDraft.fromSide, b, oppositeSide(linkDraft.fromSide)), "#7AB2B2", true);
  }
}

function renderStepLines() {
  board.querySelectorAll(".step-line").forEach((el) => el.remove());
  const sorted = [...state.stepLines].sort((a, b) => a.y - b.y);
  sorted.forEach((line, idx) => {
    const el = document.createElement("div");
    el.className = "step-line";
    el.style.top = `${line.y}px`;
    el.dataset.id = String(line.id);
    const defaultLabel = `STEP ${idx + 1}`;
    const shownLabel = String(line.label || "").trim() || defaultLabel;

    const labelEl = document.createElement("span");
    labelEl.className = "step-label";
    labelEl.textContent = shownLabel;
    el.appendChild(labelEl);

    if (isEditable) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const toggle = e.metaKey || e.ctrlKey || e.shiftKey;
        if (toggle) {
          if (isStepLineSelected(line.id)) {
            setSelection(
              state.selectedNodeIds,
              state.selectedStepLineIds.filter((id) => id !== line.id)
            );
          } else {
            setSelection(state.selectedNodeIds, [...state.selectedStepLineIds, line.id]);
          }
        } else {
          setSelection([], [line.id]);
        }
      });
    }

    let drag = null;
    let dragBefore = null;
    let draggedNodeIds = [];
    let draggedLineIds = [];
    const startNodeY = new Map();
    const startLineY = new Map();

    if (isEditable) {
      el.addEventListener("pointerdown", (e) => {
        if (e.detail > 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (isStepLineSelected(line.id)) {
          draggedNodeIds = [...state.selectedNodeIds];
          draggedLineIds = [...state.selectedStepLineIds];
        } else {
          draggedNodeIds = [];
          draggedLineIds = [line.id];
        }
        dragBefore = cloneEditorState();
        drag = { sy: e.clientY, moved: false };

        draggedNodeIds.forEach((id) => {
          const n = nodeById(id);
          if (n) startNodeY.set(id, n.y);
        });
        draggedLineIds.forEach((id) => {
          const l = state.stepLines.find((s) => s.id === id);
          if (l) startLineY.set(id, l.y);
        });

        el.setPointerCapture(e.pointerId);
      });

      el.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const dy = e.clientY - drag.sy;
        const boardDy = dy / viewScale;
        if (boardDy !== 0) drag.moved = true;

        draggedNodeIds.forEach((id) => {
          const n = nodeById(id);
          if (!n) return;
          n.y = (startNodeY.get(id) || 0) + boardDy;
          clampNode(n);
        });

        draggedLineIds.forEach((id) => {
          const l = state.stepLines.find((s) => s.id === id);
          if (!l) return;
          l.y = Math.max(0, Math.min(BOARD_H, (startLineY.get(id) || 0) + boardDy));
        });
        syncDraggedVisuals(draggedNodeIds, draggedLineIds);
      });

      const finishDrag = (e) => {
        if (!drag) return;
        try {
          el.releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }

        draggedNodeIds.forEach((id) => {
          const n = nodeById(id);
          if (!n) return;
          const s = snapPoint(n.x, n.y);
          n.x = s.x;
          n.y = s.y;
          clampNode(n);
        });

        draggedLineIds.forEach((id) => {
          const l = state.stepLines.find((s) => s.id === id);
          if (!l) return;
          l.y = Math.max(0, Math.min(BOARD_H, snap(l.y)));
        });

        setSelection(draggedNodeIds, draggedLineIds);
        if (drag.moved && dragBefore) pushHistory(dragBefore);
        drag = null;
        dragBefore = null;
        render();
      };

      el.addEventListener("pointerup", finishDrag);
      el.addEventListener("pointercancel", finishDrag);
    }

    board.appendChild(el);
  });
}

function clientToBoard(clientX, clientY) {
  const rect = board.getBoundingClientRect();
  return { x: (clientX - rect.left) / viewScale, y: (clientY - rect.top) / viewScale };
}

function nodeIdFromClient(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  const card = el ? el.closest(".card") : null;
  if (!card) return null;
  const id = Number(card.dataset.id);
  return Number.isFinite(id) ? id : null;
}

function startLinkDrag(e, fromNodeId, fromSide, handleEl) {
  e.preventDefault();
  e.stopPropagation();

  const fromNode = nodeById(fromNodeId);
  if (!fromNode) return;

  const anchor = anchorFor(fromNode, fromSide);
  linkDraft.active = true;
  linkDraft.fromId = fromNodeId;
  linkDraft.fromSide = fromSide;
  linkDraft.toX = anchor.x;
  linkDraft.toY = anchor.y;
  linkDraft.targetId = null;
  linkDraft.targetEdgeKey = null;
  refreshLinkTargetUI();
  renderEdges();

  handleEl.setPointerCapture(e.pointerId);
  let moved = false;
  const startX = e.clientX;
  const startY = e.clientY;

  const onMove = (ev) => {
    if (!linkDraft.active) return;
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 6) moved = true;
    const p = clientToBoard(ev.clientX, ev.clientY);
    linkDraft.toX = p.x;
    linkDraft.toY = p.y;

    const target = nodeIdFromClient(ev.clientX, ev.clientY);
    linkDraft.targetId = target && target !== linkDraft.fromId ? target : null;
    const edgeKeyHit = edgeKeyFromClient(ev.clientX, ev.clientY);
    linkDraft.targetEdgeKey = edgeKeyHit || null;
    refreshLinkTargetUI();
    renderEdges();
  };

  const onUp = (ev) => {
    try {
      handleEl.releasePointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    const target = nodeIdFromClient(ev.clientX, ev.clientY);
    const toId = target && target !== linkDraft.fromId ? target : null;
    const toEdgeKey = edgeKeyFromClient(ev.clientX, ev.clientY);
    if (!moved) {
      createConnectedNode(linkDraft.fromId, linkDraft.fromSide);
    } else if (toId && !edgeExists(linkDraft.fromId, toId)) {
      pushHistory();
      upsertEdge(linkDraft.fromId, toId, linkDraft.fromSide, oppositeSide(linkDraft.fromSide));
      render();
    } else if (toEdgeKey && edgeByKey(toEdgeKey)) {
      if (!state.edgeArrows.some((a) => a.from === linkDraft.fromId && a.toEdgeKey === toEdgeKey)) {
        pushHistory();
        state.edgeArrows.push({ from: linkDraft.fromId, toEdgeKey });
      }
      render();
    }

    linkDraft.active = false;
    linkDraft.fromId = null;
    linkDraft.targetId = null;
    linkDraft.targetEdgeKey = null;
    refreshLinkTargetUI();
    render();

    handleEl.removeEventListener("pointermove", onMove);
    handleEl.removeEventListener("pointerup", onUp);
    handleEl.removeEventListener("pointercancel", onUp);
  };

  handleEl.addEventListener("pointermove", onMove);
  handleEl.addEventListener("pointerup", onUp);
  handleEl.addEventListener("pointercancel", onUp);
}

function applyMarqueeSelection() {
  const x1 = Math.min(marquee.sx, marquee.ex);
  const y1 = Math.min(marquee.sy, marquee.ey);
  const x2 = Math.max(marquee.sx, marquee.ex);
  const y2 = Math.max(marquee.sy, marquee.ey);

  const hitNodeIds = state.nodes
    .filter((n) => !(n.x + NODE_W < x1 || n.x > x2 || n.y + nodeHeight(n) < y1 || n.y > y2))
    .map((n) => n.id);
  const hitLineIds = state.stepLines
    .filter((l) => l.y >= y1 && l.y <= y2)
    .map((l) => l.id);
  const hitTextIds = state.texts
    .filter((t) => {
      const w = Number.isFinite(Number(t.w)) ? Number(t.w) : 220;
      const h = textHeight(t);
      return !(t.x + w < x1 || t.x > x2 || t.y + h < y1 || t.y > y2);
    })
    .map((t) => t.id);

  const hitEdgeKeys = state.edges
    .filter((edge) => {
      const from = nodeById(edge.from);
      const to = nodeById(edge.to);
      if (!from || !to) return false;
      const sides = resolveEdgeSides(edge, from, to);
      const fromSide = sides.fromSide;
      const toSide = sides.toSide;
      const a = anchorFor(from, fromSide);
      const b = anchorFor(to, toSide);
      const { c1, c2 } = bezierControls(a, fromSide, b, toSide);
      const c1x = c1.x;
      const c1y = c1.y;
      const c2x = c2.x;
      const c2y = c2.y;
      const minX = Math.min(a.x, b.x, c1x, c2x) - 6;
      const maxX = Math.max(a.x, b.x, c1x, c2x) + 6;
      const minY = Math.min(a.y, b.y, c1y, c2y) - 6;
      const maxY = Math.max(a.y, b.y, c1y, c2y) + 6;
      return !(maxX < x1 || minX > x2 || maxY < y1 || minY > y2);
    })
    .map((edge) => edgeKey(edge));

  if (marquee.additive) {
    state.selectedNodeIds = uniqueIntArray([...marquee.baseNodeIds, ...hitNodeIds]);
    state.selectedStepLineIds = uniqueIntArray([...marquee.baseStepLineIds, ...hitLineIds]);
    state.selectedTextIds = uniqueIntArray([...marquee.baseTextIds, ...hitTextIds]);
    state.selectedEdgeKeys = Array.from(new Set([...marquee.baseEdgeKeys, ...hitEdgeKeys]));
  } else {
    state.selectedNodeIds = uniqueIntArray(hitNodeIds);
    state.selectedStepLineIds = uniqueIntArray(hitLineIds);
    state.selectedTextIds = uniqueIntArray(hitTextIds);
    state.selectedEdgeKeys = Array.from(new Set(hitEdgeKeys));
  }
  refreshSelectionUI();
}

function startMarqueeSelection(e) {
  if (e.target !== board) return;
  if (linkDraft.active) return;

  marquee.active = true;
  marquee.additive = e.shiftKey || e.metaKey || e.ctrlKey;
  marquee.baseNodeIds = [...state.selectedNodeIds];
  marquee.baseStepLineIds = [...state.selectedStepLineIds];
  marquee.baseTextIds = [...state.selectedTextIds];
  marquee.baseEdgeKeys = [...state.selectedEdgeKeys];

  const p = clientToBoard(e.clientX, e.clientY);
  marquee.sx = p.x;
  marquee.sy = p.y;
  marquee.ex = p.x;
  marquee.ey = p.y;

  const box = document.createElement("div");
  box.className = "selection-box";
  box.style.left = `${p.x}px`;
  box.style.top = `${p.y}px`;
  box.style.width = "0px";
  box.style.height = "0px";
  marquee.el = box;
  board.appendChild(box);

  board.setPointerCapture(e.pointerId);

  const onMove = (ev) => {
    if (!marquee.active) return;
    const q = clientToBoard(ev.clientX, ev.clientY);
    marquee.ex = q.x;
    marquee.ey = q.y;

    const x = Math.min(marquee.sx, marquee.ex);
    const y = Math.min(marquee.sy, marquee.ey);
    const w = Math.abs(marquee.ex - marquee.sx);
    const h = Math.abs(marquee.ey - marquee.sy);
    marquee.el.style.left = `${x}px`;
    marquee.el.style.top = `${y}px`;
    marquee.el.style.width = `${w}px`;
    marquee.el.style.height = `${h}px`;

    applyMarqueeSelection();
  };

  const onUp = (ev) => {
    if (!marquee.active) return;
    try {
      board.releasePointerCapture(ev.pointerId);
    } catch {
      // ignore
    }

    const w = Math.abs(marquee.ex - marquee.sx);
    const h = Math.abs(marquee.ey - marquee.sy);
    if (w < 4 && h < 4 && !marquee.additive) {
      clearSelection();
    }

    if (marquee.el) marquee.el.remove();
    marquee.el = null;
    marquee.active = false;

    board.removeEventListener("pointermove", onMove);
    board.removeEventListener("pointerup", onUp);
    board.removeEventListener("pointercancel", onUp);
  };

  board.addEventListener("pointermove", onMove);
  board.addEventListener("pointerup", onUp);
  board.addEventListener("pointercancel", onUp);
}

function applyGroupMove(dx, dy, nodeIds, lineIds, startNodeMap, startLineMap) {
  nodeIds.forEach((id) => {
    const n = nodeById(id);
    if (!n) return;
    n.x = (startNodeMap.get(id)?.x ?? n.x) + dx;
    n.y = (startNodeMap.get(id)?.y ?? n.y) + dy;
    clampNode(n);
  });
  lineIds.forEach((id) => {
    const l = state.stepLines.find((s) => s.id === id);
    if (!l) return;
    l.y = Math.max(0, Math.min(BOARD_H, (startLineMap.get(id) ?? l.y) + dy));
  });
}

function applyTextGroupMove(dx, dy, textIds, startTextMap) {
  textIds.forEach((id) => {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    const s = startTextMap.get(id);
    if (!s) return;
    t.x = s.x + dx;
    t.y = s.y + dy;
    clampText(t);
  });
}

function snapGroup(nodeIds, lineIds) {
  nodeIds.forEach((id) => {
    const n = nodeById(id);
    if (!n) return;
    const s = snapPoint(n.x, n.y);
    n.x = s.x;
    n.y = s.y;
    clampNode(n);
  });
  lineIds.forEach((id) => {
    const l = state.stepLines.find((s) => s.id === id);
    if (!l) return;
    l.y = Math.max(0, Math.min(BOARD_H, snap(l.y)));
  });
}

function snapTextGroup(textIds) {
  textIds.forEach((id) => {
    const t = state.texts.find((x) => x.id === id);
    if (!t) return;
    const s = snapPoint(t.x, t.y);
    t.x = s.x;
    t.y = s.y;
    clampText(t);
  });
}

function syncDraggedVisuals(nodeIds, lineIds) {
  nodeIds.forEach((id) => {
    const node = nodeById(id);
    const el = board.querySelector(`.card[data-id="${id}"]`);
    if (!node || !el) return;
    placeNodeEl(el, node);
  });
  lineIds.forEach((id) => {
    const line = state.stepLines.find((s) => s.id === id);
    const el = board.querySelector(`.step-line[data-id="${id}"]`);
    if (!line || !el) return;
    el.style.top = `${line.y}px`;
  });
  renderEdges();
  refreshJsonText();
}

function syncDraggedTextVisuals(textIds) {
  textIds.forEach((id) => {
    const t = state.texts.find((x) => x.id === id);
    const el = board.querySelector(`.text-item[data-id="${id}"]`);
    if (!t || !el) return;
    el.style.left = `${t.x}px`;
    el.style.top = `${t.y}px`;
  });
  refreshJsonText();
}

async function saveRecipe(opts = {}) {
  if (!isEditable) return false;
  const silent = Boolean(opts.silent);
  const desiredRaw = (currentRecipeLabel || "").trim() || "タイトルなし";
  let saveName = currentRecipeName || desiredRaw;

  if (!currentRecipeName) {
    if (recipeNames.includes(saveName)) {
      let i = 2;
      while (recipeNames.includes(`${desiredRaw} (${i})`)) i += 1;
      saveName = `${desiredRaw} (${i})`;
    }
  } else if (desiredRaw !== currentRecipeName) {
    if (recipeNames.includes(desiredRaw) && desiredRaw !== currentRecipeName) {
      if (!silent) alert("同名のレシピが既にあります");
      return false;
    }
    saveName = desiredRaw;
  }

  const saveRes = await fetch(withEditorKey("api/recipes"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: saveName, content: snapshot() }),
  });

  if (!saveRes.ok) {
    if (!silent) alert("保存に失敗しました");
    return false;
  }

  if (currentRecipeName && currentRecipeName !== saveName) {
    await fetch(withEditorKey(`api/recipes/${encodeURIComponent(currentRecipeName)}`), { method: "DELETE" });
  }

  currentRecipeName = saveName;
  currentRecipeLabel = saveName;
  refreshRecipeTitle();
  draftListIndex = null;
  hasDraftRecipe = false;
  markSavedNow();
  await refreshRecipeList(currentRecipeName);
  return true;
}

function buildNodeElement(node) {
  const el = cardTpl.content.firstElementChild.cloneNode(true);
  const titleEl = el.querySelector(".title");
  const tagRowEl = el.querySelector(".tag-row");
  const tagListEl = el.querySelector(".tag-list");
  const addTagBtn = el.querySelector(".add-tag");
  const memoRowEl = el.querySelector(".memo-row");
  const memoListEl = el.querySelector(".memo-list");
  const memoEditorEl = el.querySelector(".memo-editor");
  const timeBadgeEl = el.querySelector(".time-badge");
  const timeInputEl = el.querySelector(".time-input");
  const timeSwitchBtn = el.querySelector(".time-switch");
  const colorSwitchBtn = el.querySelector(".color-switch");
  const deleteBtn = el.querySelector(".delete");
  const bottomConnector = el.querySelector('.connector[data-side="bottom"]');

  el.dataset.id = String(node.id);
  titleEl.value = node.title || "";
  node.color = normalizeNodeColor(node.color);
  node.time = normalizeNodeTime(node.time);
  node.tags = normalizeNodeTags(node.tags);
  node.memos = normalizeNodeMemos(node.memos);
  node.h = nodeHeight(node);
  placeNodeEl(el, node);
  el.style.height = "auto";

  const renderModeUI = () => {
    tagRowEl.classList.remove("hidden");
    memoRowEl.classList.remove("hidden");
    titleEl.placeholder = "材料とか工程とか";
  };

  const renderColorUI = () => {
    el.classList.toggle("tone-green", node.color === "green");
    el.classList.toggle("tone-orange", node.color === "orange");
  };

  const renderMetaStateUI = () => {
    el.classList.toggle("meta-empty", node.tags.length === 0 && node.memos.length === 0);
  };

  const renderTimeUI = () => {
    const v = normalizeNodeTime(node.time);
    node.time = v;
    el.classList.toggle("has-time", Boolean(v));
    if (!v) {
      timeBadgeEl.classList.add("hidden");
      timeBadgeEl.textContent = "";
      return;
    }
    timeBadgeEl.textContent = v;
    timeBadgeEl.classList.remove("hidden");
  };

  let heightSyncRaf = 0;
  const syncNodeHeight = () => {
    heightSyncRaf = 0;
    const measured = Math.max(NODE_MIN_H, Math.ceil(el.getBoundingClientRect().height));
    if (node.h !== measured) {
      node.h = measured;
      clampNode(node);
      placeNodeEl(el, node);
      renderEdges();
      refreshJsonText();
    }
  };
  const scheduleNodeHeightSync = () => {
    if (heightSyncRaf) return;
    heightSyncRaf = requestAnimationFrame(syncNodeHeight);
  };

  const renderTagList = () => {
    tagListEl.innerHTML = "";
    node.tags.forEach((tag, index) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-chip";
      chip.title = "クリックで編集";
      chip.textContent = tag;
      chip.addEventListener("click", () => {
        startTagEdit(index);
      });
      tagListEl.appendChild(chip);
    });
    const canAdd = node.tags.length < 3;
    if (canAdd) {
      tagListEl.appendChild(addTagBtn);
      addTagBtn.title = "タグ追加";
    }
    renderMetaStateUI();
    scheduleNodeHeightSync();
  };

  const renderMemoList = () => {
    memoListEl.innerHTML = "";
    node.memos.forEach((memo) => {
      const item = document.createElement("span");
      item.className = "memo-item";
      item.textContent = memo;
      memoListEl.appendChild(item);
    });
    memoEditorEl.value = node.memos[0] || "";
    renderMetaStateUI();
    scheduleNodeHeightSync();
  };

  renderModeUI();
  renderColorUI();
  renderTimeUI();
  renderTagList();
  renderMemoList();
  renderMetaStateUI();
  scheduleNodeHeightSync();

  if (!isEditable) {
    titleEl.readOnly = true;
    titleEl.tabIndex = -1;
    memoEditorEl.readOnly = true;
    memoEditorEl.tabIndex = -1;
    memoEditorEl.classList.add("hidden");
    addTagBtn.classList.add("hidden");
    bottomConnector.classList.add("hidden");
    el.querySelector(".node-side-actions")?.classList.add("hidden");
    timeInputEl.classList.add("hidden");
    board.appendChild(el);
    return;
  }

  bottomConnector.addEventListener("pointerdown", (e) => startLinkDrag(e, node.id, "bottom", bottomConnector));

  titleEl.addEventListener("focus", () => {
    setSelection([node.id], []);
  });

  let titleBeforeEdit = null;
  titleEl.addEventListener("focus", () => {
    titleBeforeEdit = cloneEditorState();
  });
  titleEl.addEventListener("input", (e) => {
    node.title = e.target.value;
    refreshJsonText();
    scheduleNodeHeightSync();
  });
  titleEl.addEventListener("blur", () => {
    if (!titleBeforeEdit) return;
    const beforeNode = titleBeforeEdit.nodes.find((n) => n.id === node.id);
    if (beforeNode && beforeNode.title !== node.title) pushHistory(titleBeforeEdit);
    titleBeforeEdit = null;
  });

  titleEl.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      await saveRecipe({ silent: true });
      titleEl.blur();
      clearSelection();
    }
  });

  const addTag = (value) => {
    const v = String(value || "").trim();
    if (!v) return;
    if (node.tags.length >= 3) return;
    const before = cloneEditorState();
    node.tags = normalizeNodeTags([...node.tags, v]);
    pushHistory(before);
    refreshJsonText();
    renderTagList();
  };

  let inlineTagInput = null;
  let inlineTagEditIndex = null;
  const closeInlineTagInput = (commit = false) => {
    if (!inlineTagInput) return;
    const value = inlineTagInput.value;
    inlineTagInput.remove();
    inlineTagInput = null;
    const editIndex = inlineTagEditIndex;
    inlineTagEditIndex = null;
    if (commit) {
      const v = String(value || "").trim();
      if (editIndex == null) {
        addTag(v);
      } else {
        const before = cloneEditorState();
        if (!v) {
          node.tags.splice(editIndex, 1);
        } else {
          node.tags[editIndex] = v;
        }
        node.tags = normalizeNodeTags(node.tags);
        pushHistory(before);
        refreshJsonText();
        renderTagList();
      }
    } else {
      renderTagList();
    }
    scheduleNodeHeightSync();
  };

  const startTagEdit = (index = null) => {
    if (inlineTagInput) {
      inlineTagInput.focus();
      return;
    }
    inlineTagEditIndex = Number.isInteger(index) ? index : null;
    inlineTagInput = document.createElement("input");
    inlineTagInput.type = "text";
    inlineTagInput.className = "tag-inline-input";
    inlineTagInput.placeholder = "tag";
    if (inlineTagEditIndex != null) {
      inlineTagInput.value = node.tags[inlineTagEditIndex] || "";
      const chips = Array.from(tagListEl.querySelectorAll(".tag-chip"));
      const target = chips[inlineTagEditIndex];
      if (target) target.replaceWith(inlineTagInput);
      else addTagBtn.replaceWith(inlineTagInput);
    } else {
      addTagBtn.replaceWith(inlineTagInput);
    }
    inlineTagInput.focus();
    inlineTagInput.select();

    inlineTagInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        closeInlineTagInput(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeInlineTagInput(false);
      }
    });
    inlineTagInput.addEventListener("blur", () => {
      closeInlineTagInput(true);
    });
  };

  let memoBeforeEdit = null;
  let memoBeforeState = null;

  addTagBtn.addEventListener("click", () => {
    if (node.tags.length >= 3) return;
    setSelection([node.id], []);
    startTagEdit(null);
  });

  memoEditorEl.addEventListener("focus", () => {
    setSelection([node.id], []);
    memoBeforeEdit = node.memos[0] || "";
    memoBeforeState = cloneEditorState();
  });
  memoEditorEl.addEventListener("input", () => {
    const v = memoEditorEl.value.trim();
    node.memos = v ? [v] : [];
    refreshJsonText();
    scheduleNodeHeightSync();
  });
  memoEditorEl.addEventListener("blur", () => {
    const before = memoBeforeEdit || "";
    const now = node.memos[0] || "";
    if (before !== now && memoBeforeState) pushHistory(memoBeforeState);
    memoBeforeEdit = null;
    memoBeforeState = null;
    renderMemoList();
  });
  memoEditorEl.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      memoEditorEl.blur();
    }
  });

  colorSwitchBtn.addEventListener("click", () => {
    const before = cloneEditorState();
    if (node.color === "gray") node.color = "green";
    else if (node.color === "green") node.color = "orange";
    else node.color = "gray";
    pushHistory(before);
    refreshJsonText();
    renderColorUI();
  });

  const closeTimeInput = (commit = false) => {
    if (timeInputEl.classList.contains("hidden")) return;
    const next = timeInputEl.value.trim();
    timeInputEl.classList.add("hidden");
    if (commit) {
      const before = cloneEditorState();
      node.time = next;
      pushHistory(before);
      refreshJsonText();
      renderTimeUI();
    }
    scheduleNodeHeightSync();
  };

  const openTimeInput = () => {
    setSelection([node.id], []);
    timeInputEl.classList.remove("hidden");
    timeInputEl.value = node.time || "";
    timeInputEl.focus();
    timeInputEl.select();
  };

  timeSwitchBtn.addEventListener("click", () => {
    openTimeInput();
  });
  timeBadgeEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openTimeInput();
  });
  timeBadgeEl.addEventListener("click", (e) => {
    e.stopPropagation();
    openTimeInput();
  });
  timeInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      closeTimeInput(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeTimeInput(false);
    }
  });
  timeInputEl.addEventListener("blur", () => {
    closeTimeInput(true);
  });

  el.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    const toggle = e.metaKey || e.ctrlKey || e.shiftKey;
    if (toggle) {
      if (isNodeSelected(node.id)) {
        setSelection(
          state.selectedNodeIds.filter((id) => id !== node.id),
          state.selectedStepLineIds
        );
      } else {
        setSelection([...state.selectedNodeIds, node.id], state.selectedStepLineIds);
      }
    } else {
      setSelection([node.id], []);
    }
  });

  deleteBtn.addEventListener("click", () => {
    pushHistory();
    const removedEdgeKeys = new Set(
      state.edges
        .filter((e) => e.from === node.id || e.to === node.id)
        .map((e) => edgeKey(e))
    );
    state.nodes = state.nodes.filter((n) => n.id !== node.id);
    state.edges = state.edges.filter((e) => e.from !== node.id && e.to !== node.id);
    state.edgeArrows = state.edgeArrows.filter((a) => a.from !== node.id && !removedEdgeKeys.has(a.toEdgeKey));
    state.selectedNodeIds = state.selectedNodeIds.filter((id) => id !== node.id);
    render();
  });

  let drag = null;
  let dragBefore = null;
  let draggedNodeIds = [];
  let draggedLineIds = [];
  const startNodeMap = new Map();
  const startLineMap = new Map();

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest("input,textarea,button")) return;

    if (isNodeSelected(node.id)) {
      draggedNodeIds = [...state.selectedNodeIds];
      draggedLineIds = [...state.selectedStepLineIds];
    } else {
      draggedNodeIds = [node.id];
      draggedLineIds = [];
    }

    dragBefore = cloneEditorState();
    drag = { sx: e.clientX, sy: e.clientY, moved: false };

    startNodeMap.clear();
    startLineMap.clear();
    draggedNodeIds.forEach((id) => {
      const n = nodeById(id);
      if (n) startNodeMap.set(id, { x: n.x, y: n.y });
    });
    draggedLineIds.forEach((id) => {
      const l = state.stepLines.find((s) => s.id === id);
      if (l) startLineMap.set(id, l.y);
    });

    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    const boardDx = dx / viewScale;
    const boardDy = dy / viewScale;
    if (boardDx !== 0 || boardDy !== 0) drag.moved = true;

    applyGroupMove(boardDx, boardDy, draggedNodeIds, draggedLineIds, startNodeMap, startLineMap);
    syncDraggedVisuals(draggedNodeIds, draggedLineIds);
  });

  const finishDrag = (e) => {
    if (!drag) return;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    snapGroup(draggedNodeIds, draggedLineIds);
    setSelection(draggedNodeIds, draggedLineIds);
    if (drag.moved && dragBefore) pushHistory(dragBefore);
    drag = null;
    dragBefore = null;
    render();
  };

  el.addEventListener("pointerup", finishDrag);
  el.addEventListener("pointercancel", finishDrag);

  board.appendChild(el);
}

function renderNodes() {
  board.querySelectorAll(".card").forEach((el) => el.remove());
  state.nodes.forEach((node) => buildNodeElement(node));
}

function buildTextElement(textItem) {
  const el = document.createElement("div");
  el.className = "text-item";
  el.dataset.id = String(textItem.id);
  textItem.w = NODE_W;
  if (!Number.isFinite(Number(textItem.h))) textItem.h = 26;
  clampText(textItem);
  el.style.left = `${textItem.x}px`;
  el.style.top = `${textItem.y}px`;
  el.style.width = `${NODE_W}px`;

  const dragHit = document.createElement("div");
  dragHit.className = "text-drag-hit";
  el.appendChild(dragHit);

  const input = document.createElement("textarea");
  input.className = "text-input";
  input.rows = 1;
  input.wrap = "off";
  input.placeholder = "テキストを入力";
  input.value = textItem.text || "";
  input.style.height = `${textHeight(textItem)}px`;
  el.appendChild(input);
  const renderTextTone = () => {
    el.classList.toggle("is-bold", Boolean(textItem.bold));
  };

  const resize = () => {
    textItem.w = NODE_W;
    el.style.width = `${NODE_W}px`;
    input.style.height = "0px";
    const cs = window.getComputedStyle(input);
    const lineH = parseFloat(cs.lineHeight) || 16;
    const nextH = Math.max(Math.ceil(lineH) + 4, Math.ceil(input.scrollHeight) + 2);
    input.style.height = `${nextH}px`;
    if (textItem.h !== nextH) {
      textItem.h = nextH;
      clampText(textItem);
      el.style.left = `${textItem.x}px`;
      el.style.top = `${textItem.y}px`;
      refreshJsonText();
    }
    clampText(textItem);
    el.style.left = `${textItem.x}px`;
    el.style.top = `${textItem.y}px`;
  };
  renderTextTone();

  if (!isEditable) {
    input.readOnly = true;
    input.tabIndex = -1;
    board.appendChild(el);
    resize();
    return;
  }

  input.addEventListener("focus", () => {
    state.selectedNodeIds = [];
    state.selectedStepLineIds = [];
    state.selectedTextIds = [textItem.id];
    state.selectedEdgeKeys = [];
    refreshSelectionUI();
    resize();
  });

  let beforeText = null;
  let beforeState = null;
  input.addEventListener("focus", () => {
    beforeText = textItem.text || "";
    beforeState = cloneEditorState();
  });
  input.addEventListener("input", () => {
    textItem.text = input.value;
    resize();
    refreshJsonText();
  });
  input.addEventListener("blur", () => {
    if (beforeState && beforeText !== (textItem.text || "")) pushHistory(beforeState);
    beforeText = null;
    beforeState = null;
  });
  input.addEventListener("keydown", (e) => {
    const isBold = (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "b";
    if (!isBold) return;
    e.preventDefault();
    const before = cloneEditorState();
    textItem.bold = !Boolean(textItem.bold);
    pushHistory(before);
    renderTextTone();
    refreshJsonText();
  });

  el.addEventListener("click", (e) => {
    const toggle = e.metaKey || e.ctrlKey || e.shiftKey;
    if (toggle) {
      if (isTextSelected(textItem.id)) {
        state.selectedTextIds = state.selectedTextIds.filter((id) => id !== textItem.id);
      } else {
        state.selectedTextIds = uniqueIntArray([...state.selectedTextIds, textItem.id]);
      }
      refreshSelectionUI();
      return;
    }
    state.selectedNodeIds = [];
    state.selectedStepLineIds = [];
    state.selectedTextIds = [textItem.id];
    state.selectedEdgeKeys = [];
    refreshSelectionUI();
  });

  let drag = null;
  let dragBefore = null;
  let draggedTextIds = [];
  const startTextMap = new Map();

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".text-input")) return;
    if (isTextSelected(textItem.id)) {
      draggedTextIds = [...state.selectedTextIds];
    } else {
      draggedTextIds = [textItem.id];
    }
    dragBefore = cloneEditorState();
    drag = { sx: e.clientX, sy: e.clientY, moved: false };
    startTextMap.clear();
    draggedTextIds.forEach((id) => {
      const t = state.texts.find((x) => x.id === id);
      if (t) startTextMap.set(id, { x: t.x, y: t.y });
    });
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    const boardDx = dx / viewScale;
    const boardDy = dy / viewScale;
    if (boardDx !== 0 || boardDy !== 0) drag.moved = true;
    applyTextGroupMove(boardDx, boardDy, draggedTextIds, startTextMap);
    syncDraggedTextVisuals(draggedTextIds);
  });

  const finish = (e) => {
    if (!drag) return;
    try {
      el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (drag.moved) {
      snapTextGroup(draggedTextIds);
    }
    state.selectedNodeIds = [];
    state.selectedStepLineIds = [];
    state.selectedTextIds = [...draggedTextIds];
    state.selectedEdgeKeys = [];
    refreshSelectionUI();
    if (drag.moved && dragBefore) {
      pushHistory(dragBefore);
      render();
    }
    drag = null;
    dragBefore = null;
  };

  el.addEventListener("pointerup", finish);
  el.addEventListener("pointercancel", finish);
  board.appendChild(el);
}

function renderTexts() {
  board.querySelectorAll(".text-item").forEach((el) => el.remove());
  state.texts.forEach((t) => buildTextElement(t));
}

function render() {
  renderStepLines();
  renderTexts();
  renderNodes();
  renderEdges();
  refreshJsonText();
  refreshSelectionUI();
  refreshLinkTargetUI();
}

function viewportSpawnPosition() {
  const left = boardWrap ? boardWrap.scrollLeft / viewScale : 0;
  const top = boardWrap ? boardWrap.scrollTop / viewScale : 0;
  const vw = boardWrap ? boardWrap.clientWidth / viewScale : 900;
  const vh = boardWrap ? boardWrap.clientHeight / viewScale : 500;
  return {
    x: left + Math.max(24, (vw - NODE_W) / 2),
    y: top + Math.max(24, (vh - NODE_H) / 2),
  };
}

function nextRootPosition() {
  const base = viewportSpawnPosition();
  const count = state.nodes.length;
  return {
    x: base.x + (count % 3) * 26,
    y: base.y + (count % 3) * 22,
  };
}

function addNode() {
  if (!isEditable) return;
  pushHistory();
  const pos = nextRootPosition();
  const node = { id: state.nextId, x: snap(pos.x), y: snap(pos.y), h: NODE_H, title: "", mode: "material", color: "gray", time: "", tags: [], memos: [] };
  clampNode(node);
  state.nodes.push(node);
  state.nextId += 1;
  setSelection([node.id], []);
  render();
}

function addText() {
  if (!isEditable) return;
  pushHistory();
  const pos = nextRootPosition();
  const textItem = {
    id: state.nextTextId,
    x: snap(pos.x),
    y: snap(pos.y),
    w: 220,
    h: 22,
    text: "",
    bold: false,
  };
  clampText(textItem);
  state.texts.push(textItem);
  state.nextTextId += 1;
  state.selectedNodeIds = [];
  state.selectedStepLineIds = [];
  state.selectedTextIds = [textItem.id];
  state.selectedEdgeKeys = [];
  render();
}

function addStepLineAt(y) {
  if (!isEditable) return;
  let yy = Math.max(0, Math.min(BOARD_H, snap(y)));
  if (state.stepLines.some((line) => line.y === yy)) {
    for (let i = 1; i < 400; i += 1) {
      const down = Math.max(0, Math.min(BOARD_H, yy + i * GRID_SIZE));
      if (!state.stepLines.some((line) => line.y === down)) {
        yy = down;
        break;
      }
      const up = Math.max(0, Math.min(BOARD_H, yy - i * GRID_SIZE));
      if (!state.stepLines.some((line) => line.y === up)) {
        yy = up;
        break;
      }
    }
  }
  pushHistory();
  state.stepLines.push({ id: state.nextStepLineId, y: yy, label: "" });
  setSelection([], [state.nextStepLineId]);
  state.nextStepLineId += 1;
  render();
}

async function refreshRecipeList(selectedName = currentRecipeName) {
  clearArmedRecipeDelete();
  const res = await fetch("api/recipes");
  const items = await res.json();
  recipeNames = items.map((item) => item.name);
  recipeItemsEl.innerHTML = "";
  if (recipeDropIndicator) recipeDropIndicator.classList.remove("is-visible");

  const listKeys = [...recipeNames];
  if (hasDraftRecipe) {
    const insertAt = Number.isInteger(draftListIndex)
      ? Math.max(0, Math.min(recipeNames.length, draftListIndex))
      : recipeNames.length;
    listKeys.splice(insertAt, 0, "__draft__");
  }
  listKeys.forEach((key) => {
    const name = key === "__draft__" ? currentRecipeLabel : key;
    const li = document.createElement("li");
    li.draggable = isEditable;
    li.dataset.key = key;
    li.dataset.name = name;
    const row = document.createElement("div");
    row.className = "recipe-row";
    const btn = document.createElement("button");
    btn.className = "recipe-item-btn";
    btn.dataset.key = key;
    btn.dataset.name = name;
    btn.textContent = name;
    btn.classList.toggle("active", key === (selectedName || "__draft__"));
    const activateRecipe = async () => {
      if (key === "__draft__" && !currentRecipeName) return;
      if (key === currentRecipeName) return;
      const proceed = await confirmSaveIfEditing();
      if (!proceed) return;
      if (key === "__draft__") {
        resetToNewRecipe();
        await refreshRecipeList("__draft__");
      } else {
        await loadRecipe(key);
        await refreshRecipeList(key);
      }
    };
    btn.addEventListener("click", activateRecipe);
    row.addEventListener("click", async (event) => {
      if (event.target.closest(".recipe-remove-btn, .recipe-item-edit")) return;
      await activateRecipe();
    });

    if (isEditable) {
      li.addEventListener("dblclick", () => {
        const currentKey = currentRecipeName || "__draft__";
        if (key !== currentKey) return;
        editingRecipeKey = key;
        refreshRecipeList(currentKey);
      });
    }

    if (isEditable) {
      li.addEventListener("dragstart", (event) => {
        if (suppressRecipeDrag) {
          event.preventDefault();
          return;
        }
        if (event.target.closest(".recipe-remove-btn, .recipe-item-edit")) {
          event.preventDefault();
          return;
        }
        draggingRecipeName = key;
        li.classList.add("is-dragging");
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", key);
        }
      });

      li.addEventListener("dragend", () => {
        draggingRecipeName = null;
        li.classList.remove("is-dragging");
        if (recipeDropIndicator) recipeDropIndicator.classList.remove("is-visible");
      });
    }

    if (editingRecipeKey === key) {
      const input = document.createElement("input");
      input.className = "recipe-item-edit";
      input.value = currentRecipeLabel;
      let committed = false;
      const commit = async () => {
        if (committed) return;
        committed = true;
        const next = input.value.trim() || "タイトルなし";
        currentRecipeLabel = next;
        editingRecipeKey = null;
        if (currentRecipeName) {
          const ok = await saveRecipe({ silent: true });
          if (!ok) {
            currentRecipeLabel = currentRecipeName;
            alert("名称変更を反映できませんでした");
          }
        }
        await refreshRecipeList(currentRecipeName || "__draft__");
      };
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.isComposing) {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          editingRecipeKey = null;
          refreshRecipeList(currentRecipeName || "__draft__");
        }
      });
      input.addEventListener("blur", () => {
        commit();
      });
      row.appendChild(input);
      setTimeout(() => {
        input.focus();
        input.select();
      }, 0);
    } else {
      row.appendChild(btn);
    }

    if (isEditable) {
      const removeBtn = document.createElement("button");
      removeBtn.className = "recipe-remove-btn";
      removeBtn.type = "button";
      removeBtn.textContent = "-";
      removeBtn.title = "削除";
      removeBtn.dataset.name = key === "__draft__" ? "" : key;
      removeBtn.dataset.key = key;
      removeBtn.draggable = false;
      const runDelete = async () => {
        clearArmedRecipeDelete();
        if (key === "__draft__") {
          await deleteDraftRecipe();
        } else {
          await deleteRecipeByName(key);
        }
      };
      removeBtn.addEventListener("pointerdown", (event) => {
        suppressRecipeDrag = true;
        event.stopPropagation();
      });
      removeBtn.addEventListener("pointerup", (event) => {
        suppressRecipeDrag = false;
        event.stopPropagation();
      });
      removeBtn.addEventListener("pointercancel", () => {
        suppressRecipeDrag = false;
      });
      removeBtn.addEventListener("dragstart", (event) => {
        event.preventDefault();
      });
      removeBtn.addEventListener("click", async (event) => {
        suppressRecipeDrag = false;
        event.stopPropagation();
        if (armedRecipeDeleteKey !== key) {
          clearArmedRecipeDelete();
          armedRecipeDeleteKey = key;
          removeBtn.classList.add("is-armed");
          removeBtn.textContent = "!";
          removeBtn.title = "もう一度押すと削除";
          armedRecipeDeleteTimer = setTimeout(() => {
            clearArmedRecipeDelete();
          }, 1800);
          return;
        }
        await runDelete();
      });

      row.appendChild(removeBtn);
    }
    li.appendChild(row);
    recipeItemsEl.appendChild(li);
  });
  refreshRecipeTitle();
  refreshRecipeDirtyIndicator();
}

async function deleteRecipeByName(name) {
  if (!isEditable) return;
  if (!name) return;
  const res = await fetch(withEditorKey(`api/recipes/${encodeURIComponent(name)}`), { method: "DELETE" });
  if (!res.ok) {
    alert("削除に失敗しました");
    return;
  }
  if (name === currentRecipeName) {
    const resList = await fetch("api/recipes");
    const items = await resList.json();
    const names = items.map((item) => item.name);
    if (names.length > 0) {
      await loadRecipe(names[0]);
      await refreshRecipeList(names[0]);
    } else {
      clearEditorToEmpty();
      await refreshRecipeList("");
    }
    return;
  }
  await refreshRecipeList(currentRecipeName);
}

async function deleteDraftRecipe() {
  clearEditorToEmpty();

  if (recipeNames.length > 0) {
    await loadRecipe(recipeNames[0]);
    await refreshRecipeList(currentRecipeName);
    return;
  }
  await refreshRecipeList("");
}

function refreshRecipeDirtyIndicator() {
  const dirty = isEditable && hasUnsavedChanges();
  recipeItemsEl.querySelectorAll(".recipe-item-btn").forEach((btn) => {
    const key = btn.dataset.key || "";
    const currentKey = currentRecipeName || "__draft__";
    const isCurrentDirty = dirty && key === currentKey;
    btn.classList.toggle("dirty", isCurrentDirty);
    const baseName = btn.dataset.name || "";
    btn.textContent = baseName;
  });
}

function setJsonStatus(message, isError = false) {
  if (!jsonStatus) return;
  jsonStatus.textContent = message || "";
  jsonStatus.classList.toggle("error", Boolean(isError));
}

function applyNormalizedContent(normalized) {
  state.nodes = normalized.nodes;
  state.edges = normalized.edges;
  state.edgeArrows = normalized.edgeArrows || [];
  state.stepLines = normalized.stepLines || [];
  state.texts = normalized.texts || [];
  state.nextId = normalized.nextId;
  state.nextStepLineId = normalized.nextStepLineId || 1;
  state.nextTextId = normalized.nextTextId || 1;
  state.selectedNodeIds = [];
  state.selectedStepLineIds = [];
  state.selectedTextIds = [];
  historyStack.length = 0;
  render();
}

function applyJsonEditorText() {
  if (!jsonOutput) return;
  let parsed;
  try {
    parsed = JSON.parse(jsonOutput.value);
  } catch (err) {
    setJsonStatus("JSONの形式が不正です", true);
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    setJsonStatus("JSONオブジェクトを入力してください", true);
    return;
  }

  const normalized = convertLegacyContent(parsed);
  applyNormalizedContent(normalized);
  setJsonStatus("JSONを反映しました");
}

async function confirmSaveIfEditing() {
  if (!isEditable) return true;
  if (!hasUnsavedChanges()) return true;
  const shouldSave = confirm("編集中のレシピがあります。保存しますか？");
  if (!shouldSave) return true;
  const ok = await saveRecipe({ silent: true });
  return Boolean(ok);
}

function normalizeEdges(edges) {
  if (!Array.isArray(edges)) return [];
  return edges
    .filter((e) => Number.isFinite(Number(e.from)) && Number.isFinite(Number(e.to)))
    .map((e) => ({
      from: Number(e.from),
      to: Number(e.to),
      fromSide: e.fromSide === "top" ? "top" : "bottom",
      toSide: e.toSide === "bottom" ? "bottom" : "top",
    }));
}

function convertLegacyContent(data) {
  if (Array.isArray(data.nodes)) {
    const nodes = data.nodes.map((n, i) => ({
      id: Number.isFinite(Number(n.id)) ? Number(n.id) : i + 1,
      x: Number.isFinite(n.x) ? n.x : 24,
      y: Number.isFinite(n.y) ? n.y : 24,
      h: Number.isFinite(Number(n.h)) ? Number(n.h) : NODE_H,
      title: n.title || "",
      mode: normalizeNodeMode(n.mode),
      color: normalizeNodeColor(n.color),
      time: normalizeNodeTime(n.time),
      tags: normalizeNodeTags(n.tags),
      memos: normalizeNodeMemos(n.memos),
    }));
    nodes.forEach(clampNode);
    const maxId = nodes.reduce((m, n) => Math.max(m, n.id), 0);
    const stepLines = Array.isArray(data.stepLines)
      ? data.stepLines
          .map((line, i) => ({
            id: Number.isFinite(Number(line.id)) ? Number(line.id) : i + 1,
            y: snap(Number(line.y) || 0),
            label: String(line.label || "").trim(),
          }))
          .filter((line) => line.y >= 0 && line.y <= BOARD_H)
      : [];
    const texts = Array.isArray(data.texts)
      ? data.texts
          .map((t, i) => ({
            id: Number.isFinite(Number(t.id)) ? Number(t.id) : i + 1,
            x: Number.isFinite(Number(t.x)) ? snap(Number(t.x)) : 24,
            y: Number.isFinite(Number(t.y)) ? snap(Number(t.y)) : 24,
            w: Number.isFinite(Number(t.w)) ? Number(t.w) : 220,
            h: Number.isFinite(Number(t.h)) ? Number(t.h) : 22,
            text: String(t.text || ""),
            bold: Boolean(t.bold),
          }))
          .map((t) => {
            clampText(t);
            return t;
          })
      : [];
    const maxTextId = texts.reduce((m, t) => Math.max(m, t.id), 0);
    const edgeKeys = new Set(normalizeEdges(data.edges).map((e) => edgeKey(e)));
    const edgeArrows = Array.isArray(data.edgeArrows)
      ? data.edgeArrows
          .map((a) => ({
            from: Number(a.from),
            toEdgeKey: String(a.toEdgeKey || ""),
          }))
          .filter((a) => Number.isFinite(a.from) && edgeKeys.has(a.toEdgeKey))
      : [];
    const maxStepLineId = stepLines.reduce((m, l) => Math.max(m, l.id), 0);
    return {
      nodes,
      edges: normalizeEdges(data.edges),
      edgeArrows,
      stepLines,
      texts,
      nextId: Number.isInteger(data.nextId) ? data.nextId : maxId + 1,
      nextStepLineId: Number.isInteger(data.nextStepLineId) ? data.nextStepLineId : maxStepLineId + 1,
      nextTextId: Number.isInteger(data.nextTextId) ? data.nextTextId : maxTextId + 1,
    };
  }

  const cards = Array.isArray(data.cards) ? data.cards : [];
  const nodes = cards.map((c, i) => ({
    id: Number.isInteger(c.id) ? c.id : i + 1,
    x: Number.isFinite(c.x) ? c.x : (Number(c.col) || 0) * 240 + 24,
    y: Number.isFinite(c.y) ? c.y : (Number(c.row) || 0) * 110 + 24,
    h: NODE_H,
    title: c.title || "",
    mode: "material",
    color: "gray",
    time: "",
    tags: [],
    memos: [],
  }));
  nodes.forEach(clampNode);
  const maxId = nodes.reduce((m, n) => Math.max(m, n.id), 0);
  return {
    nodes,
    edges: normalizeEdges(data.edges),
    edgeArrows: [],
    stepLines: [],
    texts: [],
    nextId: Number.isInteger(data.nextId) ? data.nextId : maxId + 1,
    nextStepLineId: 1,
    nextTextId: 1,
  };
}

async function loadRecipe(name) {
  if (!name) return;
  const res = await fetch(`api/recipes/${encodeURIComponent(name)}`);
  if (!res.ok) {
    alert("読込に失敗しました");
    return;
  }

  const payload = await res.json();
  const normalized = convertLegacyContent(payload.content || {});
  applyNormalizedContent(normalized);
  currentRecipeName = payload.name;
  currentRecipeLabel = payload.name;
  refreshRecipeTitle();
  editingRecipeKey = null;
  hasDraftRecipe = false;
  markSavedNow();
}

function clearEditorToEmpty() {
  state.nodes = [];
  state.edges = [];
  state.edgeArrows = [];
  state.stepLines = [];
  state.texts = [];
  state.nextId = 1;
  state.nextStepLineId = 1;
  state.nextTextId = 1;
  state.selectedNodeIds = [];
  state.selectedStepLineIds = [];
  state.selectedTextIds = [];
  historyStack.length = 0;
  currentRecipeName = "";
  currentRecipeLabel = "タイトルなし";
  refreshRecipeTitle();
  editingRecipeKey = null;
  draftListIndex = null;
  hasDraftRecipe = false;
  markSavedNow();
  render();
}

function applyViewScale(nextScale) {
  viewScale = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, nextScale));
  board.style.zoom = String(viewScale);
  edgesSvg.style.zoom = String(viewScale);
}

function expandBounds(bounds, x, y, w, h) {
  bounds.minX = Math.min(bounds.minX, x);
  bounds.minY = Math.min(bounds.minY, y);
  bounds.maxX = Math.max(bounds.maxX, x + w);
  bounds.maxY = Math.max(bounds.maxY, y + h);
}

function contentBoundsWithPadding(pad = 30) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  state.nodes.forEach((n) => {
    expandBounds(b, n.x, n.y, NODE_W, nodeHeight(n));
  });
  state.texts.forEach((t) => {
    const w = Number.isFinite(Number(t.w)) ? Number(t.w) : NODE_W;
    const h = textHeight(t);
    expandBounds(b, t.x, t.y, w, h);
  });
  state.edges.forEach((edge) => {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    if (!from || !to) return;
    const sides = resolveEdgeSides(edge, from, to);
    const a = anchorFor(from, sides.fromSide);
    const z = anchorFor(to, sides.toSide);
    const { c1, c2 } = bezierControls(a, sides.fromSide, z, sides.toSide);
    const minX = Math.min(a.x, z.x, c1.x, c2.x) - 2;
    const minY = Math.min(a.y, z.y, c1.y, c2.y) - 2;
    const maxX = Math.max(a.x, z.x, c1.x, c2.x) + 2;
    const maxY = Math.max(a.y, z.y, c1.y, c2.y) + 2;
    expandBounds(b, minX, minY, maxX - minX, maxY - minY);
  });

  // Step lines should only extend vertical bounds; do not force full-board width.
  if (Number.isFinite(b.minX) && Number.isFinite(b.maxX) && b.maxX > b.minX) {
    const lineW = b.maxX - b.minX;
    state.stepLines.forEach((l) => {
      expandBounds(b, b.minX, l.y - 8, lineW, 16);
    });
  } else if (state.stepLines.length > 0) {
    state.stepLines.forEach((l) => {
      expandBounds(b, 0, l.y - 8, 320, 16);
    });
  }

  if (!Number.isFinite(b.minX)) return null;
  const minX = Math.max(0, Math.floor(b.minX - pad));
  const minY = Math.max(0, Math.floor(b.minY - pad));
  const maxX = Math.min(BOARD_W, Math.ceil(b.maxX + pad));
  const maxY = Math.min(BOARD_H, Math.ceil(b.maxY + pad));
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function roundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawWrappedLines(ctx, text, x, y, maxWidth, lineHeight, maxLines = 6) {
  const lines = [];
  const srcLines = String(text || "").split("\n");
  srcLines.forEach((src) => {
    const chars = [...src];
    let current = "";
    chars.forEach((ch) => {
      const next = current + ch;
      if (ctx.measureText(next).width <= maxWidth || current.length === 0) {
        current = next;
      } else {
        lines.push(current);
        current = ch;
      }
    });
    lines.push(current);
  });
  const finalLines = lines.filter((l) => l != null).slice(0, maxLines);
  finalLines.forEach((line, i) => ctx.fillText(line, x, y + i * lineHeight));
  return finalLines.length;
}

function drawNodeToCanvas(ctx, node) {
  const h = nodeHeight(node);
  let fill = "#fcfdff";
  let border = "#b7d0d6";
  if (node.color === "green") {
    fill = "#c8e4e9";
    border = "#088395";
  } else if (node.color === "orange") {
    fill = "#f8d8e3";
    border = "#b3093f";
  }

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.fillStyle = fill;
  roundedRectPath(ctx, node.x, node.y, NODE_W, h, 5);
  ctx.fill();
  ctx.stroke();

  if (node.time) {
    const tx = node.x - 18;
    const ty = node.y - 12;
    const tw = Math.max(52, Math.min(120, 20 + ctx.measureText(node.time).width));
    const th = 23;
    ctx.fillStyle = "#09637e";
    ctx.strokeStyle = "#09637e";
    roundedRectPath(ctx, tx, ty, tw, th, 11.5);
    ctx.fill();
    ctx.font = '10px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
    ctx.fillStyle = "#ffffff";
    ctx.textBaseline = "middle";
    ctx.fillText(node.time, tx + 10, ty + th / 2 + 0.5);
  }

  ctx.fillStyle = "#14323a";
  ctx.font = '13px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
  ctx.textBaseline = "top";
  const titleY = node.y + (node.tags?.length || node.memos?.length ? 11 : 14);
  drawWrappedLines(ctx, node.title || "", node.x + 10, titleY, NODE_W - 20, 16, 3);

  let y = node.y + 48;
  const tags = normalizeNodeTags(node.tags);
  if (tags.length) {
    ctx.font = '9px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
    tags.forEach((tag) => {
      const tw = Math.min(NODE_W - 20, ctx.measureText(tag).width + 16);
      const th = 18;
      ctx.fillStyle = "#f2fafb";
      ctx.strokeStyle = "#7ab2b2";
      roundedRectPath(ctx, node.x + 10, y, tw, th, 9);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#2f4f57";
      ctx.textBaseline = "middle";
      ctx.fillText(tag, node.x + 18, y + th / 2 + 0.5);
      y += th + 4;
    });
  }

  const memos = normalizeNodeMemos(node.memos);
  if (memos.length) {
    ctx.font = '9px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
    ctx.fillStyle = "#14323a";
    ctx.textBaseline = "top";
    drawWrappedLines(ctx, memos[0], node.x + 10, y, NODE_W - 20, 13, 8);
  }
}

function drawTextToCanvas(ctx, textItem) {
  const w = Number.isFinite(Number(textItem.w)) ? Number(textItem.w) : NODE_W;
  const h = textHeight(textItem);
  ctx.font = `${textItem.bold ? "700" : "400"} 13px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif`;
  ctx.fillStyle = "#14323a";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const lines = String(textItem.text || "").split("\n");
  const lineHeight = 16;
  const baseY = textItem.y + h / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, textItem.x + w / 2, baseY + i * lineHeight);
  });
  ctx.textAlign = "start";
}

function drawStepLineToCanvas(ctx, line, idx) {
  const y = line.y + 0.5;
  ctx.save();
  ctx.strokeStyle = "rgba(107, 114, 128, 0.55)";
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(BOARD_W, y);
  ctx.stroke();
  ctx.restore();

  const label = String(line.label || "").trim() || `STEP ${idx + 1}`;
  ctx.font = '11px "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif';
  const lw = ctx.measureText(label).width + 10;
  const lx = 8;
  const ly = y - 16;
  ctx.fillStyle = "rgba(248, 250, 252, 0.9)";
  ctx.fillRect(lx, ly - 1, lw, 14);
  ctx.fillStyle = "#09637e";
  ctx.textBaseline = "top";
  ctx.fillText(label, lx + 5, ly);
}

function drawEdgesToCanvas(ctx) {
  state.edges.forEach((edge) => {
    const from = nodeById(edge.from);
    const to = nodeById(edge.to);
    if (!from || !to) return;
    const sides = resolveEdgeSides(edge, from, to);
    const a = anchorFor(from, sides.fromSide);
    const b = anchorFor(to, sides.toSide);
    const { c1, c2 } = bezierControls(a, sides.fromSide, b, sides.toSide);
    ctx.strokeStyle = "#09637E";
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, b.x, b.y);
    ctx.stroke();
  });
}

function drawGridToCanvas(ctx, bounds) {
  ctx.fillStyle = "#d7eaed";
  const startX = Math.floor(bounds.x / GRID_SIZE) * GRID_SIZE;
  const startY = Math.floor(bounds.y / GRID_SIZE) * GRID_SIZE;
  const endX = bounds.x + bounds.w;
  const endY = bounds.y + bounds.h;
  for (let x = startX; x <= endX; x += GRID_SIZE) {
    for (let y = startY; y <= endY; y += GRID_SIZE) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

async function exportBoardAsImage() {
  const bounds = contentBoundsWithPadding(30);
  if (!bounds) {
    alert("保存対象がありません");
    return;
  }

  if (typeof window.html2canvas !== "function") {
    alert("画像保存ライブラリの読み込みに失敗しました");
    return;
  }

  const stage = document.createElement("div");
  stage.style.position = "fixed";
  stage.style.left = "-100000px";
  stage.style.top = "0";
  stage.style.width = `${bounds.w}px`;
  stage.style.height = `${bounds.h}px`;
  stage.style.background = "#ffffff";
  stage.style.overflow = "hidden";
  stage.style.zIndex = "-1";
  stage.style.backgroundImage = "radial-gradient(#d7eaed 1px, transparent 1px)";
  stage.style.backgroundSize = `${GRID_SIZE}px ${GRID_SIZE}px`;
  stage.style.backgroundPosition = `${-bounds.x}px ${-bounds.y}px`;

  const edgesClone = edgesSvg.cloneNode(true);
  edgesClone.style.position = "absolute";
  edgesClone.style.left = `${-bounds.x}px`;
  edgesClone.style.top = `${-bounds.y}px`;
  edgesClone.style.width = `${BOARD_W}px`;
  edgesClone.style.height = `${BOARD_H}px`;
  edgesClone.style.zoom = "1";

  const boardClone = board.cloneNode(true);
  boardClone.style.position = "absolute";
  boardClone.style.left = `${-bounds.x}px`;
  boardClone.style.top = `${-bounds.y}px`;
  boardClone.style.width = `${BOARD_W}px`;
  boardClone.style.height = `${BOARD_H}px`;
  boardClone.style.zoom = "1";
  boardClone.querySelectorAll("input,textarea").forEach((el) => {
    el.blur();
  });

  stage.appendChild(edgesClone);
  stage.appendChild(boardClone);
  document.body.appendChild(stage);

  try {
    const canvas = await window.html2canvas(stage, {
      backgroundColor: "#ffffff",
      scale: Math.max(2, window.devicePixelRatio || 1),
      useCORS: true,
      logging: false,
    });
    const safeName = String((currentRecipeLabel || "cooking-chart").trim() || "cooking-chart")
      .replace(/[\\/:*?"<>|]+/g, "_");
    const filename = `${safeName}.png`;
    const isMobile = window.matchMedia("(max-width: 960px)").matches;

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("toBlob failed");

    if (isMobile && navigator.share) {
      const file = new File([blob], filename, { type: "image/png" });
      const canShareFile = typeof navigator.canShare === "function"
        ? navigator.canShare({ files: [file] })
        : true;
      if (canShareFile) {
        try {
          await navigator.share({
            files: [file],
            title: filename,
          });
          return;
        } catch {
          // Fallback to download when share is canceled/failed.
        }
      }
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    alert("画像生成に失敗しました");
  } finally {
    stage.remove();
  }
}

function zoomAtClient(clientX, clientY, nextScale) {
  if (!boardWrap) return;
  const prev = viewScale;
  const next = Math.max(MIN_VIEW_SCALE, Math.min(MAX_VIEW_SCALE, nextScale));
  if (Math.abs(next - prev) < 0.0001) return;
  const rect = boardWrap.getBoundingClientRect();
  const vx = clientX - rect.left;
  const vy = clientY - rect.top;
  const contentX = (boardWrap.scrollLeft + vx) / prev;
  const contentY = (boardWrap.scrollTop + vy) / prev;
  applyViewScale(next);
  boardWrap.scrollLeft = contentX * next - vx;
  boardWrap.scrollTop = contentY * next - vy;
}

function canUseBoardZoom() {
  if (isEditable) return true;
  return window.matchMedia("(min-width: 961px)").matches;
}

function resetToNewRecipe() {
  clearEditorToEmpty();
  draftListIndex = recipeNames.length;
  hasDraftRecipe = true;
}

const addNodeBtn = document.getElementById("add-node");
const addTextBtn = document.getElementById("add-text");
const saveBtn = document.getElementById("save");
const newRecipeBtn = document.getElementById("new-recipe");

if (isEditable && addNodeBtn) addNodeBtn.addEventListener("click", addNode);
if (isEditable && addTextBtn) addTextBtn.addEventListener("click", addText);
if (isEditable && addStepLineBtn) {
  addStepLineBtn.addEventListener("click", () => {
    const centerY = (boardWrap ? boardWrap.scrollTop : 0) + (boardWrap ? boardWrap.clientHeight / 2 : BOARD_H / 2);
    addStepLineAt(centerY);
  });
}
if (isEditable && saveBtn) saveBtn.addEventListener("click", () => saveRecipe());

if (isEditable && newRecipeBtn) {
  newRecipeBtn.addEventListener("click", async () => {
    const proceed = await confirmSaveIfEditing();
    if (!proceed) return;
    resetToNewRecipe();
    const ok = await saveRecipe({ silent: true });
    if (!ok) {
      await refreshRecipeList("__draft__");
    }
  });
}

if (isEditable && recipeItemsEl) recipeItemsEl.addEventListener("dragover", (event) => {
  if (!draggingRecipeName || !recipeDropIndicator) return;
  event.preventDefault();
  const itemsEls = Array.from(recipeItemsEl.querySelectorAll("li")).filter((el) => el.dataset.key);
  const listRect = recipeItemsEl.getBoundingClientRect();
  const hovered = event.target.closest("li");
  if (!hovered) {
    if (!itemsEls.length) return;
    const lastRect = itemsEls[itemsEls.length - 1].getBoundingClientRect();
    const topOffset = lastRect.bottom - listRect.top + recipeItemsEl.scrollTop + 4;
    recipeDropIndicator.style.top = `${topOffset}px`;
    recipeDropIndicator.classList.add("is-visible");
    return;
  }
  const rect = hovered.getBoundingClientRect();
  const isTop = event.clientY < rect.top + rect.height / 2;
  const topOffset = (isTop ? rect.top - 4 : rect.bottom + 4) - listRect.top + recipeItemsEl.scrollTop;
  recipeDropIndicator.style.top = `${topOffset}px`;
  recipeDropIndicator.classList.add("is-visible");
});

if (isEditable && recipeItemsEl) recipeItemsEl.addEventListener("dragleave", (event) => {
  if (!recipeDropIndicator) return;
  const nextTarget = event.relatedTarget;
  if (!nextTarget || !recipeItemsEl.contains(nextTarget)) {
    recipeDropIndicator.classList.remove("is-visible");
  }
});

if (isEditable && recipeItemsEl) recipeItemsEl.addEventListener("drop", async (event) => {
  if (!draggingRecipeName) return;
  event.preventDefault();
  if (!recipeDropIndicator) return;

  const proceed = await confirmSaveIfEditing();
  if (!proceed) return;

  const displayKeys = [...recipeNames];
  if (hasDraftRecipe) {
    const insertAt = Number.isInteger(draftListIndex)
      ? Math.max(0, Math.min(recipeNames.length, draftListIndex))
      : recipeNames.length;
    displayKeys.splice(insertAt, 0, "__draft__");
  }

  const fromIndex = displayKeys.indexOf(draggingRecipeName);
  if (fromIndex < 0) return;

  const targetLi = event.target.closest("li");
  let toIndex = displayKeys.length;
  if (targetLi && targetLi.dataset.key) {
    toIndex = displayKeys.indexOf(targetLi.dataset.key);
    if (toIndex < 0) toIndex = displayKeys.length;
    const rect = targetLi.getBoundingClientRect();
    const isTop = event.clientY < rect.top + rect.height / 2;
    if (!isTop) toIndex += 1;
  }
  if (fromIndex < toIndex) toIndex -= 1;
  if (toIndex < 0) toIndex = 0;
  if (toIndex > displayKeys.length) toIndex = displayKeys.length;

  const [moved] = displayKeys.splice(fromIndex, 1);
  displayKeys.splice(toIndex, 0, moved);

  if (hasDraftRecipe) {
    draftListIndex = displayKeys.indexOf("__draft__");
  }
  const names = displayKeys.filter((name) => name !== "__draft__");

  await fetch(withEditorKey("api/recipes/order"), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  });
  await refreshRecipeList(currentRecipeName);
  recipeDropIndicator.classList.remove("is-visible");
});

window.addEventListener("beforeunload", (e) => {
  if (!isEditable) return;
  if (!hasUnsavedChanges()) return;
  e.preventDefault();
  e.returnValue = "";
});

document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  const tag = (document.activeElement && document.activeElement.tagName) || "";
  const isTyping = tag === "INPUT" || tag === "TEXTAREA";
  const active = document.activeElement;
  const inBoardContext = !active || active === document.body || Boolean(active.closest?.("#board-wrap"));
  const inJsonContext = Boolean(active && (active === jsonOutput || active.closest?.("#json-panel")));

  const isSelectAll = isEditable && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "a";
  if (isSelectAll) {
    if (inJsonContext || !inBoardContext) return;
    e.preventDefault();
    if (active && (active.matches?.(".title,.memo-editor,.text-input,.time-input,.tag-inline-input") || active === jsonOutput)) {
      active.blur();
    }
    state.selectedNodeIds = state.nodes.map((n) => n.id);
    state.selectedStepLineIds = state.stepLines.map((l) => l.id);
    state.selectedTextIds = state.texts.map((t) => t.id);
    state.selectedEdgeKeys = state.edges.map((ed) => edgeKey(ed));
    refreshSelectionUI();
    return;
  }

  const isCopy = isEditable && !isTyping && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "c";
  if (isCopy) {
    if (copySelectionToClipboard()) e.preventDefault();
    return;
  }

  const isPaste = isEditable && !isTyping && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "v";
  if (isPaste) {
    if (pasteSelectionFromClipboard()) e.preventDefault();
    return;
  }

  const isBold = isEditable && !isTyping && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "b";
  if (isBold && state.selectedTextIds.length) {
    e.preventDefault();
    const before = cloneEditorState();
    const selected = new Set(state.selectedTextIds);
    state.texts.forEach((t) => {
      if (!selected.has(t.id)) return;
      t.bold = !Boolean(t.bold);
    });
    pushHistory(before);
    render();
    return;
  }

  const isDelete = isEditable && !isTyping && (e.key === "Delete" || e.key === "Backspace");
  if (isDelete && (state.selectedNodeIds.length || state.selectedStepLineIds.length || state.selectedTextIds.length || state.selectedEdgeKeys.length)) {
    pushHistory();
    const nodeSet = new Set(state.selectedNodeIds);
    const lineSet = new Set(state.selectedStepLineIds);
    const textSet = new Set(state.selectedTextIds);
    const edgeSet = new Set(state.selectedEdgeKeys);
    const removedEdgeKeys = new Set(
      state.edges
        .filter((ed) => nodeSet.has(ed.from) || nodeSet.has(ed.to) || edgeSet.has(edgeKey(ed)))
        .map((ed) => edgeKey(ed))
    );
    state.nodes = state.nodes.filter((n) => !nodeSet.has(n.id));
    state.stepLines = state.stepLines.filter((l) => !lineSet.has(l.id));
    state.texts = state.texts.filter((t) => !textSet.has(t.id));
    state.edges = state.edges.filter((ed) => !nodeSet.has(ed.from) && !nodeSet.has(ed.to) && !edgeSet.has(edgeKey(ed)));
    state.edgeArrows = state.edgeArrows.filter((a) => !nodeSet.has(a.from) && !removedEdgeKeys.has(a.toEdgeKey));
    clearSelection();
    render();
    e.preventDefault();
    return;
  }

  const isUndo = isEditable && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z";
  if (isUndo) {
    e.preventDefault();
    undo();
  }
});

if (isEditable) board.addEventListener("pointerdown", startMarqueeSelection);

if (boardWrap && canUseBoardZoom()) {
  boardWrap.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.002);
      zoomAtClient(e.clientX, e.clientY, viewScale * factor);
    },
    { passive: false }
  );

  boardWrap.addEventListener("gesturestart", (e) => {
    e.preventDefault();
    gestureStartScale = viewScale;
  });
  boardWrap.addEventListener("gesturechange", (e) => {
    e.preventDefault();
    const base = Number.isFinite(Number(gestureStartScale)) ? gestureStartScale : viewScale;
    const ratio = Number.isFinite(Number(e.scale)) ? Number(e.scale) : 1;
    zoomAtClient(e.clientX, e.clientY, base * ratio);
  });
  boardWrap.addEventListener("gestureend", (e) => {
    e.preventDefault();
    gestureStartScale = viewScale;
  });
}

if (toggleJsonBtn && jsonPanel) {
  toggleJsonBtn.addEventListener("click", () => {
    jsonPanel.classList.toggle("collapsed");
    toggleJsonBtn.classList.toggle("active", !jsonPanel.classList.contains("collapsed"));
    if (!jsonPanel.classList.contains("collapsed")) {
      refreshJsonText();
    }
  });
}

exportImageButtons.forEach((btn) => {
  btn.addEventListener("click", exportBoardAsImage);
});

if (jsonOutput) {
  jsonOutput.addEventListener("focus", () => {
    isEditingJson = true;
  });
  jsonOutput.addEventListener("blur", () => {
    isEditingJson = false;
    applyJsonEditorText();
    refreshJsonText();
  });
  jsonOutput.addEventListener("input", () => {
    if (suppressJsonInput) return;
    if (jsonSyncTimer) clearTimeout(jsonSyncTimer);
    jsonSyncTimer = setTimeout(() => {
      if (!isEditingJson) return;
      applyJsonEditorText();
    }, 400);
  });
}

if (boardWrap) {
  boardWrap.scrollLeft = 0;
  boardWrap.scrollTop = 0;
}

applyViewScale(isEditable ? 1 : VIEW_MODE_INITIAL_SCALE);
refreshRecipeTitle();
render();
markSavedNow();

(async () => {
  await refreshRecipeList();
  if (!currentRecipeName && !hasDraftRecipe && recipeNames.length > 0) {
    await loadRecipe(recipeNames[0]);
    await refreshRecipeList(recipeNames[0]);
  }
})();
