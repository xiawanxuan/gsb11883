# WebGL 体积渲染(光线步进)

纯前端体积渲染演示:WebGL2 光线步进 + 完整降级链,零构建、零依赖。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

(Worker 经 Blob 内联加载,直接双击 `index.html` 以 file:// 打开亦可运行。)

## 技术栈

- **WebGL2 / GLSL ES 3.00**:光线步进体积渲染(`sampler3D` 3D 纹理)
- **WebGL1**:3D 纹理不可用时的切片合成降级渲染器
- **Canvas 2D**:传输函数控制点编辑器
- **Web Worker**:程序化体积数据生成(颅骨 / 流星体 / 噪声云),不阻塞主线程
- **TypedArray**:`Uint8Array` 体数据、`Uint8Array` 256 项 RGBA 传输函数 LUT
- **PerformanceObserver**:主线程长任务(longtask)监控
- **IndexedDB**:体积数据缓存,二次加载秒开

## 功能与验收对照

| 验收标准 | 实现 |
| --- | --- |
| 体积渲染正确 | 光线-包围盒求交 + 前向 alpha 合成,早终止;相机进入盒内也正确(渲染背面) |
| 传输函数正确 | 控制点线性插值生成 256 项 RGBA LUT,上传为 256x1 纹理,shader 按密度采样 |
| 光照正确 | 中心差分梯度求法线,Blinn-Phong(环境光+漫反射+高光),光源固定在体积空间 |
| 裁剪正确 | 6 轴裁剪边界直接作为光线求交包围盒,剖面可见内部结构 |
| 帧率/步进准确 | FPS/帧耗时为 rAF 实测 EMA;步进次数即 shader uniform,可选自适应调节 |
| 3D 纹理不支持有降级 | 检测 WebGL2 失败(或勾选"禁用 3D 纹理"模拟)自动切换切片渲染 |
| 显存不足有降级 | 显存预算预估 + `texImage3D` 失败捕获,逐级降采样(256→…→32)重试 |
| 降级方案可用 | 切片渲染器支持传输函数、裁剪、缩放、旋转,沿视线主轴动态重切片 |
| 主线程不卡 | 体积生成在 Worker;PerformanceObserver 统计长任务并在 HUD 指示 |

## 操作

- 拖拽旋转,滚轮缩放视角
- 传输函数编辑器:拖动控制点 / 双击添加 / 右键删除
- 降级测试:勾选"禁用 3D 纹理"或调小"显存预算 MB"后点"应用并重建渲染器"

## 文件结构

- `index.html` — 页面、HUD、控制面板
- `js/main.js` — 渲染循环、降级决策、性能监控、UI 绑定
- `js/raymarch.js` — WebGL2 光线步进渲染器
- `js/slicer.js` — WebGL1 切片降级渲染器
- `js/tfeditor.js` — 传输函数编辑器(Canvas)
- `js/volume.js` — Worker 体积生成 + IndexedDB 缓存
- `js/mat4.js` — 矩阵工具
