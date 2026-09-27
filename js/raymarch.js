/* WebGL2 光线步进体积渲染器:3D 纹理 + 传输函数 + Phong 光照 + 裁剪盒 */
const Raymarcher = (() => {
  const MAX_STEPS = 1024;

  const VERT = `#version 300 es
layout(location=0) in vec3 aPos;
uniform mat4 uMVP;
uniform vec3 uScale;
out vec3 vPos;
void main() {
  vPos = aPos;
  vec3 world = (aPos - 0.5) * uScale;
  gl_Position = uMVP * vec4(world, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
uniform sampler3D uVolume;
uniform sampler2D uTF;
uniform vec3 uCamPos;     // 体积[0,1]空间
uniform vec3 uClipMin;
uniform vec3 uClipMax;
uniform int uSteps;
uniform float uDensity;
uniform vec3 uLightDir;   // 体积空间,指向光源
uniform vec3 uTexel;      // 1/size
in vec3 vPos;
out vec4 outColor;

vec2 intersectBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t1 = (bmin - ro) * inv;
  vec3 t2 = (bmax - ro) * inv;
  vec3 tmin = min(t1, t2), tmax = max(t1, t2);
  return vec2(max(max(tmin.x, tmin.y), tmin.z),
              min(min(tmax.x, tmax.y), tmax.z));
}

vec3 gradient(vec3 p) {
  return vec3(
    texture(uVolume, p + vec3(uTexel.x, 0, 0)).r - texture(uVolume, p - vec3(uTexel.x, 0, 0)).r,
    texture(uVolume, p + vec3(0, uTexel.y, 0)).r - texture(uVolume, p - vec3(0, uTexel.y, 0)).r,
    texture(uVolume, p + vec3(0, 0, uTexel.z)).r - texture(uVolume, p - vec3(0, 0, uTexel.z)).r
  );
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = normalize(vPos - ro);
  vec2 t = intersectBox(ro, rd, uClipMin, uClipMax);
  if (t.x >= t.y) discard;
  t.x = max(t.x, 0.0);
  float dt = (t.y - t.x) / float(uSteps);
  vec3 p = ro + rd * (t.x + dt * 0.5);
  vec3 L = normalize(uLightDir);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < ${MAX_STEPS}; i++) {
    if (i >= uSteps || acc.a > 0.97) break;
    float v = texture(uVolume, p).r;
    vec4 c = texture(uTF, vec2(v, 0.5));
    // 按步长校正不透明度,保证不同步进次数下观感一致
    c.a = 1.0 - pow(1.0 - clamp(c.a * uDensity, 0.0, 1.0), dt * 150.0);
    if (c.a > 0.004) {
      vec3 g = gradient(p);
      float gl = length(g);
      vec3 n = gl > 1e-4 ? g / gl : vec3(0.0, 0.0, 1.0);
      float diff = max(dot(n, L), 0.0);
      vec3 h = normalize(L - rd);
      float spec = pow(max(dot(n, h), 0.0), 40.0);
      c.rgb = c.rgb * (0.25 + 0.85 * diff) + vec3(spec * 0.35);
      // 前向合成
      acc.rgb += (1.0 - acc.a) * c.a * c.rgb;
      acc.a   += (1.0 - acc.a) * c.a;
    }
    p += rd * dt;
  }
  vec3 bg = vec3(0.075, 0.085, 0.11);
  outColor = vec4(acc.rgb + (1.0 - acc.a) * bg, 1.0);
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
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Link: ' + gl.getProgramInfoLog(prog));
    }
    const U = {};
    for (const name of ['uMVP','uScale','uVolume','uTF','uCamPos','uClipMin','uClipMax',
                        'uSteps','uDensity','uLightDir','uTexel']) {
      U[name] = gl.getUniformLocation(prog, name);
    }

    // 单位立方体(36 顶点)
    const verts = [];
    const faces = [
      [[0,0,0],[1,0,0],[1,1,0],[0,1,0]], // z=0
      [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], // z=1
      [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], // y=0
      [[0,1,0],[1,1,0],[1,1,1],[0,1,1]], // y=1
      [[0,0,0],[0,1,0],[0,1,1],[0,0,1]], // x=0
      [[1,0,0],[1,1,0],[1,1,1],[1,0,1]]  // x=1
    ];
    for (const f of faces) {
      const [a, b, c, d] = f;
      for (const v of [a, b, c, a, c, d]) verts.push(v[0], v[1], v[2]);
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    // 传输函数 LUT 纹理 256x1
    const tfTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tfTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let volTex = null, volSize = 0;

    const api = {
      name: 'WebGL2 光线步进',
      gl,

      /* 返回 false 表示纹理分配失败(调用方应降级) */
      setVolume(data, size) {
        gl.bindTexture(gl.TEXTURE_3D, null);
        if (volTex) { gl.deleteTexture(volTex); volTex = null; }
        volTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_3D, volTex);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size, size, size, 0,
                      gl.RED, gl.UNSIGNED_BYTE, data);
        const err = gl.getError();
        if (err !== gl.NO_ERROR) {
          gl.deleteTexture(volTex); volTex = null;
          return false;
        }
        volSize = size;
        return true;
      },

      setTF(lut) {
        gl.bindTexture(gl.TEXTURE_2D, tfTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0,
                      gl.RGBA, gl.UNSIGNED_BYTE, lut);
      },

      render(p) {
        if (!volTex) return;
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0.075, 0.085, 0.11, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.CULL_FACE);
        gl.cullFace(gl.FRONT); // 画背面,相机在盒内也正确
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, volTex);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, tfTex);
        gl.uniform1i(U.uVolume, 0);
        gl.uniform1i(U.uTF, 1);
        gl.uniformMatrix4fv(U.uMVP, false, p.mvp);
        gl.uniform3fv(U.uScale, p.scale);
        gl.uniform3fv(U.uCamPos, p.camPosVol);
        gl.uniform3fv(U.uClipMin, p.clipMin);
        gl.uniform3fv(U.uClipMax, p.clipMax);
        gl.uniform1i(U.uSteps, Math.min(p.steps, MAX_STEPS));
        gl.uniform1f(U.uDensity, p.density);
        gl.uniform3fv(U.uLightDir, p.lightDirVol);
        gl.uniform3f(U.uTexel, 1 / volSize, 1 / volSize, 1 / volSize);
        gl.drawArrays(gl.TRIANGLES, 0, 36);
      },

      dispose() {
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    };
    return api;
  }

  return { create, MAX_STEPS };
})();
