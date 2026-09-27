/* 降级渲染器:WebGL1 切片合成(不依赖 3D 纹理)
   沿视线主轴提取 2D 切片纹理,由远及近 alpha 混合,传输函数经 1D LUT 纹理应用 */
const Slicer = (() => {
  const VERT = `
attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uMVP;
uniform vec3 uScale;
varying vec2 vUV;
void main() {
  vUV = aUV;
  vec3 world = (aPos - 0.5) * uScale;
  gl_Position = uMVP * vec4(world, 1.0);
}`;

  const FRAG = `
precision mediump float;
uniform sampler2D uSlice;
uniform sampler2D uTF;
uniform float uDensity;
varying vec2 vUV;
void main() {
  float v = texture2D(uSlice, vUV).r;
  vec4 c = texture2D(uTF, vec2(v, 0.5));
  c.a *= uDensity;
  gl_FragColor = vec4(c.rgb, c.a);
}`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function create(canvas) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false }) ||
               canvas.getContext('experimental-webgl', { antialias: false, alpha: false });
    if (!gl) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(prog, 0, 'aPos');
    gl.bindAttribLocation(prog, 1, 'aUV');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Link: ' + gl.getProgramInfoLog(prog));
    }
    const U = {};
    for (const n of ['uMVP','uScale','uSlice','uTF','uDensity']) {
      U[n] = gl.getUniformLocation(prog, n);
    }

    const tfTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tfTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const posBuf = gl.createBuffer();
    const uvBuf = gl.createBuffer();

    let volData = null, volSize = 0;
    let sliceTexs = [], sliceAxis = -1, sliceCount = 0;

    /* 从体积数据提取 axis 方向的 n 张 2D 切片 */
    function buildSlices(axis) {
      for (const t of sliceTexs) gl.deleteTexture(t);
      sliceTexs = [];
      const n = volSize, d = volData;
      for (let i = 0; i < n; i++) {
        const img = new Uint8Array(n * n);
        for (let v = 0; v < n; v++) {
          for (let u = 0; u < n; u++) {
            let x, y, z;
            if (axis === 0) { x = i; y = v; z = u; }
            else if (axis === 1) { x = u; y = i; z = v; }
            else { x = u; y = v; z = i; }
            img[v * n + u] = d[(z * n + y) * n + x];
          }
        }
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, n, n, 0,
                      gl.LUMINANCE, gl.UNSIGNED_BYTE, img);
        sliceTexs.push(tex);
      }
      sliceAxis = axis;
      sliceCount = n;
    }

    const api = {
      name: 'WebGL1 切片渲染(降级)',
      gl,

      setVolume(data, size) {
        volData = data; volSize = size;
        sliceAxis = -1; // 强制重建
        return true;
      },

      setTF(lut) {
        gl.bindTexture(gl.TEXTURE_2D, tfTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0,
                      gl.RGBA, gl.UNSIGNED_BYTE, lut);
      },

      render(p) {
        if (!volData) return;
        // 选视线主轴
        const dv = p.viewDirVol;
        const ax = [Math.abs(dv[0]), Math.abs(dv[1]), Math.abs(dv[2])];
        const axis = ax[0] > ax[1] ? (ax[0] > ax[2] ? 0 : 2) : (ax[1] > ax[2] ? 1 : 2);
        if (axis !== sliceAxis) buildSlices(axis);

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.075, 0.085, 0.11, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(prog);
        gl.uniformMatrix4fv(U.uMVP, false, p.mvp);
        gl.uniform3fv(U.uScale, p.scale);
        gl.uniform1i(U.uSlice, 0);
        gl.uniform1i(U.uTF, 1);
        gl.uniform1f(U.uDensity, p.density * 128 / sliceCount);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tfTex);
        gl.activeTexture(gl.TEXTURE0);

        // 裁剪边界 -> 该轴切片下标范围
        const lo = Math.max(0, Math.floor(p.clipMin[axis] * (sliceCount - 1)));
        const hi = Math.min(sliceCount - 1, Math.ceil(p.clipMax[axis] * (sliceCount - 1)));
        // 视线朝正轴向时远处是低下标,由远及近绘制
        const forward = dv[axis] > 0;
        // u/v 轴与 buildSlices 的纹理布局保持一致
        const uAxis = axis === 0 ? 2 : 0;
        const vAxis = axis === 0 ? 1 : (axis === 1 ? 2 : 1);
        const quad = [[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]];
        const positions = new Float32Array(18);
        const uvs = new Float32Array(12);
        gl.enableVertexAttribArray(0);
        gl.enableVertexAttribArray(1);

        for (let k = lo; k <= hi; k++) {
          const i = forward ? k : hi - (k - lo);
          const t = sliceCount === 1 ? 0.5 : i / (sliceCount - 1);
          for (let vi = 0; vi < 6; vi++) {
            const su = quad[vi][0], sv = quad[vi][1];
            const cu = p.clipMin[uAxis] + su * (p.clipMax[uAxis] - p.clipMin[uAxis]);
            const cv = p.clipMin[vAxis] + sv * (p.clipMax[vAxis] - p.clipMin[vAxis]);
            const coord = [0, 0, 0];
            coord[axis] = t; coord[uAxis] = cu; coord[vAxis] = cv;
            positions[vi*3] = coord[0]; positions[vi*3+1] = coord[1]; positions[vi*3+2] = coord[2];
            // 纹理覆盖整轴,UV 即体积坐标
            uvs[vi*2] = cu; uvs[vi*2+1] = cv;
          }
          gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
          gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
          gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
          gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
          gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.DYNAMIC_DRAW);
          gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
          gl.bindTexture(gl.TEXTURE_2D, sliceTexs[i]);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      },

      dispose() {
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    };
    return api;
  }

  return { create };
})();
