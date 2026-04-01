const startCameraButton = document.getElementById("start-camera-button");
const captureButton = document.getElementById("capture-button");
const cropButton = document.getElementById("crop-button");
const ocrButton = document.getElementById("ocr-button");
const saveButton = document.getElementById("save-button");
const refreshButton = document.getElementById("refresh-button");
const statusEl = document.getElementById("status");
const video = document.getElementById("video");
const captureCanvas = document.getElementById("capture-canvas");
const cropPreview = document.getElementById("crop-preview");
const selection = document.getElementById("selection");
const cameraStage = document.getElementById("camera-stage");
const labelInput = document.getElementById("label-input");
const ocrText = document.getElementById("ocr-text");
const recordsList = document.getElementById("records-list");

const ocrApiUrl = new URL("./api/ocr", window.location.href);
const recordsApiUrl = new URL("./api/records", window.location.href);

const state = {
  stream: null,
  captured: false,
  selecting: false,
  selectionStart: null,
  selectionRect: null,
  croppedImage: "",
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function updateActionState() {
  captureButton.disabled = !state.stream;
  cropButton.disabled = !state.captured || !state.selectionRect;
  ocrButton.disabled = !state.croppedImage;
  saveButton.disabled = !state.croppedImage || !labelInput.value.trim();
}

async function startCamera() {
  if (state.stream) {
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
    state.stream = stream;
    video.srcObject = stream;
    setStatus("カメラを起動しました。");
  } catch (error) {
    setStatus("カメラを起動できませんでした。ブラウザ権限を確認してください。", true);
  }
  updateActionState();
}

function captureFrame() {
  if (!state.stream || video.videoWidth === 0 || video.videoHeight === 0) {
    setStatus("撮影できる状態ではありません。", true);
    return;
  }

  captureCanvas.width = video.videoWidth;
  captureCanvas.height = video.videoHeight;
  const context = captureCanvas.getContext("2d");
  context.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

  captureCanvas.classList.remove("hidden");
  video.classList.add("hidden");
  state.captured = true;
  state.selectionRect = null;
  state.croppedImage = "";
  ocrText.value = "";
  clearSelection();
  clearCropPreview();
  setStatus("撮影しました。ドラッグして切り出したい範囲を選んでください。");
  updateActionState();
}

function clearSelection() {
  selection.classList.add("hidden");
  selection.style.left = "0px";
  selection.style.top = "0px";
  selection.style.width = "0px";
  selection.style.height = "0px";
}

function clearCropPreview() {
  const context = cropPreview.getContext("2d");
  context.clearRect(0, 0, cropPreview.width, cropPreview.height);
}

function getStagePoint(event) {
  const bounds = cameraStage.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
    y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
  };
}

function renderSelection(rect) {
  selection.classList.remove("hidden");
  selection.style.left = `${rect.left}px`;
  selection.style.top = `${rect.top}px`;
  selection.style.width = `${rect.width}px`;
  selection.style.height = `${rect.height}px`;
}

function beginSelection(event) {
  if (!state.captured) {
    return;
  }

  state.selecting = true;
  state.selectionStart = getStagePoint(event);
  state.selectionRect = null;
  renderSelection({
    left: state.selectionStart.x,
    top: state.selectionStart.y,
    width: 0,
    height: 0,
  });
  updateActionState();
}

function moveSelection(event) {
  if (!state.selecting || !state.selectionStart) {
    return;
  }

  const point = getStagePoint(event);
  const left = Math.min(point.x, state.selectionStart.x);
  const top = Math.min(point.y, state.selectionStart.y);
  const width = Math.abs(point.x - state.selectionStart.x);
  const height = Math.abs(point.y - state.selectionStart.y);

  state.selectionRect = { left, top, width, height };
  renderSelection(state.selectionRect);
  updateActionState();
}

function endSelection() {
  if (!state.selecting) {
    return;
  }

  state.selecting = false;
  if (!state.selectionRect || state.selectionRect.width < 12 || state.selectionRect.height < 12) {
    state.selectionRect = null;
    clearSelection();
  }
  updateActionState();
}

function cropSelection() {
  if (!state.selectionRect) {
    setStatus("先に切り出し範囲を選択してください。", true);
    return;
  }

  const stageBounds = cameraStage.getBoundingClientRect();
  const scaleX = captureCanvas.width / stageBounds.width;
  const scaleY = captureCanvas.height / stageBounds.height;
  const sourceX = Math.round(state.selectionRect.left * scaleX);
  const sourceY = Math.round(state.selectionRect.top * scaleY);
  const sourceWidth = Math.round(state.selectionRect.width * scaleX);
  const sourceHeight = Math.round(state.selectionRect.height * scaleY);

  cropPreview.width = sourceWidth;
  cropPreview.height = sourceHeight;
  const cropContext = cropPreview.getContext("2d");
  cropContext.clearRect(0, 0, sourceWidth, sourceHeight);
  cropContext.drawImage(
    captureCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  state.croppedImage = cropPreview.toDataURL("image/png");
  setStatus("選択範囲を切り出しました。OCR 実行または保存に進めます。");
  updateActionState();
}

async function runOcr() {
  if (!state.croppedImage) {
    return;
  }

  setStatus("OCR を実行しています。");
  try {
    const response = await fetch(ocrApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: state.croppedImage }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "OCR failed");
    }
    ocrText.value = payload.text || "";
    setStatus("OCR が完了しました。");
  } catch (error) {
    setStatus(`OCR に失敗しました: ${error.message}`, true);
  }
}

async function saveRecord() {
  if (!state.croppedImage) {
    return;
  }

  setStatus("保存しています。");
  try {
    const response = await fetch(recordsApiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: labelInput.value.trim(),
        image: state.croppedImage,
        extractedText: ocrText.value.trim(),
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "save failed");
    }
    setStatus("保存しました。");
    labelInput.value = "";
    updateActionState();
    await loadRecords();
  } catch (error) {
    setStatus(`保存に失敗しました: ${error.message}`, true);
  }
}

function renderRecords(records) {
  if (!records.length) {
    recordsList.innerHTML = '<li class="record-item"><p class="record-meta">まだ保存データはありません。</p></li>';
    return;
  }

  recordsList.innerHTML = records
    .map((record) => {
      const text = (record.extracted_text || "").trim() || "OCR テキストなし";
      const preview = text.length > 120 ? `${text.slice(0, 120)}...` : text;
      return `
        <li class="record-item">
          <p class="record-title">${escapeHtml(record.label)}</p>
          <p class="record-meta">${escapeHtml(record.created_at)}</p>
          <p class="record-text">${escapeHtml(preview)}</p>
        </li>
      `;
    })
    .join("");
}

async function loadRecords() {
  try {
    const response = await fetch(recordsApiUrl);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "load failed");
    }
    renderRecords(payload);
  } catch (error) {
    recordsList.innerHTML = `<li class="record-item"><p class="record-meta">一覧取得に失敗しました: ${escapeHtml(error.message)}</p></li>`;
  }
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

startCameraButton.addEventListener("click", startCamera);
captureButton.addEventListener("click", captureFrame);
cropButton.addEventListener("click", cropSelection);
ocrButton.addEventListener("click", runOcr);
saveButton.addEventListener("click", saveRecord);
refreshButton.addEventListener("click", loadRecords);
labelInput.addEventListener("input", updateActionState);

cameraStage.addEventListener("pointerdown", beginSelection);
cameraStage.addEventListener("pointermove", moveSelection);
cameraStage.addEventListener("pointerup", endSelection);
cameraStage.addEventListener("pointerleave", endSelection);

loadRecords();
updateActionState();
