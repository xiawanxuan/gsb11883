/* 主控:渲染循环、降级决策(3D 纹理缺失 / 显存不足)、性能监控 */
(() => {
  const $ = (id) => document.getElementById(id);
  let canvas = $('glcanvas');

  const state = {
    rotX: -0.45, rotY: 0.65, zoom: 2.4,
    steps: 256, userSteps: 256, adaptive: false,
    density: 1, scale: 1,
    clipMin: [0, 0, 0], clipMax: [1, 1, 1],
    volType: 'skull', volSize: 128,
    forceNo3D: false, vramBudgetMB: 256,
    degraded: []
  };

  let renderer = null;
  let volume = null;
  let tfLut = null;

  /* ---------- 主线程长任务监控(PerformanceObserver) ---------- */
  let longTaskCount = 0, longTaskRecent = 0;
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTaskCount++;
        longTaskRecent = performance.now();
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 部分浏览器不支持 longtask,忽略 */ }

  /* ---------- FPS 统计 ---------- */
  let fpsEMA = 0, msEMA = 16.7, lastT = 0;

  /* ---------- 降级:显存预算 ---------- */
  function volumeBytes(size) { return size * size * size; } // R8 = 1 字节/体素
  function fitsBudget(size) {
    return volumeBytes(size) <= state.vramBudgetMB * 1024 * 1024;
  }
  function pickSize(requested) {
    const candidates = [256, 192, 128, 96, 64, 48, 32];
    for (const s of candidates) {
      if (s <= requested && fitsBudget(s)) return s;
    }
    return 32;
  }

  function showBanner() {
    const b = $('banner');
    if (!state.degraded.length) { b.style.display = 'none'; return; }
    b.style.display = 'block';
    b.innerHTML = '⚠ 已启用降级:<br>' + state.degraded.map(d => '• ' + d).join('<br>');
  }

  /* ---------- 渲染器构建(含降级链) ---------- */
  function buildRenderer() {
    if (renderer) { renderer.dispose(); renderer = null; }
    state.degraded = [];

    // canvas 一旦创建过某种 GL 上下文就无法换类型,降级时替换 canvas 元素
    const fresh = document.createElement('canvas');
    fresh.id = 'glcanvas';
    canvas.replaceWith(fresh);
    canvas = fresh;
    bindCanvasEvents();
    resize();

    if (!state.forceNo3D) {
      try {
        renderer = Raymarcher.create(canvas);
      } catch (e) {
        console.warn('Raymarcher 创建失败', e);
        renderer = null;
      }
      if (!renderer) {
        state.degraded.push('当前环境不支持 WebGL2 3D 纹理,已降级为切片渲染');
      }
    } else {
      state.degraded.push('已模拟禁用 3D 纹理,降级为切片渲染');
    }
    if (!renderer) {
      renderer = Slicer.create(canvas);
      if (!renderer) {
        $('status').textContent = '错误:WebGL 完全不可用';
        return false;
      }
    }
    if (tfLut) renderer.setTF(tfLut);
    showBanner();
    return true;
  }

  /* ---------- 体积加载(Worker + IndexedDB,含显存降级) ---------- */
  async function loadVolume() {
    $('status').textContent = '体积数据生成中…';
    const size = pickSize(state.volSize);
    if (size < state.volSize) {
      pushDegrade('显存预算不足,体积从 ' + state.volSize + '³ 降采样到 ' + size + '³');
    }
    const vol = await VolumeStore.getVolume(state.volType, size);
    // GL 实际分配也可能失败(真实显存不足),逐级降采样重试
    let cur = vol, ok = renderer.setVolume(cur.data, cur.size);
    while (!ok && cur.size > 32) {
      const smaller = cur.size / 2;
      pushDegrade('GPU 纹理分配失败,降采样到 ' + smaller + '³ 重试');
      cur = await VolumeStore.getVolume(state.volType, smaller);
      ok = renderer.setVolume(cur.data, cur.size);
    }
    volume = cur;
    $('status').textContent = vol.fromCache ? '已加载(IndexedDB 缓存)' : '已生成并缓存';
    updateHUDStatic();
  }

  function pushDegrade(msg) {
    if (!state.degraded.includes(msg)) state.degraded.push(msg);
    showBanner();
  }

  /* ---------- 相机与参数 ---------- */
  function frameParams() {
    const rot = Mat4.multiply(Mat4.rotY(state.rotY), Mat4.rotX(state.rotX));
    const s = state.scale;
    const scale3 = [s, s, s];
    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = Mat4.perspective(Math.PI / 4, aspect, 0.05, 100);
    const view = Mat4.translate(0, 0, -state.zoom);
    const mvp = Mat4.multiply(proj, Mat4.multiply(view, rot));
    return {
      mvp,
      scale: scale3,
      camPosVol: Mat4.worldToVolume([0, 0, state.zoom], rot, scale3),
      viewDirVol: Mat4.dirToVolume([0, 0, -1], rot),
      lightDirVol: Mat4.dirToVolume([0.5, 0.7, 0.5], rot),
      clipMin: state.clipMin,
      clipMax: state.clipMax,
      steps: state.steps,
      density: state.density
    };
  }

  /* ---------- 自适应步进 ---------- */
  let lastAdapt = 0;
  function adaptSteps(now) {
    if (!state.adaptive || now - lastAdapt < 500) return;
    lastAdapt = now;
    if (fpsEMA < 28 && state.steps > 32) {
      state.steps = Math.max(32, Math.round(state.steps * 0.8));
    } else if (fpsEMA > 55 && state.steps < state.userSteps) {
      state.steps = Math.min(state.userSteps, Math.round(state.steps * 1.15));
    }
  }

  /* ---------- 主循环 ---------- */
  function frame(now) {
    resize();
    if (lastT) {
      const dt = now - lastT;
      msEMA = msEMA * 0.9 + dt * 0.1;
      fpsEMA = 1000 / Math.max(msEMA, 0.01);
    }
    lastT = now;
    adaptSteps(now);
    if (renderer && volume) renderer.render(frameParams());
    updateHUD(now);
    requestAnimationFrame(frame);
  }

  /* ---------- HUD ---------- */
  let lastHUD = 0;
  function updateHUD(now) {
    if (now - lastHUD < 250) return;
    lastHUD = now;
    $('hFps').textContent = fpsEMA.toFixed(1);
    $('hMs').textContent = msEMA.toFixed(2);
    $('hSteps').textContent = state.steps;
    $('hAdaptive').textContent = state.adaptive ? '(自适应,目标 ' + state.userSteps + ')' : '';
    $('hLong').textContent = longTaskCount;
    const busy = performance.now() - longTaskRecent < 1000 && longTaskCount > 0;
    const hm = $('hMain');
    hm.textContent = busy ? '●有长任务' : '●流畅';
    hm.className = busy ? 'warn' : 'ok';
  }
  function updateHUDStatic() {
    $('hMode').textContent = renderer ? renderer.name : '-';
    if (volume) {
      $('hVol').textContent = volume.size + '³';
      $('hVram').textContent = (volumeBytes(volume.size) / 1048576).toFixed(1) + ' MB';
    }
  }

  /* ---------- 画布交互 ---------- */
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth * dpr, h = canvas.clientHeight * dpr;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
  }
  window.addEventListener('resize', resize);

  let dragging = false, px = 0, py = 0;
  function bindCanvasEvents() {
    canvas.addEventListener('pointerdown', (e) => {
      dragging = true; px = e.clientX; py = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      state.rotY += (e.clientX - px) * 0.008;
      state.rotX += (e.clientY - py) * 0.008;
      px = e.clientX; py = e.clientY;
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.zoom = Math.min(8, Math.max(1.0, state.zoom * (1 + e.deltaY * 0.001)));
    }, { passive: false });
  }

  /* ---------- UI 绑定 ---------- */
  function bindUI() {
    $('volType').addEventListener('change', (e) => { state.volType = e.target.value; loadVolume(); });
    $('volSize').addEventListener('change', (e) => { state.volSize = +e.target.value; loadVolume(); });
    $('btnReload').addEventListener('click', loadVolume);

    const tf = new TFEditor($('tfCanvas'), (lut) => {
      tfLut = lut;
      if (renderer) renderer.setTF(lut);
    });
    tf.setPreset('bone');
    $('tfPreset').addEventListener('change', (e) => tf.setPreset(e.target.value));

    bindSlider('density', 'densityOut', (v) => { state.density = v; });
    bindSlider('steps', 'stepsOut', (v) => {
      state.userSteps = Math.round(v);
      state.steps = state.userSteps;
    });
    bindSlider('scale', 'scaleOut', (v) => { state.scale = v; });
    $('adaptive').addEventListener('change', (e) => { state.adaptive = e.target.checked; });

    const clipIds = ['cx0','cx1','cy0','cy1','cz0','cz1'];
    clipIds.forEach((id, i) => {
      const el = $(id), out = el.parentElement.querySelector('output');
      el.addEventListener('input', () => {
        const v = +el.value;
        out.textContent = v.toFixed(2);
        const arr = i % 2 === 0 ? state.clipMin : state.clipMax;
        arr[(i / 2) | 0] = v;
      });
    });
    $('btnResetClip').addEventListener('click', () => {
      state.clipMin = [0, 0, 0]; state.clipMax = [1, 1, 1];
      clipIds.forEach((id, i) => {
        const el = $(id);
        el.value = i % 2 === 0 ? 0 : 1;
        el.parentElement.querySelector('output').textContent = (+el.value).toFixed(2);
      });
    });

    $('forceNo3D').addEventListener('change', (e) => { state.forceNo3D = e.target.checked; });
    $('vramBudget').addEventListener('change', (e) => {
      state.vramBudgetMB = Math.max(1, +e.target.value || 256);
    });
    $('btnApplyDegrade').addEventListener('click', async () => {
      if (!buildRenderer()) return;
      updateHUDStatic();
      await loadVolume();
    });
  }

  function bindSlider(id, outId, apply) {
    const el = $(id), out = $(outId);
    el.addEventListener('input', () => {
      const v = +el.value;
      out.textContent = v.toFixed(2);
      apply(v);
    });
  }

  /* ---------- 启动 ---------- */
  async function start() {
    resize();
    bindUI();
    if (!buildRenderer()) return;
    await loadVolume();
    updateHUDStatic();
    requestAnimationFrame(frame);
  }
  start();
})();
