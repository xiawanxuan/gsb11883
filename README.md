# WebGL 体积渲染（光线步进）

纯原生实现（无第三方依赖）：WebGL2 3D 纹理光线步进 + 传输函数 + 光照 +
裁剪 + Canvas 2D 切片降级，数据在 Web Worker 中程序化生成并缓存到
IndexedDB，PerformanceObserver 监控主线程长任务。

## 运行

```bash
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

需要支持 WebGL2 的浏览器（Chrome/Firefox/Edge 现代版本）。Worker 与
IndexedDB 要求经 http(s) 提供页面，不要直接用 file:// 打开。

## 功能与实现

| 能力 | 实现 |
| --- | --- |
| 体积渲染 | `js/renderer3d.js`：WebGL2 全屏三角面 + `sampler3D`，ray-box 求交后在裁剪盒内固定步长光线步进，前向 alpha 合成（含步长不透明度校正、0.98 提前终止） |
| 传输函数 | `js/tf.js`：可拖拽透明度节点 + 4 套颜色预设，生成 256×1 RGBA LUT，3D 路径作为 2D 纹理采样，切片路径在 CPU 端索引同一 LUT；背景叠加直方图 |
| 光照 | 体素中心差分梯度求法线，环境光 + Blinn-Phong 漫反射/高光，光源方位可调 |
| 裁剪 | X/Y/Z 三组 min/max（0–100%），着色器对单位盒与裁剪盒分别 slab 求交取交叠区间 |
| 缩放/旋转 | 滚轮与滑条调整相机距离，鼠标拖拽轨道旋转（偏航/俯仰） |
| 帧率/步进显示 | rAF 统计 FPS 与帧耗时，HUD 显示着色器实际使用的步进次数 |
| 3D 纹理不支持降级 | 无 WebGL2 / 超过 `MAX_3D_TEXTURE_SIZE` / 试探性 `texImage3D` 失败 → Canvas 2D 切片渲染 |
| 显存不足降级 | 先按目标分辨率试探分配，失败自动降到 96³、64³；仍失败则切片渲染；运行期上传抛错同样回退 |
| 降级方案 | `js/renderer2d.js`：X/Y/Z 三轴切片，ImageData + TypedArray 应用同一传输函数 |
| 主线程不卡 | 体积生成（值噪声、环面、球体、骨骼结构）全部在 `js/worker.js` 中完成；`PerformanceObserver` 统计 longtask 并在 HUD 显示 |
| 数据缓存 | 生成结果（Uint8Array + Uint32Array 直方图）以 ArrayBuffer 存入 IndexedDB，按 `分辨率+种子` 复用 |
| 自适应性能 | 持续约 2s 平均 FPS < 25 时步进数自动按 0.625 倍率下调（最低 32），并在提示条说明 |

## 目录

- `index.html` — 界面与全部控件
- `js/renderer3d.js` — WebGL2 光线步进渲染器及能力探测
- `js/renderer2d.js` — Canvas 2D 切片降级渲染器
- `js/tf.js` — 传输函数编辑器与 LUT 生成
- `js/worker.js` — 程序化体积数据生成（TypedArray）
- `js/stats.js` — FPS 统计 + PerformanceObserver 长任务
- `js/idb.js` — IndexedDB 缓存封装
- `js/main.js` — 能力检测、降级决策、UI 联动、渲染循环

## 手动验证建议

1. 默认进入体积渲染，HUD 显示 `体积` 模式、FPS、帧耗时、步进次数（=滑条值）。
2. 调整传输函数节点/预设，画面颜色与透明度实时变化。
3. 拖动环境光/漫反射/高光/光源方位，确认明暗与高光变化。
4. 调整 X/Y/Z 裁剪滑条，确认被裁区域出现切平面。
5. 选择“强制切片渲染”，切换 X/Y/Z 轴与切片序号，图像随滑条变化。
6. 在不支持 WebGL2 的环境（或 DevTools 模拟 GPU 阻断）中打开，自动进入切片模式并显示黄色提示条。
