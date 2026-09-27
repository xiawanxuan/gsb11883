// 传输函数编辑器：透明度曲线（可拖拽节点）+ 颜色预设 + 直方图背景
// 输出 256x1 RGBA 查找表（Uint8Array），供 3D 纹理与切片渲染共用
class TransferFunction {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || (() => {});
    this.points = [];       // {x: 0..1, a: 0..1}，按 x 排序
    this.preset = 'ct';
    this.histogram = null;  // Uint32Array(256)
    this.lut = new Uint8Array(256 * 4);
    this._drag = -1;
    this.reset();
    this._bindEvents();
  }

  reset() {
    this.points = [
      { x: 0.0, a: 0.0 },
      { x: 0.25, a: 0.0 },
      { x: 0.45, a: 0.15 },
      { x: 0.65, a: 0.55 },
      { x: 0.85, a: 0.9 },
      { x: 1.0, a: 1.0 },
    ];
    this._rebuild();
  }

  setPreset(name) {
    this.preset = name;
    this._rebuild();
  }

  setHistogram(hist) {
    this.histogram = hist;
    this._draw();
  }

  getLUT() { return this.lut; }

  _colorAt(t) {
    const presets = {
      gray: [[0, 0, 0], [255, 255, 255]],
      hot: [[0, 0, 0], [180, 0, 0], [255, 200, 0], [255, 255, 255]],
      cool: [[0, 20, 60], [0, 120, 200], [120, 220, 255], [255, 255, 255]],
      ct: [[30, 10, 10], [120, 60, 40], [220, 190, 150], [255, 250, 240]],
    };
    const stops = presets[this.preset] || presets.gray;
    const pos = t * (stops.length - 1);
    const i = Math.min(Math.floor(pos), stops.length - 2);
    const f = pos - i;
    const c0 = stops[i], c1 = stops[i + 1];
    return [
      c0[0] + (c1[0] - c0[0]) * f,
      c0[1] + (c1[1] - c0[1]) * f,
      c0[2] + (c1[2] - c0[2]) * f,
    ];
  }

  _alphaAt(t) {
    const pts = this.points;
    if (t <= pts[0].x) return pts[0].a;
    for (let i = 0; i < pts.length - 1; i++) {
      if (t <= pts[i + 1].x) {
        const span = pts[i + 1].x - pts[i].x || 1e-6;
        const f = (t - pts[i].x) / span;
        return pts[i].a + (pts[i + 1].a - pts[i].a) * f;
      }
    }
    return pts[pts.length - 1].a;
  }

  _rebuild() {
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const [r, g, b] = this._colorAt(t);
      const a = Math.max(0, Math.min(1, this._alphaAt(t)));
      this.lut[i * 4] = r;
      this.lut[i * 4 + 1] = g;
      this.lut[i * 4 + 2] = b;
      this.lut[i * 4 + 3] = Math.round(a * 255);
    }
    this._draw();
    this.onChange(this.lut);
  }

  _draw() {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    // 直方图背景
    if (this.histogram) {
      let max = 1;
      for (let i = 1; i < 256; i++) max = Math.max(max, this.histogram[i]);
      ctx.fillStyle = 'rgba(90, 120, 160, 0.35)';
      for (let i = 0; i < 256; i++) {
        const v = Math.log1p(this.histogram[i]) / Math.log1p(max);
        const bh = v * (h - 4);
        ctx.fillRect((i / 256) * w, h - bh, w / 256 + 0.5, bh);
      }
    }

    // 颜色条
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = this._colorAt(i / 255);
      ctx.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`;
      ctx.fillRect((i / 256) * w, h - 6, w / 256 + 0.5, 6);
    }

    // 透明度曲线
    ctx.strokeStyle = '#7fd4ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * w;
      const y = (1 - this._alphaAt(i / 255)) * (h - 10);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 节点
    for (const p of this.points) {
      ctx.fillStyle = '#ffd27f';
      ctx.beginPath();
      ctx.arc(p.x * w, (1 - p.a) * (h - 10), 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _hit(mx, my) {
    const h = this.canvas.height;
    for (let i = 0; i < this.points.length; i++) {
      const px = this.points[i].x * this.canvas.width;
      const py = (1 - this.points[i].a) * (h - 10);
      if ((mx - px) ** 2 + (my - py) ** 2 < 64) return i;
    }
    return -1;
  }

  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [
      ((e.clientX - r.left) / r.width) * this.canvas.width,
      ((e.clientY - r.top) / r.height) * this.canvas.height,
    ];
  }

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      const [mx, my] = this._pos(e);
      this._drag = this._hit(mx, my);
      if (this._drag >= 0) c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (this._drag < 0) return;
      const [mx, my] = this._pos(e);
      const p = this.points[this._drag];
      p.x = Math.max(0, Math.min(1, mx / c.width));
      p.a = Math.max(0, Math.min(1, 1 - my / (c.height - 10)));
      this.points.sort((a, b) => a.x - b.x);
      this._drag = this.points.indexOf(p);
      this._rebuild();
    });
    c.addEventListener('pointerup', () => { this._drag = -1; });
    c.addEventListener('dblclick', (e) => {
      const [mx, my] = this._pos(e);
      if (this._hit(mx, my) >= 0) return;
      this.points.push({
        x: Math.max(0, Math.min(1, mx / c.width)),
        a: Math.max(0, Math.min(1, 1 - my / (c.height - 10))),
      });
      this.points.sort((a, b) => a.x - b.x);
      this._rebuild();
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [mx, my] = this._pos(e);
      const i = this._hit(mx, my);
      if (i >= 0 && this.points.length > 2) {
        this.points.splice(i, 1);
        this._rebuild();
      }
    });
  }
}
