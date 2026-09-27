// 性能监控：rAF 帧率统计 + PerformanceObserver 长任务检测
class PerfMonitor {
  constructor() {
    this.fps = 0;
    this.frameMs = 0;
    this.longTasks = 0;
    this._last = 0;
    this._frames = 0;
    this._windowStart = 0;
    this._recent = []; // 最近帧耗时滑动窗口，用于稳定的自动降级判断
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        const obs = new PerformanceObserver((list) => {
          this.longTasks += list.getEntries().length;
        });
        obs.observe({ entryTypes: ['longtask'] });
      } catch (err) { /* 浏览器不支持 longtask 时忽略 */ }
    }
  }

  // 每帧调用；每 500ms 返回一次 true 表示统计已刷新
  tick(now) {
    if (this._last) {
      this._recent.push(now - this._last);
      if (this._recent.length > 90) this._recent.shift();
    }
    this._last = now;
    this._frames++;
    if (!this._windowStart) this._windowStart = now;
    const elapsed = now - this._windowStart;
    if (elapsed >= 500) {
      this.fps = (this._frames * 1000) / elapsed;
      this.frameMs = elapsed / this._frames;
      this._frames = 0;
      this._windowStart = now;
      return true;
    }
    return false;
  }

  avgFps() {
    if (!this._recent.length) return 0;
    const sum = this._recent.reduce((a, b) => a + b, 0);
    const avg = sum / this._recent.length;
    return avg > 0 ? 1000 / avg : 0;
  }
}
