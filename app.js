const els = {
  fileInput: document.getElementById('fileInput'),
  taskSelect: document.getElementById('taskSelect'),
  segParams: document.getElementById('segParams'),
  maskAlpha: document.getElementById('maskAlpha'),
  hfToken: document.getElementById('hfToken'),
  saveTokenBtn: document.getElementById('saveTokenBtn'),
  enhanceBtn: document.getElementById('enhanceBtn'),
  downloadBtn: document.getElementById('downloadBtn'),
  status: document.getElementById('status'),
  inputPreview: document.getElementById('inputPreview'),
  outputPreview: document.getElementById('outputPreview'),
  // 新增交互式分割元素
  interactiveParams: document.getElementById('interactiveParams'),
  interactiveToggle: document.getElementById('interactiveToggle'),
  resetPointsBtn: document.getElementById('resetPointsBtn'),
  restoreOriginalBtn: document.getElementById('restoreOriginalBtn'),
  inputOverlay: document.getElementById('inputOverlay'),
};

// 交互式分割提示点：{x, y, label}，坐标基于原图自然尺寸
const promptPoints = [];
let showPromptPoints = false; // 不展示预览选取点
let segmentationBusy = false; // 防并发
let segmentationRunIndex = 0; // 每轮分割选择不同颜色
let lastMaskImageData = null; // 最近一次综合掩膜（全尺寸 alpha 用于标记覆盖）
let compositeCanvas = null;
let compositeCtx = null;
let compositeBaseImg = null;

const HF_SR_URL = 'https://api-inference.huggingface.co/models/caidas/swin2sr-classical-sr-x4-64';
const HF_SAM_URL = 'https://api-inference.huggingface.co/models/facebook/sam2-hiera-large';

// 初始化：尝试恢复本地存储的 Token
(function init() {
  try {
    const token = localStorage.getItem('hf_token') || '';
    if (token) els.hfToken.value = token;
  } catch (_) {}
})();

function setStatus(text, level = 'info') {
  els.status.textContent = text;
  els.status.style.color = level === 'error' ? '#fca5a5' : level === 'success' ? '#86efac' : '#93c5fd';
}

function enableActions(enabled) {
  els.enhanceBtn.disabled = !enabled;
  els.downloadBtn.disabled = !enabled || !els.outputPreview.src;
}

// 模式切换显示分割参数
if (els.taskSelect) {
  els.taskSelect.addEventListener('change', () => {
    const mode = els.taskSelect.value;
    els.segParams.style.display = mode === 'segment' ? 'flex' : 'none';
    if (els.interactiveParams) {
      els.interactiveParams.style.display = mode === 'segment' ? 'flex' : 'none';
    }
    // 分割模式下启用叠加画布指针并显示十字准星；其他模式恢复缩放指针
    if (els.inputOverlay && els.inputPreview) {
      if (mode === 'segment') {
        els.inputOverlay.style.pointerEvents = 'auto';
        els.inputOverlay.style.cursor = 'crosshair';
        els.inputPreview.style.cursor = 'crosshair';
      } else {
        els.inputOverlay.style.pointerEvents = 'none';
        els.inputOverlay.style.cursor = 'default';
        els.inputPreview.style.cursor = 'zoom-in';
      }
    }
    // 切换模式后统一恢复“处理结果”为原图，避免跨模式残留
    resetOutputToOriginal('已切换模式，输出重置为原图');
    updateEnhanceBtnDisabled();
  });
  els.taskSelect.dispatchEvent(new Event('change'));
}

// 选择文件后预览
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (!file) {
    setStatus('未选择文件');
    enableActions(false);
    els.inputPreview.src = '';
    els.outputPreview.src = '';
    promptPoints.length = 0; drawPoints();
    updateDownloadBtnEnabled();
    return;
  }
  const url = URL.createObjectURL(file);
  els.inputPreview.src = url;
  setStatus('已加载原图，选择模式并点击“开始处理”。如需交互，勾选启用点击选取');
  enableActions(true);
  updateEnhanceBtnDisabled();
});

// 交互：输入图像加载后，同步叠加层尺寸
els.inputPreview.addEventListener('load', () => {
  syncOverlayCanvas();
  promptPoints.length = 0; drawPoints();
  updateDownloadBtnEnabled();
});
window.addEventListener('resize', syncOverlayCanvas);

function syncOverlayCanvas() {
  if (!els.inputOverlay || !els.inputPreview) return;
  const imgEl = els.inputPreview;
  const container = imgEl.parentElement;
  if (!container) return;
  const w = Math.max(1, Math.round(imgEl.clientWidth));
  const h = Math.max(1, Math.round(imgEl.clientHeight));
  // 设置画布的渲染尺寸（坐标映射基准）
  els.inputOverlay.width = w;
  els.inputOverlay.height = h;
  // 将叠加层 CSS 尺寸与位置精确对齐到图片区域，避免覆盖标题等非图片区域
  els.inputOverlay.style.left = imgEl.offsetLeft + 'px';
  els.inputOverlay.style.top = imgEl.offsetTop + 'px';
  els.inputOverlay.style.width = w + 'px';
  els.inputOverlay.style.height = h + 'px';
  drawPoints();
}

function drawPoints() {
  if (!els.inputOverlay || !els.inputPreview) return;
  const ctx = els.inputOverlay.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, els.inputOverlay.width, els.inputOverlay.height);
  if (!showPromptPoints) return; // 不绘制点
  const scaleX = els.inputOverlay.width / Math.max(1, els.inputPreview.naturalWidth || 1);
  const scaleY = els.inputOverlay.height / Math.max(1, els.inputPreview.naturalHeight || 1);
  for (const p of promptPoints) {
    const x = p.x * scaleX;
    const y = p.y * scaleY;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fillStyle = p.label ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.9)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
  }
}

// 点击原图添加提示点：Alt为负样本，否则正样本（限制在图片预览范围内）
// 旧点击处理已移除，改为使用新的单点叠加监听

// 重置提示点
els.resetPointsBtn?.addEventListener('click', async () => {
  promptPoints.length = 0;
  drawPoints();
  const isSeg = (els.taskSelect?.value || 'enhance') === 'segment';
  if (isSeg && els.interactiveToggle?.checked) {
    await resetOutputToOriginal('已重置提示点与输出为原图');
  } else {
    setStatus('已重置提示点');
  }
});

// 保存 Token
els.saveTokenBtn.addEventListener('click', () => {
  const token = els.hfToken.value.trim();
  try {
    if (token) localStorage.setItem('hf_token', token);
    else localStorage.removeItem('hf_token');
  } catch (_) {}
  setStatus(token ? '已保存 Hugging Face Token' : '已清除 Token');
});

// 处理按钮点击
els.enhanceBtn.addEventListener('click', async () => {
  const file = els.fileInput.files?.[0];
  if (!file) return setStatus('请先选择图片', 'error');

  const token = els.hfToken.value.trim();
  const mode = els.taskSelect?.value || 'enhance';
  const isInteractive = !!els.interactiveToggle?.checked;

  enableActions(false);
  try {
    let outUrl;
    if (mode === 'segment') {
      const alpha = Math.max(0, Math.min(1, (els.maskAlpha?.value || 50) / 100));
      const hasPoints = isInteractive && promptPoints.length > 0;
      if (token) {
        setStatus(hasPoints ? '交互式分割（SAM2）推理中...' : '使用 SAM 2 自动分割中...');
        outUrl = await segmentWithSAM2(file, token, alpha, hasPoints ? promptPoints : undefined);
      } else {
        if (hasPoints) {
          setStatus('无 Token，交互式本地分割回退处理中...');
          outUrl = await segmentLocallyInteractive(file, alpha, promptPoints);
        } else {
          setStatus('无 Token，使用本地图像分割回退处理中...');
          outUrl = await segmentLocally(file, alpha, 4);
        }
      }
    } else {
      setStatus(token ? '使用 Hugging Face Swin2SR 推理中...' : '无 Token，使用本地锐化回退处理中...');
      outUrl = token ? await enhanceWithHF(file, token) : await enhanceLocally(file);
    }
    els.outputPreview.src = outUrl;
    updateDownloadBtnEnabled();
    setStatus('处理完成', 'success');
  } catch (err) {
    console.error(err);
    setStatus('处理失败：' + (err?.message || err), 'error');
  } finally {
    enableActions(true);
  }
});

// 下载结果
els.downloadBtn.addEventListener('click', async () => {
  const isSegInteractive = (els.taskSelect?.value || 'enhance') === 'segment' && !!els.interactiveToggle?.checked;
  const hasMask = !!lastMaskImageData;
  if (isSegInteractive && hasMask) {
    try {
      const bw = lastMaskImageData.width;
      const bh = lastMaskImageData.height;
      const data = lastMaskImageData.data;
      // 掩膜是否为空（无任意 alpha>0）
      let any = false;
      for (let i = 3; i < data.length; i += 4) { if (data[i] > 0) { any = true; break; } }
      if (!any) {
        const src = els.outputPreview.src;
        if (!src) return;
        const a = document.createElement('a'); a.href = src; a.download = 'result.png'; a.click();
        return;
      }
      // 导出被掩膜覆盖的原图部分（透明背景）
      const baseCanvas = document.createElement('canvas');
      baseCanvas.width = bw; baseCanvas.height = bh;
      const bCtx = baseCanvas.getContext('2d');
      const imgSrc = els.inputPreview?.src || els.outputPreview?.src;
      if (!imgSrc) {
        const src = els.outputPreview.src; if (!src) return;
        const a = document.createElement('a'); a.href = src; a.download = 'result.png'; a.click();
        return;
      }
      const img = await loadImage(imgSrc);
      // 将原图绘制到与掩膜同尺寸的画布上
      bCtx.drawImage(img, 0, 0, baseCanvas.width, baseCanvas.height);
      // 准备掩膜画布
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = bw; maskCanvas.height = bh;
      const mCtx = maskCanvas.getContext('2d');
      mCtx.putImageData(lastMaskImageData, 0, 0);
      // 使用 destination-in 仅保留掩膜覆盖区域
      bCtx.globalCompositeOperation = 'destination-in';
      bCtx.drawImage(maskCanvas, 0, 0);
      bCtx.globalCompositeOperation = 'source-over';
      const url = baseCanvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'segment_object.png';
      a.click();
      return;
    } catch (err) {
      console.error('原图掩膜导出失败：', err);
    }
  }
  // 回退为常规下载当前预览结果
  const src = els.outputPreview.src;
  if (!src) return;
  const a = document.createElement('a');
  a.href = src;
  a.download = 'result.png';
  a.click();
});

// 使用 Hugging Face Inference API 调用 Swin2SR（ViT）
async function enhanceWithHF(file, token) {
  const buf = await file.arrayBuffer();
  const res = await fetch(HF_SR_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
    },
    body: new Uint8Array(buf),
    mode: 'cors',
  });

  if (!res.ok) {
    const txt = await safeReadText(res);
    throw new Error('HF 请求失败：' + res.status + ' ' + txt);
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

// 使用 SAM2（最新）进行自动分割，并合成彩色遮罩叠加
async function segmentWithSAM2(file, token, alpha = 0.5, points, paletteIndex) {
  const base64 = await fileToBase64(file);
  const coords = Array.isArray(points) ? points.map(p => [p.x, p.y]) : undefined;
  const labels = Array.isArray(points) ? points.map(p => p.label) : undefined;
  const inputs = { image: base64 };
  if (coords && coords.length) {
    inputs.point_coords = coords;
    inputs.point_labels = labels;
    inputs.prompt = { points: coords, labels };
  }
  const payload = { inputs, options: { wait_for_model: true } };
  const res = await fetch(HF_SAM_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    mode: 'cors',
  });

  if (!res.ok) {
    const txt = await safeReadText(res);
    throw new Error('HF SAM2 请求失败：' + res.status + ' ' + txt);
  }

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('image/')) {
    const blob = await res.blob();
    lastMaskImageData = null; // 无法从纯图响应中解析掩膜
    return URL.createObjectURL(blob);
  }

  const data = await res.json();
  const masks = data.masks || data.segments || data;
  if (!Array.isArray(masks) || masks.length === 0) {
    throw new Error('SAM2 未返回有效分割结果');
  }

  const imgUrl = URL.createObjectURL(file);
  const img = await loadImage(imgUrl);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const unionMask = ctx.createImageData(canvas.width, canvas.height);
  const unionData = unionMask.data;

  const palette = [
    [255, 99, 132], [54, 162, 235], [255, 206, 86], [75, 192, 192],
    [153, 102, 255], [255, 159, 64], [199, 199, 199], [255, 0, 255],
  ];

  for (let i = 0; i < masks.length; i++) {
    const color = (paletteIndex != null) ? palette[paletteIndex % palette.length] : palette[i % palette.length];
    const mask = masks[i];
    let maskData;
    if (mask.png) {
      const pngUrl = 'data:image/png;base64,' + mask.png;
      const mImg = await loadImage(pngUrl);
      const mCanvas = document.createElement('canvas');
      const mCtx = mCanvas.getContext('2d');
      mCanvas.width = canvas.width; mCanvas.height = canvas.height;
      mCtx.drawImage(mImg, 0, 0, mCanvas.width, mCanvas.height);
      maskData = mCtx.getImageData(0, 0, mCanvas.width, mCanvas.height);
    } else if (mask.rle && mask.size) {
      const raw = rleToImageData(mask.rle, mask.size[1], mask.size[0]);
      maskData = (raw.width === canvas.width && raw.height === canvas.height)
        ? raw : scaleImageData(raw, canvas.width, canvas.height);
    } else if (mask.data) {
      const raw = arrayMaskToImageData(mask.data);
      maskData = (raw.width === canvas.width && raw.height === canvas.height)
        ? raw : scaleImageData(raw, canvas.width, canvas.height);
    } else {
      continue;
    }

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const id = imgData.data;
    const md = maskData.data;
    for (let p = 0; p < id.length; p += 4) {
      const covered = md[p + 3] > 0 || md[p] > 127;
      if (covered) {
        unionData[p + 3] = 255; // union alpha
        id[p]   = Math.round(id[p]   * (1 - alpha) + color[0] * alpha);
        id[p+1] = Math.round(id[p+1] * (1 - alpha) + color[1] * alpha);
        id[p+2] = Math.round(id[p+2] * (1 - alpha) + color[2] * alpha);
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }

  lastMaskImageData = unionMask;
  return canvas.toDataURL('image/png');
}

// 本地交互式分割回退：基于提示点的容差泛洪+下采样
async function segmentLocallyInteractive(file, alpha = 0.5, points, kPaletteIndex = 0) {
  const imgUrl = URL.createObjectURL(file);
  const img = await loadImage(imgUrl);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const smallW = Math.max(64, Math.min(256, Math.floor(canvas.width / 2)));
  const scale = smallW / canvas.width;
  const smallH = Math.round(canvas.height * scale);
  const smallCanvas = document.createElement('canvas');
  const smallCtx = smallCanvas.getContext('2d');
  smallCanvas.width = smallW;
  smallCanvas.height = smallH;
  smallCtx.drawImage(canvas, 0, 0, smallW, smallH);
  const smallData = smallCtx.getImageData(0, 0, smallW, smallH);
  const sd = smallData.data;

  const sPoints = points.map(p => ({
    x: Math.max(0, Math.min(smallW - 1, Math.round(p.x * smallW / canvas.width))),
    y: Math.max(0, Math.min(smallH - 1, Math.round(p.y * smallH / canvas.height))),
    label: p.label,
  }));

  const posMask = new Uint8Array(smallW * smallH);
  const negMask = new Uint8Array(smallW * smallH);

  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  const idxAt = (x,y) => (y*smallW + x);
  const colorAt = (x,y) => { const i = (y*smallW + x) * 4; return [sd[i], sd[i+1], sd[i+2]]; };
  const dist3 = (a,b) => { const dr=a[0]-b[0], dg=a[1]-b[1], db=a[2]-b[2]; return Math.sqrt(dr*dr + dg*dg + db*db); };

  function floodFill(seedX, seedY, outMask, baseTol = 28, maxPixels = Math.floor(smallW*smallH*0.6)) {
    const seedColor = colorAt(seedX, seedY);
    const visited = new Uint8Array(smallW * smallH);
    const qx = new Int32Array(smallW * smallH);
    const qy = new Int32Array(smallW * smallH);
    let qh = 0, qt = 0, filled = 0;
    qx[qt]=seedX; qy[qt]=seedY; qt++;
    visited[idxAt(seedX,seedY)] = 1;
    while (qh < qt && filled < maxPixels) {
      const x = qx[qh], y = qy[qh]; qh++;
      const i = idxAt(x,y);
      if (!outMask[i]) {
        const c = colorAt(x,y);
        const tol = baseTol;
        if (dist3(c, seedColor) <= tol) {
          outMask[i] = 1; filled++;
          for (const d of dirs) {
            const nx = x + d[0], ny = y + d[1];
            if (nx>=0 && nx<smallW && ny>=0 && ny<smallH) {
              const ni = idxAt(nx,ny);
              if (!visited[ni]) { visited[ni]=1; qx[qt]=nx; qy[qt]=ny; qt++; }
            }
          }
        }
      }
    }
  }

  for (const sp of sPoints) { if (sp.label) floodFill(sp.x, sp.y, posMask); else floodFill(sp.x, sp.y, negMask); }

  const finalMask = new Uint8Array(smallW * smallH);
  for (let i=0;i<finalMask.length;i++) finalMask[i] = posMask[i] && !negMask[i] ? 1 : 0;

  // 构建并保存全尺寸联合掩膜
  const maskSmallCanvas = document.createElement('canvas');
  const msCtx = maskSmallCanvas.getContext('2d');
  maskSmallCanvas.width = smallW; maskSmallCanvas.height = smallH;
  const msId = msCtx.createImageData(smallW, smallH);
  for (let y = 0; y < smallH; y++) {
    for (let x = 0; x < smallW; x++) {
      const idx = (y * smallW + x) * 4;
      const covered = finalMask[y * smallW + x] ? 255 : 0;
      msId.data[idx] = 0; msId.data[idx+1] = 0; msId.data[idx+2] = 0; msId.data[idx+3] = covered;
    }
  }
  msCtx.putImageData(msId, 0, 0);
  const maskFullCanvas = document.createElement('canvas');
  maskFullCanvas.width = canvas.width; maskFullCanvas.height = canvas.height;
  const mfCtx = maskFullCanvas.getContext('2d');
  mfCtx.drawImage(maskSmallCanvas, 0, 0, maskFullCanvas.width, maskFullCanvas.height);
  lastMaskImageData = mfCtx.getImageData(0, 0, maskFullCanvas.width, maskFullCanvas.height);

  // 叠加到原图（可视结果）
  const palette = [ [255, 99, 132], [54, 162, 235], [255, 206, 86], [75, 192, 192], [153, 102, 255], [255, 159, 64] ];
  const color = palette[kPaletteIndex % palette.length];
  ctx.save();
  ctx.globalAlpha = alpha;
  const cellW = canvas.width / smallW;
  const cellH = canvas.height / smallH;
  ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  for (let y = 0; y < smallH; y++) {
    for (let x = 0; x < smallW; x++) {
      if (finalMask[idxAt(x,y)]) {
        ctx.fillRect(Math.floor(x * cellW), Math.floor(y * cellH), Math.ceil(cellW), Math.ceil(cellH));
      }
    }
  }
  ctx.restore();

  return canvas.toDataURL('image/png');
}

function rleToImageData(rle, height, width) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = width; canvas.height = height;
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;
  let idx = 0;
  for (let i = 0; i < rle.length; i += 2) {
    const value = rle[i]; // 0 或 1
    const count = rle[i + 1];
    for (let c = 0; c < count; c++) {
      data[idx] = value ? 255 : 0;
      data[idx + 1] = value ? 255 : 0;
      data[idx + 2] = value ? 255 : 0;
      data[idx + 3] = value ? 255 : 0;
      idx += 4;
    }
  }
  return imgData;
}

function arrayMaskToImageData(arr) {
  const height = arr.length;
  const width = arr[0]?.length || 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = width; canvas.height = height;
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;
  let p = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = arr[y][x] ? 255 : 0;
      data[p] = v; data[p+1] = v; data[p+2] = v; data[p+3] = v; p += 4;
    }
  }
  return imgData;
}
// 新增：缩放 ImageData 到指定尺寸
function scaleImageData(srcImageData, width, height) {
  const sC = document.createElement('canvas');
  sC.width = srcImageData.width; sC.height = srcImageData.height;
  const sCtx = sC.getContext('2d');
  sCtx.putImageData(srcImageData, 0, 0);
  const dC = document.createElement('canvas');
  dC.width = width; dC.height = height;
  const dCtx = dC.getContext('2d');
  dCtx.drawImage(sC, 0, 0, width, height);
  return dCtx.getImageData(0, 0, width, height);
}

async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  const mime = file.type || 'image/png';
  return `data:${mime};base64,${b64}`;
}

async function safeReadText(res) {
  try { return await res.text(); } catch (_) { return ''; }
}

// 本地锐化（回退方案）：3x3 卷积锐化核
async function segmentLocally(file, alpha = 0.5, k = 4) {
  const imgUrl = URL.createObjectURL(file);
  const img = await loadImage(imgUrl);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const smallW = Math.max(64, Math.min(256, Math.floor(canvas.width / 2)));
  const scale = smallW / canvas.width;
  const smallH = Math.round(canvas.height * scale);
  const smallCanvas = document.createElement('canvas');
  const smallCtx = smallCanvas.getContext('2d');
  smallCanvas.width = smallW;
  smallCanvas.height = smallH;
  smallCtx.drawImage(canvas, 0, 0, smallW, smallH);
  const smallData = smallCtx.getImageData(0, 0, smallW, smallH);

  const assignments = kmeansSegment(smallData, k);

  const palette = [
    [255, 99, 132], [54, 162, 235], [255, 206, 86], [75, 192, 192],
    [153, 102, 255], [255, 159, 64], [199, 199, 199], [255, 0, 255],
  ];

  ctx.save();
  ctx.globalAlpha = alpha;
  const cellW = canvas.width / smallW;
  const cellH = canvas.height / smallH;
  for (let y = 0; y < smallH; y++) {
    for (let x = 0; x < smallW; x++) {
      const cluster = assignments[y * smallW + x];
      const color = palette[cluster % palette.length];
      ctx.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
      ctx.fillRect(Math.floor(x * cellW), Math.floor(y * cellH), Math.ceil(cellW), Math.ceil(cellH));
    }
  }
  ctx.restore();

  return canvas.toDataURL('image/png');
}

function kmeansSegment(imageData, k = 4, maxIter = 15) {
  const { data, width, height } = imageData;
  const n = width * height;
  const samples = new Float32Array(n * 3);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    samples[i*3] = data[p];
    samples[i*3+1] = data[p+1];
    samples[i*3+2] = data[p+2];
  }
  const centroids = new Float32Array(k * 3);
  for (let c = 0; c < k; c++) {
    const idx = Math.floor(Math.random() * n);
    centroids[c*3] = samples[idx*3];
    centroids[c*3+1] = samples[idx*3+1];
    centroids[c*3+2] = samples[idx*3+2];
  }
  const assign = new Uint16Array(n);
  const counts = new Uint32Array(k);
  const sums = new Float64Array(k * 3);

  for (let iter = 0; iter < maxIter; iter++) {
    counts.fill(0);
    sums.fill(0);
    for (let i = 0; i < n; i++) {
      let best = 0; let bestDist = Infinity;
      const r = samples[i*3], g = samples[i*3+1], b = samples[i*3+2];
      for (let c = 0; c < k; c++) {
        const dr = r - centroids[c*3];
        const dg = g - centroids[c*3+1];
        const db = b - centroids[c*3+2];
        const dist = dr*dr + dg*dg + db*db;
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      assign[i] = best;
      counts[best]++;
      sums[best*3] += r; sums[best*3+1] += g; sums[best*3+2] += b;
    }
    for (let c = 0; c < k; c++) {
      const count = counts[c] || 1;
      centroids[c*3] = sums[c*3] / count;
      centroids[c*3+1] = sums[c*3+1] / count;
      centroids[c*3+2] = sums[c*3+2] / count;
    }
  }
  return assign;
}

async function enhanceLocally(file) {
  const imgUrl = URL.createObjectURL(file);
  const img = await loadImage(imgUrl);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const sharpened = convolve(imageData, [
    0, -1,  0,
   -1,  5, -1,
    0, -1,  0,
  ], 1);
  ctx.putImageData(sharpened, 0, 0);

  return canvas.toDataURL('image/png');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// 简易 3x3 卷积
function convolve(imageData, kernel, divisor = 1) {
  const { width, height, data } = imageData;
  const output = new ImageData(width, height);
  const out = output.data;
  const k = kernel;
  const clamp = (v) => Math.max(0, Math.min(255, v));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          const px = Math.min(width - 1, Math.max(0, x + kx));
          const py = Math.min(height - 1, Math.max(0, y + ky));
          const pIdx = (py * width + px) * 4;
          const kIdx = (ky + 1) * 3 + (kx + 1);
          r += data[pIdx] * k[kIdx];
          g += data[pIdx + 1] * k[kIdx];
          b += data[pIdx + 2] * k[kIdx];
        }
      }
      const idx = (y * width + x) * 4;
      out[idx]     = clamp(r / divisor);
      out[idx + 1] = clamp(g / divisor);
      out[idx + 2] = clamp(b / divisor);
      out[idx + 3] = data[idx + 3];
    }
  }
  return output;
}

// 旧的无参即时分割函数已移除，统一由新的单点叠加版本处理

// 新增：复合画布与持久遮罩叠加管理
// 顶部已声明：compositeCanvas/compositeCtx/compositeBaseImg
async function resetOutputToOriginal(message) {
  try {
    // 清空交互提示点并刷新覆盖层
    promptPoints.length = 0;
    drawPoints();
    // 清空复合画布与颜色索引
    compositeCanvas = null;
    compositeCtx = null;
    compositeBaseImg = null;
    segmentationRunIndex = 0;
    lastMaskImageData = null; // 清空最近掩膜以避免下载误用
    // 恢复处理结果为原图
    if (els.outputPreview && els.inputPreview) {
      els.outputPreview.src = els.inputPreview.src || '';
    } else if (els.outputPreview) {
      els.outputPreview.src = '';
    }
    updateDownloadBtnEnabled();
    // 状态提示
    if (message) setStatus(message, 'success');
    else setStatus('已恢复为原图', 'success');
  } catch (err) {
    console.error(err);
    setStatus('恢复为原图失败：' + (err?.message || err), 'error');
  }
}

function resetComposite() {
  if (compositeCtx && compositeBaseImg && compositeCanvas) {
    compositeCtx.clearRect(0, 0, compositeCanvas.width, compositeCanvas.height);
    compositeCtx.drawImage(compositeBaseImg, 0, 0);
  }
}

async function ensureCompositeCanvasFromFile(file) {
  // 基于当前输入文件初始化复合画布（一次），后续仅做遮罩叠加
  const url = URL.createObjectURL(file);
  const img = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.src = url;
  });
  if (!compositeCanvas) {
    compositeCanvas = document.createElement('canvas');
  }
  compositeCanvas.width = img.naturalWidth || img.width;
  compositeCanvas.height = img.naturalHeight || img.height;
  compositeCtx = compositeCanvas.getContext('2d');
  compositeBaseImg = img;
  resetComposite();
}

function applyMaskImageDataToComposite(maskImageData, colorRGBA, alpha01) {
  if (!compositeCtx || !compositeCanvas) return;
  const { width, height, data } = maskImageData;
  // 创建临时遮罩层（仅在掩膜处着色）
  const overlay = compositeCtx.createImageData(width, height);
  const [r, g, b] = colorRGBA;
  const a = Math.round(255 * alpha01);
  for (let i = 0; i < data.length; i += 4) {
    const m = data[i + 3]; // 使用 alpha 作为掩膜存在标记
    if (m > 0) {
      overlay.data[i] = r;
      overlay.data[i + 1] = g;
      overlay.data[i + 2] = b;
      overlay.data[i + 3] = a;
    } else {
      overlay.data[i] = 0;
      overlay.data[i + 1] = 0;
      overlay.data[i + 2] = 0;
      overlay.data[i + 3] = 0;
    }
  }
  // 将遮罩层绘制到复合画布上（不影响背景原图）
  const tmp = document.createElement('canvas');
  tmp.width = width; tmp.height = height;
  const tctx = tmp.getContext('2d');
  tctx.putImageData(overlay, 0, 0);
  compositeCtx.drawImage(tmp, 0, 0, compositeCanvas.width, compositeCanvas.height);
}

function rgbaFromPaletteIndex(kPaletteIndex) {
  // 简单调色板（可与现有 palette 保持一致）
  const palette = [
    [255, 0, 0], [0, 150, 255], [0, 200, 100], [255, 160, 0], [170, 0, 255], [255, 0, 170],
    [0, 255, 200], [100, 100, 255], [255, 100, 100], [0, 255, 0]
  ];
  return palette[kPaletteIndex % palette.length];
}

async function sam2PrimaryMaskImageData(file, token, point) {
  const base64 = await fileToBase64(file);
  const inputs = {
    image: base64,
    point_coords: [[point.x, point.y]],
    point_labels: [point.label],
  };
  const payload = { inputs, options: { wait_for_model: true } };
  const resp = await fetch(HF_SAM_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    mode: 'cors',
  });
  if (!resp.ok) {
    const txt = await safeReadText(resp);
    throw new Error('HF SAM2 单点请求失败：' + resp.status + ' ' + txt);
  }
  const contentType = resp.headers.get('content-type') || '';
  if (contentType.includes('image/')) {
    const blob = await resp.blob();
    const img = await loadImage(URL.createObjectURL(blob));
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return ctx.getImageData(0, 0, c.width, c.height);
  }
  const json = await resp.json();
  const candidates = (json && (json.masks || json.segments || json)) || [];
  if (!Array.isArray(candidates) || !candidates.length) return null;

  // 获取原图尺寸，用于点坐标映射到掩膜尺寸
  const orig = await loadImage(base64);
  const origW = orig.naturalWidth || orig.width;
  const origH = orig.naturalHeight || orig.height;

  let bestMask = null;
  let bestScore = -Infinity;

  for (const c of candidates) {
    const entry = c.mask || c; // 兼容 {mask, score} 包裹结构
    let maskId = null;
    try {
      if (entry.rle && entry.size) {
        maskId = rleToImageData(entry.rle, entry.size[1], entry.size[0]);
      } else if (entry.png) {
        const maskImg = await loadImage('data:image/png;base64,' + entry.png);
        const mC = document.createElement('canvas');
        mC.width = maskImg.naturalWidth || maskImg.width; mC.height = maskImg.naturalHeight || maskImg.height;
        const mCtx = mC.getContext('2d');
        mCtx.drawImage(maskImg, 0, 0, mC.width, mC.height);
        maskId = mCtx.getImageData(0, 0, mC.width, mC.height);
      } else if (entry.data) {
        if (typeof entry.data === 'string') {
          const maskImg = await loadImage(entry.data);
          const mC = document.createElement('canvas');
          mC.width = maskImg.naturalWidth || maskImg.width; mC.height = maskImg.naturalHeight || maskImg.height;
          const mCtx = mC.getContext('2d');
          mCtx.drawImage(maskImg, 0, 0, mC.width, mC.height);
          maskId = mCtx.getImageData(0, 0, mC.width, mC.height);
        } else if (Array.isArray(entry.data) && Array.isArray(entry.data[0])) {
          maskId = arrayMaskToImageData(entry.data);
        }
      }
    } catch (_) { /* 单一候选解析失败则跳过 */ }

    if (!maskId) continue;

    const w = maskId.width, h = maskId.height;
    const nx = Math.max(0, Math.min(w - 1, Math.round(point.x * w / Math.max(1, orig.naturalWidth || orig.width))));
    const ny = Math.max(0, Math.min(h - 1, Math.round(point.y * h / Math.max(1, orig.naturalHeight || orig.height))));
    const pi = (ny * w + nx) * 4;
    const md = maskId.data;
    const covered = md[pi + 3] > 0 || md[pi] > 127;

    let area = 0;
    for (let i = 0; i < md.length; i += 4) {
      if (md[i + 3] > 0 || md[i] > 127) area++;
    }
    const scoreBase = (typeof c.score === 'number' ? c.score : 0);
    const score = scoreBase + (covered ? 1000 : 0) + area * 0.0001; // 以覆盖种子点为强优先，其次较高分与合理面积

    if (score > bestScore) { bestScore = score; bestMask = maskId; }
  }

  return bestMask;
}

async function localMaskImageDataForPoint(file, point) {
  const baseImg = await new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const im = new Image(); im.onload = () => resolve(im); im.src = url;
  });
  const w = baseImg.naturalWidth || baseImg.width;
  const h = baseImg.naturalHeight || baseImg.height;
  const imgC = document.createElement('canvas'); imgC.width = w; imgC.height = h;
  const ictx = imgC.getContext('2d');
  ictx.drawImage(baseImg, 0, 0, w, h);
  const imgData = ictx.getImageData(0, 0, w, h);
  const data = imgData.data;
  const grads = computeGradientLuma(imgData);

  const sx = Math.max(0, Math.min(w - 1, point.x | 0));
  const sy = Math.max(0, Math.min(h - 1, point.y | 0));
  const idxAt = (x, y) => ((y * w + x) << 2);
  const pixIdx = (x, y) => (y * w + x);

  // 局部颜色统计构建自适应阈值
  let sumR = 0, sumG = 0, sumB = 0, cnt = 0;
  let sumR2 = 0, sumG2 = 0, sumB2 = 0;
  let sumGm = 0, sumGm2 = 0; // 梯度统计
  for (let dy = -3; dy <= 3; dy++) {
    const yy = sy + dy; if (yy < 0 || yy >= h) continue;
    for (let dx = -3; dx <= 3; dx++) {
      const xx = sx + dx; if (xx < 0 || xx >= w) continue;
      const p = idxAt(xx, yy);
      const r = data[p], g = data[p + 1], b = data[p + 2];
      const gm = grads[pixIdx(xx, yy)];
      sumR += r; sumG += g; sumB += b; cnt++;
      sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
      sumGm += gm; sumGm2 += gm * gm;
    }
  }
  const meanR = sumR / Math.max(1, cnt), meanG = sumG / Math.max(1, cnt), meanB = sumB / Math.max(1, cnt);
  const varR = Math.max(0, sumR2 / Math.max(1, cnt) - meanR * meanR);
  const varG = Math.max(0, sumG2 / Math.max(1, cnt) - meanG * meanG);
  const varB = Math.max(0, sumB2 / Math.max(1, cnt) - meanB * meanB);
  const stdAvg = Math.sqrt(varR) + Math.sqrt(varG) + Math.sqrt(varB);
  const gradMean = sumGm / Math.max(1, cnt);
  const gradStd = Math.sqrt(Math.max(0, sumGm2 / Math.max(1, cnt) - gradMean * gradMean));

  const baseTol = 8; // 色彩基础容差
  const scaleTol = 2.0; // 按局部方差放大容差
  const thr = baseTol + scaleTol * (stdAvg / 3);
  const thr2 = thr * thr;
  const gradThr = gradMean + 1.2 * gradStd; // 边缘门限：避免跨越强边缘

  const maxRadius = Math.min(200, Math.floor(Math.min(w, h) * 0.25));
  const maxR2 = maxRadius * maxRadius;

  // 区域生长（动态均值 + 边缘门控 + 半径约束）
  let regSumR = meanR * cnt, regSumG = meanG * cnt, regSumB = meanB * cnt, regCnt = cnt;
  const visited = new Uint8Array(w * h);
  const q = [];
  const seedIdx = sy * w + sx; visited[seedIdx] = 1; q.push(seedIdx);
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1,1],[-1,1],[1,-1],[-1,-1]];
  const maxRegion = Math.floor(w * h * 0.5);

  while (q.length) {
    const node = q.pop();
    const ny = (node / w) | 0; const nx = node % w;
    const mp = idxAt(nx, ny);
    regSumR += data[mp]; regSumG += data[mp + 1]; regSumB += data[mp + 2]; regCnt++;
    const meanCr = regSumR / regCnt, meanCg = regSumG / regCnt, meanCb = regSumB / regCnt;
    for (const [dx, dy] of dirs) {
      const xx = nx + dx, yy = ny + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const idPix = yy * w + xx; if (visited[idPix]) continue;
      const p = idxAt(xx, yy);
      const dr = data[p] - meanCr;
      const dg = data[p + 1] - meanCg;
      const db = data[p + 2] - meanCb;
      const dist2 = dr * dr + dg * dg + db * db;
      const d2 = (xx - sx) * (xx - sx) + (yy - sy) * (yy - sy);
      if (dist2 <= thr2 && grads[idPix] <= gradThr && d2 <= maxR2) {
        visited[idPix] = 1; q.push(idPix);
        if (regCnt >= maxRegion) break;
      }
    }
    if (regCnt >= maxRegion) break;
  }

  // 形态学开闭操作：去噪并平滑边界
  const refined = morphOpenClose(visited, w, h, 1, 1);

  const maskId = ictx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = y * w + x; const p = (id << 2);
      if (refined[id]) {
        maskId.data[p] = 0;
        maskId.data[p + 1] = 0;
        maskId.data[p + 2] = 0;
        maskId.data[p + 3] = 255;
      } else {
        maskId.data[p] = 0;
        maskId.data[p + 1] = 0;
        maskId.data[p + 2] = 0;
        maskId.data[p + 3] = 0;
      }
    }
  }
  return maskId;
}

// 修改：交互式即时分割仅处理最新点击并叠加到复合画布
async function processSegmentationImmediate(lastPoint) {
  // 改为使用所有已选提示点进行一次综合分割
  if (segmentationBusy) return;
  segmentationBusy = true;
  try {
    const file = els.fileInput.files?.[0];
    if (!file) { segmentationBusy = false; return; }
    const hasPoints = promptPoints.length > 0;
    if (!hasPoints) { segmentationBusy = false; return; }

    const alpha01 = Math.max(0, Math.min(1, (els.maskAlpha?.value || 50) / 100));
    const token = els.hfToken.value.trim();
    let outUrl = '';
    if (token) {
      try {
        setStatus('SAM2 多点综合分割推理中...');
        outUrl = await segmentWithSAM2(file, token, alpha01, promptPoints);
      } catch (e) {
        console.warn('SAM2 多点分割失败，改用本地回退:', e);
      }
    }
    if (!outUrl) {
      setStatus('无 Token，交互式本地多点分割处理中...');
      outUrl = await segmentLocallyInteractive(file, alpha01, promptPoints, 0);
    }
    if (outUrl && els.outputPreview) {
      els.outputPreview.src = outUrl;
      updateDownloadBtnEnabled();
    }
  } finally {
    segmentationBusy = false;
  }
}

// 修改：点击 overlay 仅追加最新点并触发即时单点叠加
if (els && els.inputOverlay) {
  els.inputOverlay.addEventListener('click', async (e) => {
    if ((els.taskSelect?.value || 'enhance') !== 'segment') return;
    if (!els.interactiveToggle?.checked) return;
    e.stopPropagation();
    // 计算 overlay 内坐标并限制在预览范围
    const rect = e.currentTarget.getBoundingClientRect();
    const ox = e.offsetX; const oy = e.offsetY;
    const cx = Math.max(0, Math.min(ox, rect.width));
    const cy = Math.max(0, Math.min(oy, rect.height));
    const natW = els.inputPreview.naturalWidth; const natH = els.inputPreview.naturalHeight;
    const overlayW = els.inputOverlay.width; const overlayH = els.inputOverlay.height;
    if (!natW || !natH || !overlayW || !overlayH) return;
    const nx = Math.round(cx * natW / Math.max(1, overlayW));
    const ny = Math.round(cy * natH / Math.max(1, overlayH));
    const label = e.altKey ? 0 : 1;
    const pt = { x: nx, y: ny, label };
    promptPoints.push(pt);
    await processSegmentationImmediate();
  });
}

// 修改：当输入图加载或重置提示点时清空复合画布与颜色索引
if (els && els.inputPreview) {
  els.inputPreview.addEventListener('load', () => {
    compositeCanvas = null; compositeCtx = null; compositeBaseImg = null;
    segmentationRunIndex = 0;
    // 恢复输出为原图：清空提示点与复合叠加状态（如需实际恢复，请调用顶层函数 resetOutputToOriginal）
  });
}

if (els && els.resetPointsBtn) {
  els.resetPointsBtn?.addEventListener('click', async () => {
    promptPoints.length = 0;
    drawPoints();
    const isSeg = (els.taskSelect?.value || 'enhance') === 'segment';
    if (isSeg && els.interactiveToggle?.checked) {
      await resetOutputToOriginal('已重置提示点与输出为原图');
    } else {
      setStatus('已重置提示点');
    }
  });
}
// 恢复原图按钮：统一调用重置到原图逻辑
els.restoreOriginalBtn?.addEventListener('click', async () => {
  await resetOutputToOriginal('已恢复为原图');
});

function updateEnhanceBtnDisabled() {
  const isSeg = (els.taskSelect?.value || 'enhance') === 'segment';
  const checked = !!els.interactiveToggle?.checked;
  const fileSelected = !!(els.fileInput?.files && els.fileInput.files[0]);
  if (els.enhanceBtn) {
    els.enhanceBtn.disabled = (isSeg && checked) || !fileSelected;
  }
}

// 当启用交互时自动恢复为原图，并同步按钮禁用状态
els.interactiveToggle?.addEventListener('change', async () => {
  updateEnhanceBtnDisabled();
  const isSeg = (els.taskSelect?.value || 'enhance') === 'segment';
  if (els.interactiveToggle.checked && isSeg) {
    await resetOutputToOriginal('已启用交互，输出重置为原图');
  }
});

function updateDownloadBtnEnabled() {
  try {
    if (!els?.downloadBtn) return;
    const isSegInteractive = (els.taskSelect?.value || 'enhance') === 'segment' && !!els.interactiveToggle?.checked;
    const hasOut = !!els.outputPreview?.src;
    const hasMask = !!lastMaskImageData;
    els.downloadBtn.disabled = !(hasOut || (isSegInteractive && hasMask));
  } catch (_) {}
}