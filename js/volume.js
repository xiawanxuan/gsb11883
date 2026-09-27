/* 体积数据:Web Worker 程序化生成 + IndexedDB 缓存,均不阻塞主线程 */
const VolumeStore = (() => {

  /* ---------- Web Worker 源码(经 Blob 加载,兼容 file://) ---------- */
  const workerSrc = `
    function hash3(x, y, z, seed) {
      var n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^
              Math.imul(z, 1274126177) ^ Math.imul(seed, 1013904223);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
    }
    function smooth(t) { return t * t * (3 - 2 * t); }
    function valueNoise(x, y, z, seed) {
      var xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
      var xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
      var c000 = hash3(xi, yi, zi, seed),     c100 = hash3(xi+1, yi, zi, seed);
      var c010 = hash3(xi, yi+1, zi, seed),   c110 = hash3(xi+1, yi+1, zi, seed);
      var c001 = hash3(xi, yi, zi+1, seed),   c101 = hash3(xi+1, yi, zi+1, seed);
      var c011 = hash3(xi, yi+1, zi+1, seed), c111 = hash3(xi+1, yi+1, zi+1, seed);
      var x00 = c000 + (c100 - c000) * xf, x10 = c010 + (c110 - c010) * xf;
      var x01 = c001 + (c101 - c001) * xf, x11 = c011 + (c111 - c011) * xf;
      var y0 = x00 + (x10 - x00) * yf, y1 = x01 + (x11 - x01) * yf;
      return y0 + (y1 - y0) * zf;
    }
    function fbm(x, y, z, oct, seed) {
      var v = 0, amp = 0.5, tot = 0;
      for (var i = 0; i < oct; i++) {
        v += valueNoise(x, y, z, seed + i * 7) * amp;
        tot += amp; amp *= 0.5;
        x *= 2.03; y *= 2.03; z *= 2.03;
      }
      return v / tot;
    }
    function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v | 0); }

    function genSkull(out, n) {
      var inv = 1 / n;
      for (var z = 0; z < n; z++) {
        var pz = (z + 0.5) * inv - 0.5;
        for (var y = 0; y < n; y++) {
          var py = (y + 0.5) * inv - 0.5;
          for (var x = 0; x < n; x++) {
            var px = (x + 0.5) * inv - 0.5;
            // 椭球头骨:壳层高密度,内部脑组织中密度,眼窝鼻腔空洞
            var ex = px / 0.36, ey = py / 0.40, ez = pz / 0.34;
            var r = Math.sqrt(ex*ex + ey*ey + ez*ez);
            var v = 0;
            var shell = 1 - Math.abs(r - 0.92) / 0.10;
            if (shell > 0) v += shell * shell * 230;
            if (r < 0.82) {
              v += 40 + 70 * fbm(px*6+9, py*6+9, pz*6+9, 3, 11);
            }
            // 眼窝
            var e1 = (px-0.13)*(px-0.13)/0.006 + (py+0.02)*(py+0.02)/0.006 + (pz-0.30)*(pz-0.30)/0.008;
            var e2 = (px+0.13)*(px+0.13)/0.006 + (py+0.02)*(py+0.02)/0.006 + (pz-0.30)*(pz-0.30)/0.008;
            if (e1 < 1 || e2 < 1) v *= 0.05;
            // 鼻腔
            var en = px*px/0.004 + (py+0.16)*(py+0.16)/0.006 + (pz-0.30)*(pz-0.30)/0.01;
            if (en < 1) v *= 0.1;
            out[(z*n + y)*n + x] = clamp255(v);
          }
        }
      }
    }

    function genMeta(out, n) {
      var balls = [];
      for (var i = 0; i < 9; i++) {
        balls.push([
          (hash3(i,1,7,3) - 0.5) * 0.55,
          (hash3(i,2,7,5) - 0.5) * 0.55,
          (hash3(i,3,7,9) - 0.5) * 0.55,
          0.05 + hash3(i,4,7,13) * 0.10
        ]);
      }
      var inv = 1 / n;
      for (var z = 0; z < n; z++) {
        var pz = (z + 0.5) * inv - 0.5;
        for (var y = 0; y < n; y++) {
          var py = (y + 0.5) * inv - 0.5;
          for (var x = 0; x < n; x++) {
            var px = (x + 0.5) * inv - 0.5;
            var s = 0;
            for (var b = 0; b < balls.length; b++) {
              var dx = px - balls[b][0], dy = py - balls[b][1], dz = pz - balls[b][2];
              var rr = balls[b][3];
              s += Math.exp(-(dx*dx + dy*dy + dz*dz) / (rr * rr));
            }
            s += 0.25 * fbm(px*5+3, py*5+3, pz*5+3, 3, 23);
            out[(z*n + y)*n + x] = clamp255(s * 160);
          }
        }
      }
    }

    function genNoise(out, n) {
      var inv = 1 / n;
      for (var z = 0; z < n; z++) {
        var pz = (z + 0.5) * inv - 0.5;
        for (var y = 0; y < n; y++) {
          var py = (y + 0.5) * inv - 0.5;
          for (var x = 0; x < n; x++) {
            var px = (x + 0.5) * inv - 0.5;
            var r = Math.sqrt(px*px + py*py + pz*pz);
            var fall = Math.max(0, 1 - r * 2.1);
            var v = fbm(px*4+7, py*4+7, pz*4+7, 4, 41) * fall * 1.6;
            out[(z*n + y)*n + x] = clamp255(v * 255);
          }
        }
      }
    }

    self.onmessage = function(e) {
      var msg = e.data;
      if (msg.cmd !== 'generate') return;
      var n = msg.size;
      var out = new Uint8Array(n * n * n);
      if (msg.type === 'skull') genSkull(out, n);
      else if (msg.type === 'meta') genMeta(out, n);
      else genNoise(out, n);
      // 分片回报进度,便于 UI 显示
      self.postMessage({ done: true, size: n, buffer: out.buffer }, [out.buffer]);
    };
  `;

  let worker = null;
  function getWorker() {
    if (!worker) {
      worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
    }
    return worker;
  }

  function generate(type, size) {
    return new Promise((resolve, reject) => {
      const w = getWorker();
      const onMsg = (e) => {
        if (!e.data.done || e.data.size !== size) return;
        w.removeEventListener('message', onMsg);
        resolve(new Uint8Array(e.data.buffer));
      };
      w.addEventListener('message', onMsg);
      w.onerror = reject;
      w.postMessage({ cmd: 'generate', type, size });
    });
  }

  /* ---------- IndexedDB 缓存 ---------- */
  const DB_NAME = 'vol-render-cache';
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore('volumes');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  function cacheGet(key) {
    return db().then(d => new Promise((resolve) => {
      const req = d.transaction('volumes').objectStore('volumes').get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    })).catch(() => null);
  }
  function cacheSet(key, buf) {
    return db().then(d => new Promise((resolve) => {
      const req = d.transaction('volumes', 'readwrite').objectStore('volumes').put(buf, key);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    })).catch(() => {});
  }

  /* ---------- 对外 API ---------- */
  async function getVolume(type, size) {
    const key = type + ':' + size;
    const cached = await cacheGet(key);
    if (cached && cached.byteLength === size * size * size) {
      return { data: new Uint8Array(cached), size, fromCache: true };
    }
    const data = await generate(type, size);
    cacheSet(key, data.buffer.slice(0));
    return { data, size, fromCache: false };
  }

  return { getVolume };
})();
