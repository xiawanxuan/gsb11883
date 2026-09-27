// 降级渲染器：Canvas 2D 切片。体积数据经传输函数 LUT 映射为 RGBA，
// 使用 ImageData/TypedArray 逐切片生成，覆盖 X/Y/Z 三个轴。
class SliceRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.data = null;
    this.size = 0;
    this.lut = null;
    this.axis = 'z';
    this.index = 0;
    this._img = null;
  }

  uploadVolume(data, size) {
    this.data = data;
    this.size = size;
    this.index = size >> 1;
  }

  setTransferFunction(lut) {
    this.lut = lut;
  }

  setSlice(axis, index) {
    this.axis = axis;
    this.index = Math.max(0, Math.min(this.size - 1, index));
  }

  _sourceIdx(x, y, z) {
    const n = this.size;
    return z * n * n + y * n + x;
  }

  render() {
    const n = this.size;
    const s = this.canvas.clientWidth || this.canvas.width;
    const side = Math.round(Math.min(s, this.canvas.clientHeight || s));
    if (this.canvas.width !== side) {
      this.canvas.width = side;
      this.canvas.height = side;
    }
    if (!this._img || this._img.width !== n || this._img.height !== n) {
      this._img = this.ctx.createImageData(n, n);
    }
    const out = this._img.data;
    const { data, lut, axis, index } = this;

    // 显示坐标 (u,v) -> 体素坐标 (x,y,z)，逐轴取切片
    for (let v = 0; v < n; v++) {
      for (let u = 0; u < n; u++) {
        let x, y, z;
        if (axis === 'z') { x = u; y = n - 1 - v; z = index; }
        else if (axis === 'y') { x = u; y = index; z = n - 1 - v; }
        else { x = index; y = n - 1 - v; z = u; }
        const val = data[this._sourceIdx(x, y, z)];
        const li = val * 4, oi = (v * n + u) * 4;
        out[oi] = lut[li];
        out[oi + 1] = lut[li + 1];
        out[oi + 2] = lut[li + 2];
        out[oi + 3] = 255;
      }
    }

    // 先画到临时 canvas 再放大，避免逐像素 putImageData 的缩放问题
    if (!this._tmp) {
      this._tmp = document.createElement('canvas');
      this._tmp.width = n;
      this._tmp.height = n;
      this._tctx = this._tmp.getContext('2d');
    }
    this._tctx.putImageData(this._img, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, side, side);
    this.ctx.drawImage(this._tmp, 0, 0, side, side);
  }

  dispose() { /* 无 GPU 资源 */ }
}
