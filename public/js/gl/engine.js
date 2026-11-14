// Masar's 3D engine: a small WebGL2 renderer for point clouds, a textured ground mesh and the trail ribbon.
// World space is metres, x east / y north / z up. Rendering happens on demand (requestRender), not in a busy loop.

// ───────────────────────────── matrices (column-major) ─────────────────────────────
export const M = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(e, t, up) {
    let zx = e[0] - t[0], zy = e[1] - t[1], zz = e[2] - t[2];
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
  },
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  },
  invert(m) {
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return null;
    det = 1 / det;
    return new Float32Array([
      (a11 * b11 - a12 * b10 + a13 * b09) * det, (a02 * b10 - a01 * b11 - a03 * b09) * det, (a31 * b05 - a32 * b04 + a33 * b03) * det, (a22 * b04 - a21 * b05 - a23 * b03) * det,
      (a12 * b08 - a10 * b11 - a13 * b07) * det, (a00 * b11 - a02 * b08 + a03 * b07) * det, (a32 * b02 - a30 * b05 - a33 * b01) * det, (a20 * b05 - a22 * b02 + a23 * b01) * det,
      (a10 * b10 - a11 * b08 + a13 * b06) * det, (a01 * b08 - a00 * b10 - a03 * b06) * det, (a30 * b04 - a31 * b02 + a33 * b00) * det, (a21 * b02 - a20 * b04 - a23 * b00) * det,
      (a11 * b07 - a10 * b09 - a12 * b06) * det, (a00 * b09 - a01 * b07 + a02 * b06) * det, (a31 * b01 - a30 * b03 - a32 * b00) * det, (a20 * b03 - a21 * b01 + a22 * b00) * det]);
  },
  apply(m, p) {
    const x = p[0], y = p[1], z = p[2];
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
  },
};

// ───────────────────────────── shaders ─────────────────────────────
export const MODE = { photo: 0, elevation: 1, classes: 2, slope: 3, ink: 5 };

const COMMON = `
uniform sampler2D uTex, uAux;
uniform vec4 uTexBounds;        // minX, minY, 1/width, 1/height (world metres)
uniform vec2 uTerrainSize;
uniform float uHasTex, uHasAux, uZMin, uZRange;
uniform vec3 uInk, uPaper;
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.16, 0.36, 0.33), c1 = vec3(0.45, 0.63, 0.36), c2 = vec3(0.86, 0.77, 0.47), c3 = vec3(0.66, 0.52, 0.42), c4 = vec3(0.96, 0.95, 0.93);
  if (t < 0.25) return mix(c0, c1, t * 4.0);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) * 4.0);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) * 4.0);
  return mix(c3, c4, (t - 0.75) * 4.0);
}
vec3 classColour(float cls) {
  if (cls < 1.5) return vec3(0.56, 0.60, 0.61);        // unclassified / objects
  if (cls < 2.5) return vec3(0.70, 0.55, 0.38);        // ground
  if (cls < 3.5) return vec3(0.52, 0.72, 0.40);        // low vegetation
  if (cls < 4.5) return vec3(0.33, 0.57, 0.31);
  if (cls < 5.5) return vec3(0.20, 0.44, 0.27);        // high vegetation / overhead
  if (cls < 6.5) return vec3(0.85, 0.26, 0.18);        // buildings
  if (cls > 8.5 && cls < 9.5) return vec3(0.18, 0.49, 0.65);  // water
  return vec3(0.56, 0.60, 0.61);
}
vec3 slopeColour(float s) {       // s = slope / 90°
  float t = clamp(s * 90.0 / 45.0, 0.0, 1.0);
  return t < 0.5 ? mix(vec3(0.31, 0.54, 0.29), vec3(0.95, 0.76, 0.19), t * 2.0) : mix(vec3(0.95, 0.76, 0.19), vec3(0.85, 0.26, 0.18), (t - 0.5) * 2.0);
}
vec3 shade(int mode, vec3 world, vec3 rgb, float hasRgb, float cls) {
  vec4 aux = uHasAux > 0.5 ? texture(uAux, world.xy / uTerrainSize) : vec4(0.75, 0.0, 1.0, 1.0);
  float light = 0.45 + 0.75 * aux.r;
  if (mode == 0) {
    if (hasRgb > 0.5) return rgb;
    if (uHasTex > 0.5) { vec2 uv = (world.xy - uTexBounds.xy) * uTexBounds.zw; if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) return texture(uTex, vec2(uv.x, 1.0 - uv.y)).rgb; }
    return ramp((world.z - uZMin) / uZRange) * light;
  }
  if (mode == 1) return ramp((world.z - uZMin) / uZRange) * light;
  if (mode == 2) return classColour(cls) * (0.6 + 0.5 * aux.r);
  if (mode == 3) return slopeColour(aux.g) * (0.75 + 0.3 * aux.r);
  return mix(uInk, uPaper, clamp(0.08 + 0.62 * aux.r * aux.r, 0.0, 0.8));   // ink stipple
}
float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
`;

const POINT_VS = `#version 300 es
precision highp float; precision highp int;
in vec3 aPos; in vec4 aCol;
uniform mat4 uVP; uniform vec3 uMin, uSize;
uniform float uPointSize, uPixelScale, uMinPx, uMaxPx, uHasRGB, uMix, uSweep, uVegKeep, uKeep;
uniform int uMode, uModeB;
uniform vec2 uFog;
out vec3 vColour; out float vFog;
${COMMON}
void main() {
  vec3 world = uMin + aPos * uSize;
  float cls = floor(aCol.a * 255.0 + 0.5);
  float rnd = hash3(aPos * 251.0);
  bool veg = cls > 2.5 && cls < 5.5;
  bool revealed = aPos.x + (rnd - 0.5) * 0.03 <= uSweep;       // uSweep sweeps west → east; uKeep = share visible before the sweep arrives
  if ((!revealed && fract(rnd * 7.13 + 0.37) > uKeep) || (veg && rnd > uVegKeep)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  vec3 a = shade(uMode, world, aCol.rgb, uHasRGB, cls);
  vColour = uMix > 0.001 ? mix(a, shade(uModeB, world, aCol.rgb, uHasRGB, cls), uMix) : a;
  float front = (revealed && uSweep < 1.02) ? 1.0 - smoothstep(0.0, 0.035, uSweep - aPos.x) : 0.0;
  vColour = mix(vColour, vec3(0.85, 0.25, 0.18), front * 0.9);
  gl_Position = uVP * vec4(world, 1.0);
  gl_PointSize = clamp(uPointSize * uPixelScale / gl_Position.w, uMinPx, uMaxPx) * (1.0 + front * 0.8);
  vFog = clamp((gl_Position.w - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0);
}`;
const POINT_FS = `#version 300 es
precision mediump float;
in vec3 vColour; in float vFog;
uniform vec3 uFogColour; uniform float uFogAmount;
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  if (dot(d, d) > 0.25) discard;
  frag = vec4(mix(vColour, uFogColour, vFog * uFogAmount), 1.0);
}`;

const MESH_VS = `#version 300 es
precision highp float;
in vec3 aPos;
uniform mat4 uVP; uniform vec2 uFog;
out vec3 vWorld; out float vFog;
void main() { vWorld = aPos; gl_Position = uVP * vec4(aPos, 1.0); vFog = clamp((gl_Position.w - uFog.x) / (uFog.y - uFog.x), 0.0, 1.0); }`;
const MESH_FS = `#version 300 es
precision highp float; precision highp int;
in vec3 vWorld; in float vFog;
uniform int uMode, uModeB; uniform float uMix, uAlpha, uSweep;
uniform vec3 uFogColour; uniform float uFogAmount;
out vec4 frag;
${COMMON}
void main() {
  if (vWorld.x / uTerrainSize.x > uSweep) discard;
  if (uAlpha < 0.999) { float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); if (n > uAlpha) discard; }
  vec3 a = shade(uMode, vWorld, vec3(0.0), 0.0, 2.0);
  vec3 c = uMix > 0.001 ? mix(a, shade(uModeB, vWorld, vec3(0.0), 0.0, 2.0), uMix) : a;
  frag = vec4(mix(c, uFogColour, vFog * uFogAmount), 1.0);
}`;

const TRAIL_VS = `#version 300 es
precision highp float;
in vec3 aPos; in vec2 aInfo;     // info: across (-1..1), progress (0..1)
uniform mat4 uVP;
out vec2 vInfo;
void main() { vInfo = aInfo; gl_Position = uVP * vec4(aPos, 1.0); gl_Position.z -= 0.0006 * gl_Position.w; }`;
const TRAIL_FS = `#version 300 es
precision mediump float;
in vec2 vInfo;
uniform float uProgress; uniform vec3 uCore, uEdge;
out vec4 frag;
void main() {
  if (vInfo.y > uProgress) discard;
  frag = vec4(abs(vInfo.x) > 0.5 ? uEdge : uCore, 1.0);   // white–red–white, like a painted trail blaze
}`;

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

export class Engine {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: !!opts.transparent, premultipliedAlpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.preserve });
    if (!gl) throw new Error('webgl2_unavailable');
    this.gl = gl;
    this.transparent = !!opts.transparent;
    this.background = hex(opts.background || '#DCE5E6');
    this.ink = hex('#13252C'); this.paper = hex('#F3F4EE');
    this.state = { mode: MODE.photo, modeB: MODE.photo, mix: 0, pointSize: 0.4, minPx: 1.5, maxPx: 14, showPoints: true, showMesh: true, showTrail: true,
      meshAlpha: 1, sweep: 2, vegKeep: 1, keep: 1, detail: 1, trailProgress: 1, fogAmount: 0.55, fov: 50 * Math.PI / 180 };
    this.camera = { eye: [0, -100, 80], target: [0, 0, 0] };
    this.programs = { point: this.#program(POINT_VS, POINT_FS), mesh: this.#program(MESH_VS, MESH_FS), trail: this.#program(TRAIL_VS, TRAIL_FS) };
    this.white = this.#solidTexture([255, 255, 255, 255]);
    this.tex = null; this.aux = null; this.texBounds = [0, 0, 1, 1];
    this.points = null; this.mesh = null; this.trail = null; this.terrain = null;
    this.size = [1, 1]; this.zMin = 0; this.zRange = 1;
    this.dirty = true; this.onFrame = null; this.interacting = false; this.interactiveBudget = 700000; this.lastFrameMs = 16;
    this.lost = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    const loop = () => { this.raf = requestAnimationFrame(loop); if (this.onFrame) this.onFrame(performance.now()); if (this.dirty && !this.lost) this.render(); };
    this.raf = requestAnimationFrame(loop);
    this.ro = new ResizeObserver(() => { this.dirty = true; });
    this.ro.observe(canvas);
  }

  dispose() { cancelAnimationFrame(this.raf); this.ro.disconnect(); }
  requestRender() { this.dirty = true; }
  set(patch) { Object.assign(this.state, patch); this.dirty = true; }

  #program(vs, fs) {
    const gl = this.gl;
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u, attr: (name) => gl.getAttribLocation(p, name) };
  }
  #solidTexture(rgba) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    return t;
  }

  // Quantised points straight from points.bin: pos = Uint16 xyz (0..65535 over min..max), col = Uint8 rgb + class.
  setPoints({ pos, col, count, min, max, hasRGB }) {
    const gl = this.gl;
    if (this.points) { gl.deleteBuffer(this.points.posBuf); gl.deleteBuffer(this.points.colBuf); gl.deleteVertexArray(this.points.vao); }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    const pl = this.programs.point.attr('aPos'); gl.enableVertexAttribArray(pl); gl.vertexAttribPointer(pl, 3, gl.UNSIGNED_SHORT, true, 0, 0);
    const colBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, colBuf); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);
    const cl = this.programs.point.attr('aCol'); gl.enableVertexAttribArray(cl); gl.vertexAttribPointer(cl, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.bindVertexArray(null);
    this.points = { vao, posBuf, colBuf, count, min, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], hasRGB: !!hasRGB };
    if (!this.terrain) { this.size = [max[0], max[1]]; this.zMin = min[2]; this.zRange = Math.max(1e-3, max[2] - min[2]); }
    this.dirty = true;
  }

  // Ground model: Float32 heights (NaN = no data), row 0 = south. Builds the mesh, the hillshade/slope texture and height lookups.
  setTerrain({ heights, w, h, cell, size }) {
    const gl = this.gl;
    this.terrain = { heights, w, h, cell };
    this.size = size;
    let zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < heights.length; i++) { const v = heights[i]; if (v === v) { if (v < zMin) zMin = v; if (v > zMax) zMax = v; } }
    this.zMin = zMin; this.zRange = Math.max(1e-3, zMax - zMin);
    // mesh at ≤ 512 cells per side; the photo texture carries the fine detail
    const step = Math.max(1, Math.ceil(Math.max(w, h) / 512));
    const mw = Math.floor((w - 1) / step) + 1, mh = Math.floor((h - 1) / step) + 1;
    const verts = new Float32Array(mw * mh * 3), ok = new Uint8Array(mw * mh);
    for (let j = 0; j < mh; j++) for (let i = 0; i < mw; i++) {
      const v = heights[j * step * w + i * step], k = j * mw + i;
      verts[k * 3] = (i * step + 0.5) * cell; verts[k * 3 + 1] = (j * step + 0.5) * cell; verts[k * 3 + 2] = v === v ? v : zMin; ok[k] = v === v ? 1 : 0;
    }
    const idx = new Uint32Array((mw - 1) * (mh - 1) * 6);
    let n = 0;
    for (let j = 0; j < mh - 1; j++) for (let i = 0; i < mw - 1; i++) {
      const a = j * mw + i, b = a + 1, c = a + mw, d = c + 1;
      if (ok[a] && ok[b] && ok[c] && ok[d]) { idx[n++] = a; idx[n++] = b; idx[n++] = c; idx[n++] = b; idx[n++] = d; idx[n++] = c; }
    }
    if (this.mesh) { gl.deleteBuffer(this.mesh.vb); gl.deleteBuffer(this.mesh.ib); gl.deleteVertexArray(this.mesh.vao); }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    const loc = this.programs.mesh.attr('aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, n), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.mesh = { vao, vb, ib, count: n };
    // aux texture: R hillshade, G slope/90°, B valid
    const as = Math.max(1, Math.ceil(Math.max(w, h) / 1024)), aw = Math.ceil(w / as), ah = Math.ceil(h / as);
    const aux = new Uint8Array(aw * ah * 4);
    const sun = [-0.5, 0.5, 0.7071];
    const H = (x, y) => { x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y)); return heights[y * w + x]; };
    for (let j = 0; j < ah; j++) for (let i = 0; i < aw; i++) {
      const x = i * as, y = j * as, c = H(x, y), o = (j * aw + i) * 4;
      if (c !== c) { aux[o] = 190; aux[o + 3] = 255; continue; }
      let l = H(x - as, y), r = H(x + as, y), d = H(x, y - as), u = H(x, y + as);
      if (l !== l) l = c; if (r !== r) r = c; if (d !== d) d = c; if (u !== u) u = c;
      const gx = (r - l) / (2 * as * cell), gy = (u - d) / (2 * as * cell), inv = 1 / Math.hypot(gx, gy, 1);
      const light = Math.max(0, (-gx * sun[0] - gy * sun[1] + sun[2]) * inv);
      aux[o] = Math.min(255, light * 255); aux[o + 1] = Math.min(255, Math.atan(Math.hypot(gx, gy)) / (Math.PI / 2) * 255); aux[o + 2] = 255; aux[o + 3] = 255;
    }
    if (this.aux) gl.deleteTexture(this.aux);
    this.aux = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.aux);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, aw, ah, 0, gl.RGBA, gl.UNSIGNED_BYTE, aux);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    this.dirty = true;
  }

  // Aerial image (north up). bounds = [minX, minY, maxX, maxY] in world metres.
  setTexture(source, bounds) {
    const gl = this.gl;
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = null;
    if (!source) { this.dirty = true; return; }
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    let src = source;
    const sw = source.naturalWidth || source.width, sh = source.naturalHeight || source.height;
    if (sw > max || sh > max) {
      const k = Math.min(max / sw, max / sh), c = document.createElement('canvas');
      c.width = Math.floor(sw * k); c.height = Math.floor(sh * k); c.getContext('2d').drawImage(source, 0, 0, c.width, c.height); src = c;
    }
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    this.texBounds = bounds;
    this.dirty = true;
  }

  // Trail ribbon from line samples {x[], y[], z[]}; width in metres.
  setTrail(line, width = 1, lift = 0.12) {
    const gl = this.gl;
    if (this.trail) { gl.deleteBuffer(this.trail.vb); gl.deleteVertexArray(this.trail.vao); this.trail = null; }
    if (!line || line.x.length < 2) { this.dirty = true; return; }
    const n = line.x.length, data = new Float32Array(n * 2 * 5);
    let total = 0; const acc = [0];
    for (let i = 1; i < n; i++) { total += Math.hypot(line.x[i] - line.x[i - 1], line.y[i] - line.y[i - 1]); acc.push(total); }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = line.x[b] - line.x[a], ty = line.y[b] - line.y[a]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
      for (let s = 0; s < 2; s++) {
        const side = s ? 1 : -1, o = (i * 2 + s) * 5;
        data[o] = line.x[i] - ty * side * width / 2; data[o + 1] = line.y[i] + tx * side * width / 2; data[o + 2] = line.z[i] + lift;
        data[o + 3] = side; data[o + 4] = total ? acc[i] / total : 0;
      }
    }
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const p = this.programs.trail.attr('aPos'), q = this.programs.trail.attr('aInfo');
    gl.enableVertexAttribArray(p); gl.vertexAttribPointer(p, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(q); gl.vertexAttribPointer(q, 2, gl.FLOAT, false, 20, 12);
    gl.bindVertexArray(null);
    this.trail = { vao, vb, count: n * 2 };
    this.dirty = true;
  }

  heightAt(x, y) {
    const t = this.terrain; if (!t) return NaN;
    const fx = x / t.cell - 0.5, fy = y / t.cell - 0.5;
    if (fx < 0 || fy < 0 || fx > t.w - 1 || fy > t.h - 1) return NaN;
    const x0 = Math.min(t.w - 2, Math.floor(fx)), y0 = Math.min(t.h - 2, Math.floor(fy)), tx = fx - x0, ty = fy - y0;
    const a = t.heights[y0 * t.w + x0], b = t.heights[y0 * t.w + x0 + 1], c = t.heights[(y0 + 1) * t.w + x0], d = t.heights[(y0 + 1) * t.w + x0 + 1];
    if (a !== a || b !== b || c !== c || d !== d) { let s = 0, n = 0; for (const v of [a, b, c, d]) if (v === v) { s += v; n++; } return n ? s / n : NaN; }
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  #matrices() {
    const c = this.canvas, aspect = c.width / Math.max(1, c.height);
    const dist = Math.hypot(this.camera.eye[0] - this.camera.target[0], this.camera.eye[1] - this.camera.target[1], this.camera.eye[2] - this.camera.target[2]);
    const span = Math.hypot(this.size[0], this.size[1], this.zRange);
    const near = Math.max(0.05, Math.min(dist * 0.05, span * 0.002)), far = dist + span * 3;
    const P = M.perspective(this.state.fov, aspect, near, far), V = M.lookAt(this.camera.eye, this.camera.target, [0, 0, 1]);
    this.vp = M.mul(P, V); this.dist = dist; this.span = span;
    return this.vp;
  }

  // World → CSS pixels. Returns null when behind the camera.
  project(p) {
    if (!this.vp) this.#matrices();
    const v = M.apply(this.vp, p);
    if (v[3] <= 0) return null;
    const r = this.canvas.getBoundingClientRect();
    return [(v[0] / v[3] * 0.5 + 0.5) * r.width, (1 - (v[1] / v[3] * 0.5 + 0.5)) * r.height, v[3]];
  }

  // CSS pixel → point on the ground model (ray-marched), or null.
  pickTerrain(cx, cy) {
    if (!this.terrain) return null;
    const inv = M.invert(this.#matrices()); if (!inv) return null;
    const r = this.canvas.getBoundingClientRect(), nx = cx / r.width * 2 - 1, ny = 1 - cy / r.height * 2;
    const a = M.apply(inv, [nx, ny, -1]), b = M.apply(inv, [nx, ny, 1]);
    const o = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], e = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    let d = [e[0] - o[0], e[1] - o[1], e[2] - o[2]]; const len = Math.hypot(...d); d = d.map((v) => v / len);
    const step = Math.max(this.terrain.cell, this.span / 1500);
    let prevT = 0, prevAbove = true;
    for (let t = 0; t < len; t += step) {
      const x = o[0] + d[0] * t, y = o[1] + d[1] * t, z = o[2] + d[2] * t, g = this.heightAt(x, y);
      if (g !== g) { prevT = t; continue; }
      if (z <= g) {
        if (!prevAbove) return null;
        let lo = prevT, hi = t;
        for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2, gz = this.heightAt(o[0] + d[0] * m, o[1] + d[1] * m); if (gz === gz && o[2] + d[2] * m <= gz) hi = m; else lo = m; }
        const px = o[0] + d[0] * hi, py = o[1] + d[1] * hi;
        return [px, py, this.heightAt(px, py)];
      }
      prevAbove = true; prevT = t;
    }
    return null;
  }

  render() {
    const gl = this.gl, c = this.canvas, s = this.state;
    const t0 = performance.now();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(c.clientWidth * dpr)), Hh = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== W || c.height !== Hh) { c.width = W; c.height = Hh; }
    this.dirty = false;
    gl.viewport(0, 0, W, Hh);
    if (this.transparent) gl.clearColor(0, 0, 0, 0); else gl.clearColor(...this.background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    const vp = this.#matrices();
    const fogColour = this.transparent ? this.paper : this.background;
    const fog = [this.dist * 0.6, this.dist * 0.6 + this.span * 1.6];
    const common = (prog) => {
      const u = prog.u;
      gl.useProgram(prog.p);
      gl.uniformMatrix4fv(u.uVP, false, vp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex || this.white); gl.uniform1i(u.uTex, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.aux || this.white); gl.uniform1i(u.uAux, 1);
      const b = this.texBounds;
      gl.uniform4f(u.uTexBounds, b[0], b[1], 1 / (b[2] - b[0]), 1 / (b[3] - b[1]));
      gl.uniform2f(u.uTerrainSize, this.size[0], this.size[1]);
      gl.uniform1f(u.uHasTex, this.tex ? 1 : 0); gl.uniform1f(u.uHasAux, this.aux ? 1 : 0);
      gl.uniform1f(u.uZMin, this.zMin); gl.uniform1f(u.uZRange, this.zRange);
      gl.uniform3fv(u.uInk, this.ink); gl.uniform3fv(u.uPaper, this.paper);
      gl.uniform1i(u.uMode, s.mode); gl.uniform1i(u.uModeB, s.modeB); gl.uniform1f(u.uMix, s.mix);
      gl.uniform2f(u.uFog, fog[0], fog[1]); gl.uniform3fv(u.uFogColour, fogColour); gl.uniform1f(u.uFogAmount, s.fogAmount);
      gl.uniform1f(u.uSweep, s.sweep);
    };
    if (s.showMesh && this.mesh && s.meshAlpha > 0.01) {
      const prog = this.programs.mesh; common(prog);
      gl.uniform1f(prog.u.uAlpha, s.meshAlpha);
      gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1, 2);
      gl.bindVertexArray(this.mesh.vao); gl.drawElements(gl.TRIANGLES, this.mesh.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    if (s.showPoints && this.points) {
      const prog = this.programs.point, p = this.points; common(prog);
      gl.uniform3fv(prog.u.uMin, p.min); gl.uniform3fv(prog.u.uSize, p.size);
      gl.uniform1f(prog.u.uPointSize, s.pointSize); gl.uniform1f(prog.u.uPixelScale, Hh / (2 * Math.tan(s.fov / 2)));
      gl.uniform1f(prog.u.uMinPx, s.minPx * dpr); gl.uniform1f(prog.u.uMaxPx, s.maxPx * dpr);
      gl.uniform1f(prog.u.uHasRGB, p.hasRGB ? 1 : 0); gl.uniform1f(prog.u.uVegKeep, s.vegKeep); gl.uniform1f(prog.u.uKeep, s.keep);
      let n = Math.floor(p.count * s.detail);
      if (this.interacting) n = Math.min(n, Math.floor(this.interactiveBudget));
      gl.bindVertexArray(p.vao); gl.drawArrays(gl.POINTS, 0, n);
      this.drawn = n;
    }
    if (s.showTrail && this.trail && s.trailProgress > 0) {
      const prog = this.programs.trail;
      gl.useProgram(prog.p); gl.uniformMatrix4fv(prog.u.uVP, false, vp);
      gl.uniform1f(prog.u.uProgress, s.trailProgress); gl.uniform3fv(prog.u.uCore, hex('#D8412F')); gl.uniform3fv(prog.u.uEdge, hex('#FBFBF7'));
      gl.bindVertexArray(this.trail.vao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, this.trail.count);
    }
    gl.bindVertexArray(null);
    // keep interaction smooth on slower GPUs: adapt how many points are drawn while the camera moves
    if (this.interacting) {
      gl.finish?.();
      this.lastFrameMs = performance.now() - t0;
      if (this.lastFrameMs > 28) this.interactiveBudget = Math.max(150000, this.interactiveBudget * 0.8);
      else if (this.lastFrameMs < 12) this.interactiveBudget = Math.min(4e6, this.interactiveBudget * 1.15);
    }
    if (this.afterRender) this.afterRender();
  }
}

// ───────────────────────────── loading a built trail ─────────────────────────────
export async function loadTrailData(base, meta, onProgress = () => {}) {
  const get = async (name) => { const r = await fetch(`${base}/${name}`, { credentials: 'same-origin' }); if (!r.ok) throw new Error(`load_failed:${name}`); return r.arrayBuffer(); };
  onProgress(0.1);
  const [pb, db] = await Promise.all([get('points.bin'), get('dem.bin')]);
  onProgress(0.7);
  const n = meta.points.count;
  const pos = new Uint16Array(pb, 0, n * 3), col = new Uint8Array(pb, n * 6, n * 4);
  const q = new Uint16Array(db), heights = new Float32Array(q.length), k = (meta.dem.zMax - meta.dem.zMin) / 65534;
  for (let i = 0; i < q.length; i++) heights[i] = q[i] === 65535 ? NaN : meta.dem.zMin + q[i] * k;
  return { points: { pos, col, count: n, min: meta.points.min, max: meta.points.max, hasRGB: meta.points.hasRGB },
    terrain: { heights, w: meta.dem.w, h: meta.dem.h, cell: meta.dem.cell, size: meta.size } };
}

export function loadImage(url) {
  return new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('image_failed')); img.src = url; });
}
