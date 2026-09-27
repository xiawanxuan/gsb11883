// WebGL2 光线步进体积渲染器：3D 纹理 + 传输函数 + Blinn-Phong 光照 + 裁剪
class VolumeRenderer3D {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;
    this.canvas = canvas;
    this.volumeTex = null;
    this.tfTex = null;
    this.size = 0;
    this.params = {
      steps: 256,
      alphaScale: 1,
      distance: 2.6,
      yaw: 0.6,
      pitch: 0.35,
      clipMin: [0, 0, 0],
      clipMax: [1, 1, 1],
      ambient: 0.25,
      diffuse: 0.8,
      specular: 0.5,
      lightAngle: Math.PI * 0.75,
    };
    this._compile();
    this._initGeom();
    this.resize();
  }

  static isWebGL2Available() {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  }

  // 尝试分配 n^3 的 R8 3D 纹理，用于显存能力探测（返回布尔，不污染实际纹理）
  static canAllocate3D(n) {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
    if (maxSize < n) return false;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, n, n, n, 0,
      gl.RED, gl.UNSIGNED_BYTE, null);
    const ok = gl.getError() === gl.NO_ERROR;
    gl.deleteTexture(tex);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  }

  _compile() {
    const gl = this.gl;
    const vs = `#version 300 es
      out vec2 vUv;
      void main() {
        vUv = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
      }`;
    const fs = `#version 300 es
      precision highp float;
      precision highp sampler3D;
      in vec2 vUv;
      out vec4 outColor;
      uniform sampler3D uVolume;
      uniform sampler2D uTF;
      uniform vec3 uEye;
      uniform float uTanFov;
      uniform float uAspect;
      uniform int uSteps;
      uniform float uAlphaScale;
      uniform vec3 uClipMin;
      uniform vec3 uClipMax;
      uniform float uGradientStep;
      uniform vec3 uAmbientCoef;
      uniform vec3 uLightDir;
      uniform float uShininess;

      vec2 intersectBox(vec3 o, vec3 d, vec3 bmin, vec3 bmax) {
        // 防止 d 的分量恰好为 0 时出现 0*Inf=NaN
        vec3 s = sign(d);
        s = mix(s, vec3(1.0), equal(s, vec3(0.0)));
        vec3 inv = 1.0 / mix(d, s * 1e-8, lessThan(abs(d), vec3(1e-8)));
        vec3 t0 = (bmin - o) * inv;
        vec3 t1 = (bmax - o) * inv;
        vec3 lo = min(t0, t1), hi = max(t0, t1);
        return vec2(max(max(lo.x, lo.y), lo.z),
                    min(min(hi.x, hi.y), hi.z));
      }

      vec3 gradient(vec3 p) {
        float s = uGradientStep;
        float dx = texture(uVolume, p + vec3(s,0.0,0.0)).r
                 - texture(uVolume, p - vec3(s,0.0,0.0)).r;
        float dy = texture(uVolume, p + vec3(0.0,s,0.0)).r
                 - texture(uVolume, p - vec3(0.0,s,0.0)).r;
        float dz = texture(uVolume, p + vec3(0.0,0.0,s)).r
                 - texture(uVolume, p - vec3(0.0,0.0,s)).r;
        return vec3(dx, dy, dz);
      }

      void main() {
        vec2 ndc = vUv * 2.0 - 1.0;
        vec3 fwd = -normalize(uEye);
        vec3 right = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
        vec3 up = cross(right, fwd);
        vec3 rd = normalize(fwd + ndc.x * uAspect * uTanFov * right
                                + ndc.y * uTanFov * up);

        // 在 uvw 空间（0..1）求交：同时与单位盒和裁剪盒相交
        vec3 ro = uEye + vec3(0.5);
        vec2 tUnit = intersectBox(ro, rd, vec3(0.0), vec3(1.0));
        vec2 tClip = intersectBox(ro, rd, uClipMin, uClipMax);
        float tmin = max(max(tUnit.x, tClip.x), 0.0);
        float tmax = min(tUnit.y, tClip.y);

        vec3 bg = mix(vec3(0.02,0.025,0.035), vec3(0.08,0.09,0.11),
                      0.5 + 0.5 * ndc.y);
        if (tmin >= tmax) { outColor = vec4(bg, 1.0); return; }

        float dt = (tmax - tmin) / float(uSteps);
        vec3 acc = vec3(0.0);
        float accA = 0.0;
        for (int i = 0; i < 512; i++) {
          if (i >= uSteps || accA > 0.98) break;
          float t = tmin + (float(i) + 0.5) * dt;
          vec3 p = ro + rd * t;
          float density = texture(uVolume, p).r;
          vec4 tf = texture(uTF, vec2(density, 0.5));
          if (tf.a > 0.003) {
            // 步长相关不透明度校正（参考步长 = 1/256）
            float a = 1.0 - pow(1.0 - tf.a,
                      clamp(uAlphaScale * dt * 256.0, 0.0, 20.0));
            vec3 n = -normalize(gradient(p) + 1e-5);
            float diff = max(dot(n, uLightDir), 0.0);
            vec3 halfV = normalize(uLightDir - rd);
            float spec = pow(max(dot(n, halfV), 0.0), uShininess);
            vec3 shade = tf.rgb * (uAmbientCoef + uAmbientCoef.g * diff)
                       + uAmbientCoef.b * spec;
            acc += (1.0 - accA) * a * shade;
            accA += (1.0 - accA) * a;
          }
        }
        outColor = vec4(acc + (1.0 - accA) * bg, 1.0);
      }`;

    const program = this._link(vs, fs);
    this.program = program;
    this.loc = {
      volume: gl.getUniformLocation(program, 'uVolume'),
      tf: gl.getUniformLocation(program, 'uTF'),
      eye: gl.getUniformLocation(program, 'uEye'),
      tanFov: gl.getUniformLocation(program, 'uTanFov'),
      aspect: gl.getUniformLocation(program, 'uAspect'),
      steps: gl.getUniformLocation(program, 'uSteps'),
      alphaScale: gl.getUniformLocation(program, 'uAlphaScale'),
      clipMin: gl.getUniformLocation(program, 'uClipMin'),
      clipMax: gl.getUniformLocation(program, 'uClipMax'),
      gradientStep: gl.getUniformLocation(program, 'uGradientStep'),
      ambientCoef: gl.getUniformLocation(program, 'uAmbientCoef'),
      lightDir: gl.getUniformLocation(program, 'uLightDir'),
      shininess: gl.getUniformLocation(program, 'uShininess'),
    };
    gl.useProgram(program);
    gl.uniform1i(this.loc.volume, 0);
    gl.uniform1i(this.loc.tf, 1);
  }

  _link(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s));
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p));
    }
    return p;
  }

  _initGeom() {
    // 使用 gl_VertexID，无需 VAO/VBO；WebGL2 要求绑定 VAO
    this.vao = this.gl.createVertexArray();
    this.gl.bindVertexArray(this.vao);
  }

  uploadVolume(data, size) {
    const gl = this.gl;
    if (this.volumeTex) gl.deleteTexture(this.volumeTex);
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, size, size, size, 0,
      gl.RED, gl.UNSIGNED_BYTE, data);
    if (gl.getError() !== gl.NO_ERROR) {
      gl.deleteTexture(tex);
      throw new Error('3D 纹线上传失败（显存不足）');
    }
    this.volumeTex = tex;
    this.size = size;
  }

  setTransferFunction(lut) {
    const gl = this.gl;
    if (!this.tfTex) this.tfTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tfTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, lut);
    gl.activeTexture(gl.TEXTURE0);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render() {
    const gl = this.gl;
    const p = this.params;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    const eye = [
      p.distance * cp * Math.sin(p.yaw),
      p.distance * sp,
      p.distance * cp * Math.cos(p.yaw),
    ];
    gl.uniform3fv(this.loc.eye, eye);
    gl.uniform1f(this.loc.tanFov, Math.tan(0.5 * Math.PI / 4));
    gl.uniform1f(this.loc.aspect, this.canvas.width / this.canvas.height);
    gl.uniform1i(this.loc.steps, p.steps);
    gl.uniform1f(this.loc.alphaScale, p.alphaScale);
    gl.uniform3fv(this.loc.clipMin, p.clipMin);
    gl.uniform3fv(this.loc.clipMax, p.clipMax);
    gl.uniform1f(this.loc.gradientStep, 1 / Math.max(1, this.size));
    gl.uniform3f(this.loc.ambientCoef, p.ambient, p.diffuse, p.specular);
    gl.uniform3f(this.loc.lightDir,
      Math.cos(p.lightAngle), 0.55, Math.sin(p.lightAngle));
    gl.uniform1f(this.loc.shininess, 32);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() {
    // 仅释放资源，不永久丢失上下文：同一 canvas 再次 getContext 会复用该上下文
    const gl = this.gl;
    if (this.volumeTex) { gl.deleteTexture(this.volumeTex); this.volumeTex = null; }
    if (this.tfTex) { gl.deleteTexture(this.tfTex); this.tfTex = null; }
    if (this.program) { gl.deleteProgram(this.program); this.program = null; }
    if (this.vao) { gl.deleteVertexArray(this.vao); this.vao = null; }
  }
}
