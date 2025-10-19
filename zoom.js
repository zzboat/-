(function(){
  const overlay = document.getElementById('zoomOverlay');
  const stage = document.getElementById('zoomStage');
  const img = document.getElementById('zoomImage');
  const closeBtn = document.getElementById('zoomCloseBtn');
  const zoomStatus = document.getElementById('zoomStatus');
  const inputPreview = document.getElementById('inputPreview');
  const outputPreview = document.getElementById('outputPreview');
  if (!overlay || !stage || !img) return;

  const state = {
    scale: 1,
    minScale: 1,
    maxScale: 6,
    dragging: false,
    lastX: 0,
    lastY: 0,
    dx: 0,
    dy: 0,
    iw: 0,
    ih: 0,
  };

  function fitToStage() {
    const rect = stage.getBoundingClientRect();
    const vw = rect.width;
    const vh = rect.height;
    const { iw, ih } = state;
    const s = Math.min(vw / iw, vh / ih);
    state.minScale = s;
    state.scale = s;
    state.dx = 0;
    state.dy = 0;
    update();
  }

  function update() {
    img.style.transform = `translate(-50%, -50%) scale(${state.scale}) translate(${state.dx}px, ${state.dy}px)`;
    if (zoomStatus) {
      const pct = Math.round(state.scale / state.minScale * 100);
      zoomStatus.textContent = `缩放：${pct}%`;
    }
  }

  function openZoom(src) {
    if (!src) return;
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    img.src = src;
    img.onload = () => {
      state.iw = img.naturalWidth;
      state.ih = img.naturalHeight;
      fitToStage();
    };
    bindEvents();
  }

  function closeZoom() {
    overlay.classList.remove('active');
    overlay.setAttribute('aria-hidden', 'true');
    unbindEvents();
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY;
    const factor = Math.pow(1.001, -delta);
    const next = Math.max(state.minScale, Math.min(state.maxScale, state.scale * factor));
    state.scale = next;
    update();
  }

  function onMouseDown(e) {
    state.dragging = true;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
  }

  function onMouseMove(e) {
    if (!state.dragging) return;
    const dx = e.clientX - state.lastX;
    const dy = e.clientY - state.lastY;
    state.lastX = e.clientX;
    state.lastY = e.clientY;
    state.dx += dx / state.scale;
    state.dy += dy / state.scale;
    update();
  }

  function onMouseUp() {
    state.dragging = false;
  }

  function onDblClick() {
    const mid = state.minScale * 2;
    state.scale = (state.scale > mid) ? state.minScale : mid;
    update();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closeZoom();
  }

  function bindEvents() {
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    stage.addEventListener('dblclick', onDblClick);
    document.addEventListener('keydown', onKeyDown);
  }
  function unbindEvents() {
    stage.removeEventListener('wheel', onWheel);
    stage.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
    stage.removeEventListener('dblclick', onDblClick);
    document.removeEventListener('keydown', onKeyDown);
  }

  // 点击预览打开放大
  function attach(el) {
    if (!el) return;
    el.addEventListener('click', (evt) => {
      const taskSelect = document.getElementById('taskSelect');
      const mode = taskSelect ? taskSelect.value : 'enhance';
      // 分割模式下禁止点击放大
      if (mode === 'segment') {
        evt.preventDefault();
        evt.stopPropagation();
        return;
      }
      openZoom(el.src);
    });
  }
  attach(inputPreview);
  attach(outputPreview);

  // 关闭按钮
  if (closeBtn) closeBtn.addEventListener('click', closeZoom);

  // 点击遮罩空白区域关闭（不影响 stage 内部）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeZoom();
  });
})();