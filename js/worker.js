// Web Worker：程序化生成体积数据（TypedArray），避免阻塞主线程
// 输出 Uint8Array(size^3) + Uint32Array(256) 直方图

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 三线性插值值噪声
function makeNoise(rand, grid) {
  const g = new Float32Array(grid * grid * grid);
  for (let i = 0; i < g.length; i++) g[i] = rand();
  const at = (x, y, z) =>
    g[((z % grid + grid) % grid) * grid * grid +
      ((y % grid + grid) % grid) * grid +
      ((x % grid + grid) % grid)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return function (x, y, z) {
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);
    let v = 0;
    for (let dz = 0; dz <= 1; dz++)
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
          v += w * at(x0 + dx, y0 + dy, z0 + dz);
        }
    return v;
  };
}

function generate(size, seed) {
  const rand = mulberry32(seed);
  const noise1 = makeNoise(rand, 8);
  const noise2 = makeNoise(rand, 16);
  const data = new Uint8Array(size * size * size);
  const c = (size - 1) / 2;
  const inv = 1 / c;

  for (let z = 0; z < size; z++) {
    const nz = (z - c) * inv;
    for (let y = 0; y < size; y++) {
      const ny = (y - c) * inv;
      const rowBase = z * size * size + y * size;
      for (let x = 0; x < size; x++) {
        const nx = (x - c) * inv;
        const r = Math.sqrt(nx * nx + ny * ny + nz * nz);

        // 外壳球（低密度）+ 内核（高密度）+ 环面 + 噪声纹理
        let v = 0;
        if (r < 0.9) v += 0.25 * (1 - r / 0.9);
        if (r < 0.35) v += 0.55 * (1 - r / 0.35);
        const ringR = Math.sqrt(nx * nx + nz * nz);
        const dRing = Math.sqrt((ringR - 0.62) ** 2 + ny * ny);
        if (dRing < 0.1) v += 0.7 * (1 - dRing / 0.1);
        // 一根高密度"骨骼"圆柱
        const dBone = Math.sqrt(nx * nx + (nz - 0.15) ** 2);
        if (dBone < 0.12 && Math.abs(ny) < 0.7) v += 0.8 * (1 - dBone / 0.12);

        const n = noise1(nx * 4 + 4, ny * 4 + 4, nz * 4 + 4) * 0.7 +
                  noise2(nx * 8 + 8, ny * 8 + 8, nz * 8 + 8) * 0.3;
        v *= 0.65 + 0.5 * n;
        if (r > 0.95) v = 0;

        data[rowBase + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
      }
    }
  }
  return data;
}

function histogram(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  return hist;
}

self.onmessage = (e) => {
  const { size, seed } = e.data;
  const data = generate(size, seed);
  const hist = histogram(data);
  self.postMessage(
    { size, data: data.buffer, hist: hist.buffer },
    [data.buffer, hist.buffer]
  );
};
