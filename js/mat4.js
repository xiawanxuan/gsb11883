/* 极简 mat4/vec3 工具,列主序,与 WebGL 一致 */
const Mat4 = {
  ident() {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  },
  multiply(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
      }
    }
    return o;
  },
  perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2), nf = 1 / (near - far);
    return new Float32Array([
      f/aspect,0,0,0,
      0,f,0,0,
      0,0,(far+near)*nf,-1,
      0,0,2*far*near*nf,0
    ]);
  },
  translate(x, y, z) {
    return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1]);
  },
  rotX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
  },
  rotY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
  },
  /* 世界坐标 -> 体积[0,1]坐标: v = 0.5 + R^T * w / scale */
  worldToVolume(w, rot, scale) {
    const r = rot; // 3x3 部分
    return [
      0.5 + (r[0]*w[0] + r[4]*w[1] + r[8]*w[2])  / scale[0],
      0.5 + (r[1]*w[0] + r[5]*w[1] + r[9]*w[2])  / scale[1],
      0.5 + (r[2]*w[0] + r[6]*w[1] + r[10]*w[2]) / scale[2]
    ];
  },
  /* 世界方向 -> 体积空间方向(仅旋转) */
  dirToVolume(d, rot) {
    const r = rot;
    return [
      r[0]*d[0] + r[4]*d[1] + r[8]*d[2],
      r[1]*d[0] + r[5]*d[1] + r[9]*d[2],
      r[2]*d[0] + r[6]*d[1] + r[10]*d[2]
    ];
  }
};
