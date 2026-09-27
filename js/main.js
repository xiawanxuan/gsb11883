(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const glCanvas = $('gl-canvas');
  const sliceCanvas = $('slice-canvas');
  const badge = $('mode-badge');
  const notice = $('notice');

  const perf = new PerfMonitor();
  let renderer3d = null;
  let renderer2d = null;
  let mode = null; // 'volume' | 'slice'
  let volumeSize = 128;
  let worker = null;
  let seed = 42;
  let lowFpsFrames = 0;
  const LOW_FPS = 25;

  const tf = new TransferFunction($('tf-canvas'), () => {
    renderer3d?.setTransferFunction(tf.getLUT());
    renderer2d?.setTransferFunction(tf.getLUT());
    if (mode === 'slice' && renderer2d) renderer2d.render();
  });

  function setBadge(text, level) {
    badge.textContent = text;
    badge.className = 'badge ' + (level || '');
  }

  function showNotice(msg) {
    if (msg) { notice.textContent = msg; notice.hidden = false; }
    else { notice.hidden = true; }
  }

  // ---------- 能力检测与降级 ----------
  function detectCapability(n) {
    if (!VolumeRenderer3D.isWebGL2Available()) {
      return { ok: false, reason: '浏览器不支持 WebGL2（无法使用 3D 纹理）' };
    }
    if (!VolumeRenderer3D.canAllocate3D(n)) {
      const mem = navigator.deviceMemory || 'unknown';
      return {
        ok: false,
        reason: `无法分配 ${n}³ 3D 纹理（显存不足或超出 MAX_3D_TEXTURE_SIZE，deviceMemory=${mem}）`,
      };
    }
    return { ok: true };
  }

  // 选择可用分辨率：目标 -> 96 -> 64 逐级下探
  function pickVolumeSize(preferred) {
    const order = [...new Set([preferred, 96, 64])]
      .filter((n) => n <= preferred).sort((a, b) => b - a);
    for (const n of order) {
      if (detectCapability(n).ok) return { size: n, downgraded: n !== preferred };
    }
    return { size: null, downgraded: true };
  }

  // ---------- Worker 数据生成 + IndexedDB 缓存 ----------
  function requestGenerate(size, s) {
    return new Promise((resolve, reject) => {
      if (!worker) worker = new Worker('js/worker.js');
      worker.onmessage = (e) => {
        const { size: n, data: buf, hist: hbuf } = e.data;
        VolumeCache.put(`vol-${n}-${s}`, { data: buf, hist: hbuf, size: n });
        resolve({ size: n, data: new Uint8Array(buf), hist: new Uint32Array(hbuf) });
      };
      worker.onerror = (e) => reject(new Error(e.message));
      worker.postMessage({ size, seed: s });
    });
  }

  async function loadVolume(size, s) {
    const cached = await VolumeCache.get(`vol-${size}-${s}`);
    if (cached && cached.data && cached.data.byteLength === size ** 3) {
      return {
        size,
        data: new Uint8Array(cached.data),
        hist: cached.hist ? new Uint32Array(cached.hist) : null,
        fromCache: true,
      };
    }
    const r = await requestGenerate(size, s);
    return { ...r, fromCache: false };
  }

  // ---------- 模式切换 ----------
  function switchMode(targetMode, data, size, downgradeMsg) {
    if (renderer3d) { renderer3d.dispose(); renderer3d = null; }
    renderer2d = null;

    if (targetMode === 'volume') {
      mode = 'volume';
      glCanvas.hidden = false;
      sliceCanvas.hidden = true;
      try {
        renderer3d = new VolumeRenderer3D(glCanvas);
        renderer3d.uploadVolume(data, size);
        renderer3d.setTransferFunction(tf.getLUT());
        syncParams(renderer3d);
        setBadge(`体积渲染 · ${size}³ · WebGL2`, 'ok');
        showNotice(downgradeMsg || '');
      } catch (err) {
        console.warn('体积渲染初始化失败，降级到切片:', err);
        if (renderer3d) { renderer3d.dispose(); renderer3d = null; }
        enterSlice(data, size,
          `${downgradeMsg ? downgradeMsg + '；' : ''}体积渲染失败（${err.message}），已降级为切片渲染`);
      }
    } else {
      enterSlice(data, size, downgradeMsg ||
        '降级模式：3D 纹理不可用或显存不足，使用 Canvas 2D 切片渲染');
    }
    updateSlicePanel();
  }

  function enterSlice(data, size, msg) {
    mode = 'slice';
    glCanvas.hidden = true;
    sliceCanvas.hidden = false;
    renderer2d = new SliceRenderer(sliceCanvas);
    renderer2d.uploadVolume(data, size);
    renderer2d.setTransferFunction(tf.getLUT());
    renderer2d.setSlice($('sel-axis').value,
      Math.min(size - 1, +$('rng-slice').value || (size >> 1)));
    renderer2d.render();
    setBadge(`切片渲染（降级） · ${size}³`, 'warn');
    showNotice(msg);
  }

  function updateSlicePanel() {
    $('slice-panel').open = mode === 'slice';
    $('stat-mode').textContent = mode === 'volume' ? '体积' : '切片(降级)';
    $('stat-mode').style.color = mode === 'volume' ? '' : '#f0c36d';
    $('rng-slice').max = volumeSize - 1;
  }

  // ---------- UI 参数同步 ----------
  function syncParams(r) {
    const p = r.params;
    p.steps = +$('rng-steps').value;
    p.alphaScale = +$('rng-alpha').value;
    p.distance = +$('rng-zoom').value;
    p.ambient = +$('rng-amb').value;
    p.diffuse = +$('rng-diff').value;
    p.specular = +$('rng-spec').value;
    p.lightAngle = (+$('rng-light').value) * Math.PI / 180;
    const axes = ['x', 'y', 'z'];
    for (let i = 0; i < 3; i++) {
      const lo = +$(`rng-clip${axes[i]}0`).value / 100;
      const hi = +$(`rng-clip${axes[i]}1`).value / 100;
      p.clipMin[i] = lo;
      p.clipMax[i] = Math.max(lo + 0.01, hi);
    }
  }

  const clipAxes = ['x', 'y', 'z'];
  clipAxes.forEach((ax) => {
    const lo = $(`rng-clip${ax}0`), hi = $(`rng-clip${ax}1`);
    const lbl = $(`lbl-clip${ax}`);
    const update = () => {
      let a = +lo.value, b = +hi.value;
      if (a > b - 1) { a = b - 1; lo.value = a; }
      if (b < a + 1) { b = a + 1; hi.value = b; }
      lbl.textContent = `${a}% – ${b}%`;
      if (renderer3d) syncParams(renderer3d);
    };
    lo.addEventListener('input', update);
    hi.addEventListener('input', update);
  });

  [
    ['rng-steps', 'lbl-steps', (v) => v, (r, v) => { r.params.steps = v; lowFpsFrames = 0; }],
    ['rng-alpha', 'lbl-alpha', (v) => (+v).toFixed(1), (r, v) => { r.params.alphaScale = v; }],
    ['rng-zoom', 'lbl-zoom', (v) => (+v).toFixed(2), (r, v) => { r.params.distance = v; }],
    ['rng-amb', 'lbl-amb', (v) => (+v).toFixed(2), (r, v) => { r.params.ambient = v; }],
    ['rng-diff', 'lbl-diff', (v) => (+v).toFixed(2), (r, v) => { r.params.diffuse = v; }],
    ['rng-spec', 'lbl-spec', (v) => (+v).toFixed(2), (r, v) => { r.params.specular = v; }],
  ].forEach(([rng, lbl, fmt, apply]) => {
    $(rng).addEventListener('input', () => {
      const v = +$(rng).value;
      $(lbl).textContent = fmt(v);
      if (renderer3d) apply(renderer3d, v);
    });
  });

  $('rng-light').addEventListener('input', () => {
    const deg = +$('rng-light').value;
    $('lbl-light').textContent = `${deg}°`;
    if (renderer3d) renderer3d.params.lightAngle = deg * Math.PI / 180;
  });

  $('sel-preset').addEventListener('change', () => tf.setPreset($('sel-preset').value));
  $('btn-tf-reset').addEventListener('click', () => tf.reset());
  $('btn-clip-reset').addEventListener('click', () => {
    clipAxes.forEach((ax) => {
      $(`rng-clip${ax}0`).value = 0;
      $(`rng-clip${ax}1`).value = 100;
      $(`lbl-clip${ax}`).textContent = '0% – 100%';
    });
    if (renderer3d) syncParams(renderer3d);
  });

  $('sel-axis').addEventListener('change', () => {
    if (!renderer2d) return;
    renderer2d.setSlice($('sel-axis').value, +$('rng-slice').value);
    renderer2d.render();
  });
  $('rng-slice').addEventListener('input', () => {
    const i = +$('rng-slice').value;
    $('lbl-slice').textContent = i;
    if (renderer2d) {
      renderer2d.setSlice($('sel-axis').value, i);
      renderer2d.render();
    }
  });

  // 拖拽旋转、滚轮缩放（仅体积模式）
  let dragging = false, lastX = 0, lastY = 0;
  glCanvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    glCanvas.setPointerCapture(e.pointerId);
  });
  glCanvas.addEventListener('pointermove', (e) => {
    if (!dragging || !renderer3d) return;
    renderer3d.params.yaw += (e.clientX - lastX) * 0.01;
    renderer3d.params.pitch = Math.max(-1.4, Math.min(1.4,
      renderer3d.params.pitch + (e.clientY - lastY) * 0.01));
    lastX = e.clientX; lastY = e.clientY;
  });
  glCanvas.addEventListener('pointerup', () => { dragging = false; });
  glCanvas.addEventListener('wheel', (e) => {
    if (!renderer3d) return;
    e.preventDefault();
    const rng = $('rng-zoom');
    rng.value = Math.max(+rng.min, Math.min(+rng.max, +rng.value + e.deltaY * 0.002));
    $('lbl-zoom').textContent = (+rng.value).toFixed(2);
    renderer3d.params.distance = +rng.value;
  }, { passive: false });

  // ---------- 自适应步进 ----------
  function adaptiveStep() {
    if (mode !== 'volume' || !$('chk-auto').checked || !renderer3d) return;
    const fps = perf.avgFps();
    if (fps && fps < LOW_FPS) {
      lowFpsFrames++;
      // 持续约 2 秒低帧率才降级，避免抖动
      if (lowFpsFrames > 120 && renderer3d.params.steps > 32) {
        const cur = renderer3d.params.steps;
        const next = Math.max(32, Math.round(cur * 0.625 / 16) * 16);
        if (next !== cur) {
          renderer3d.params.steps = next;
          $('rng-steps').value = next;
          $('lbl-steps').textContent = next;
          showNotice(`帧率 ${fps.toFixed(0)} FPS 持续偏低，步进次数已从 ${cur} 自动降到 ${next}`);
        }
        lowFpsFrames = 0;
      }
    } else if (fps > LOW_FPS + 10) {
      lowFpsFrames = 0;
    }
  }

  // ---------- 主循环 ----------
  function frame(now) {
    if (perf.tick(now)) {
      $('stat-fps').textContent = perf.fps.toFixed(1);
      $('stat-frame').textContent = perf.frameMs.toFixed(1);
      $('stat-longtask').textContent = perf.longTasks;
    }
    if (mode === 'volume' && renderer3d) {
      renderer3d.render();
      $('stat-steps').textContent = renderer3d.params.steps;
      adaptiveStep();
    } else {
      $('stat-steps').textContent = '--';
    }
    requestAnimationFrame(frame);
  }

  // ---------- 启动 ----------
  async function boot() {
    const pref = $('sel-mode').value;
    const preferred = +$('sel-size').value;
    setBadge('检测能力…', '');

    let size = preferred;
    let downgradeMsg = '';
    let target = pref === 'slice' ? 'slice' : 'volume';

    if (pref === 'auto' || pref === 'volume') {
      const cap = detectCapability(preferred);
      if (!cap.ok) {
        if (pref === 'volume') {
          target = 'slice';
          downgradeMsg = `${cap.reason}，已降级为切片渲染`;
        } else {
          const picked = pickVolumeSize(preferred);
          if (picked.size) {
            size = picked.size;
            if (picked.downgraded) {
              downgradeMsg = `${cap.reason}；已自动降为 ${size}³ 体积`;
            }
          } else {
            target = 'slice';
            downgradeMsg = `${cap.reason}，且 64³ 也无法分配，已降级为切片渲染`;
          }
        }
      }
    }

    volumeSize = size;
    setBadge('生成体积数据…', '');
    const vol = await loadVolume(size, seed);
    if (vol.hist) tf.setHistogram(vol.hist);

    switchMode(target, vol.data, vol.size, downgradeMsg);
    $('lbl-slice').textContent = Math.min(size - 1, size >> 1);
    $('rng-slice').value = Math.min(size - 1, size >> 1);
  }

  $('sel-mode').addEventListener('change', boot);
  $('sel-size').addEventListener('change', boot);
  $('btn-regen').addEventListener('click', () => { seed = (seed * 9301 + 49297) % 233280; boot(); });

  boot().catch((err) => {
    setBadge('初始化失败', 'err');
    showNotice(String(err));
    console.error(err);
  });
  requestAnimationFrame(frame);
})();
