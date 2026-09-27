/* 传输函数编辑器:控制点 -> 256 项 RGBA LUT(TypedArray),Canvas 交互编辑 */
class TFEditor {
  constructor(canvas, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange;
    this.stops = [];
    this.lut = new Uint8Array(256 * 4);
    this.dragIdx = -1;
    this.presets = TFEditor.buildPresets();
    this.bindEvents();
  }

  static buildPresets() {
    return {
      bone: [
        { x: 0.00, r: 0,   g: 0,   b: 0,   a: 0 },
        { x: 0.25, r: 90,  g: 60,  b: 40,  a: 0.05 },
        { x: 0.55, r: 200, g: 160, b: 120, a: 0.35 },
        { x: 0.80, r: 255, g: 240, b: 210, a: 0.9 },
        { x: 1.00, r: 255, g: 255, b: 255, a: 1 }
      ],
      rainbow: [
        { x: 0.00, r: 0,   g: 0,   b: 0,   a: 0 },
        { x: 0.20, r: 40,  g: 40,  b: 220, a: 0.15 },
        { x: 0.45, r: 30,  g: 200, b: 120, a: 0.3 },
        { x: 0.70, r: 240, g: 200, b: 40,  a: 0.55 },
        { x: 1.00, r: 255, g: 60,  b: 40,  a: 0.95 }
      ],
      fire: [
        { x: 0.00, r: 0,   g: 0,   b: 0,   a: 0 },
        { x: 0.30, r: 120, g: 10,  b: 0,   a: 0.2 },
        { x: 0.60, r: 255, g: 120, b: 0,   a: 0.5 },
        { x: 0.85, r: 255, g: 230, b: 80,  a: 0.85 },
        { x: 1.00, r: 255, g: 255, b: 240, a: 1 }
      ],
      gray: [
        { x: 0.00, r: 0,   g: 0,   b: 0,   a: 0 },
        { x: 0.35, r: 90,  g: 90,  b: 90,  a: 0.1 },
        { x: 0.70, r: 190, g: 190, b: 190, a: 0.5 },
        { x: 1.00, r: 255, g: 255, b: 255, a: 1 }
      ]
    };
  }

  setPreset(name) {
    this.stops = this.presets[name].map(s => ({ ...s }));
    this.rebuild();
  }

  /* 控制点线性插值 -> 256x4 LUT */
  rebuild() {
    const s = this.stops.slice().sort((a, b) => a.x - b.x);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      let lo = s[0], hi = s[s.length - 1];
      for (let k = 0; k < s.length - 1; k++) {
        if (t >= s[k].x && t <= s[k + 1].x) { lo = s[k]; hi = s[k + 1]; break; }
      }
      const span = Math.max(hi.x - lo.x, 1e-6);
      const f = Math.min(1, Math.max(0, (t - lo.x) / span));
      this.lut[i*4]   = lo.r + (hi.r - lo.r) * f;
      this.lut[i*4+1] = lo.g + (hi.g - lo.g) * f;
      this.lut[i*4+2] = lo.b + (hi.b - lo.b) * f;
      this.lut[i*4+3] = (lo.a + (hi.a - lo.a) * f) * 255;
    }
    this.draw();
    if (this.onChange) this.onChange(this.lut);
  }

  draw() {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    for (let y = 0; y < H; y += 10) {
      for (let x = 0; x < W; x += 10) {
        ctx.fillStyle = ((x + y) / 10) % 2 ? '#1a1d24' : '#22262f';
        ctx.fillRect(x, y, 10, 10);
      }
    }
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W;
      ctx.fillStyle = 'rgba(' + this.lut[i*4] + ',' + this.lut[i*4+1] + ',' +
                      this.lut[i*4+2] + ',' + (this.lut[i*4+3] / 255) + ')';
      ctx.fillRect(x, 0, W / 255 + 1, H);
    }
    ctx.strokeStyle = '#7fd4ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * W, y = H - (this.lut[i*4+3] / 255) * H;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    for (const p of this.stops) {
      ctx.fillStyle = 'rgb(' + p.r + ',' + p.g + ',' + p.b + ')';
      ctx.strokeStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x * W, H - p.a * H, 5, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }

  hitStop(mx, my) {
    const W = this.canvas.width, H = this.canvas.height;
    for (let i = this.stops.length - 1; i >= 0; i--) {
      const dx = this.stops[i].x * W - mx;
      const dy = (1 - this.stops[i].a) * H - my;
      if (dx * dx + dy * dy < 100) return i;
    }
    return -1;
  }

  bindEvents() {
    const pos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return [
        (e.clientX - r.left) * this.canvas.width / r.width,
        (e.clientY - r.top) * this.canvas.height / r.height
      ];
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      const [mx, my] = pos(e);
      this.dragIdx = this.hitStop(mx, my);
      if (this.dragIdx >= 0) this.canvas.setPointerCapture(e.pointerId);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.dragIdx < 0) return;
      const [mx, my] = pos(e);
      const p = this.stops[this.dragIdx];
      p.x = Math.min(1, Math.max(0, mx / this.canvas.width));
      p.a = Math.min(1, Math.max(0, 1 - my / this.canvas.height));
      this.rebuild();
    });
    this.canvas.addEventListener('pointerup', () => { this.dragIdx = -1; });
    this.canvas.addEventListener('dblclick', (e) => {
      const [mx, my] = pos(e);
      const t = mx / this.canvas.width;
      const i = Math.round(t * 255) * 4;
      this.stops.push({
        x: t,
        r: this.lut[i], g: this.lut[i+1], b: this.lut[i+2],
        a: 1 - my / this.canvas.height
      });
      this.rebuild();
    });
    this.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (this.stops.length <= 2) return;
      const [mx, my] = pos(e);
      const idx = this.hitStop(mx, my);
      if (idx >= 0) { this.stops.splice(idx, 1); this.rebuild(); }
    });
  }
}
