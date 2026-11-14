// Camera controllers for the engine: orbit (inspect from above) and walk (eye level, along the trail or free).

function interaction(engine) {
  let timer = null;
  return () => {
    engine.interacting = true; engine.requestRender();
    clearTimeout(timer);
    timer = setTimeout(() => { engine.interacting = false; engine.requestRender(); }, 180);
  };
}

export class OrbitControls {
  constructor(engine, el) {
    this.engine = engine; this.el = el; this.enabled = true;
    this.target = [0, 0, 0]; this.distance = 100; this.azimuth = 0.5; this.elevation = 0.7;
    this.touch = interaction(engine);
    this.pointers = new Map();
    this.onChange = null;
    const down = (e) => {
      if (!this.enabled) return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
      this.pinch = null;
    };
    const move = (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!this.enabled || !p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      if (this.pointers.size === 1) {
        if (p.button === 2 || p.button === 1 || p.shift) this.pan(dx, dy);
        else { this.azimuth -= dx * 0.005; this.elevation = Math.max(0.03, Math.min(1.55, this.elevation + dy * 0.005)); }
      }
      p.x = e.clientX; p.y = e.clientY;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
        if (this.pinch) { this.zoom(this.pinch.dist / Math.max(1, dist)); this.pan(mid[0] - this.pinch.mid[0], mid[1] - this.pinch.mid[1]); }
        this.pinch = { dist, mid };
      }
      this.apply(); this.touch();
    };
    const up = (e) => { this.pointers.delete(e.pointerId); this.pinch = null; };
    el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => { if (!this.enabled) return; e.preventDefault(); this.zoom(Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0012))); this.apply(); this.touch(); }, { passive: false });
  }
  pan(dx, dy) {
    const k = this.distance * 2 * Math.tan(this.engine.state.fov / 2) / Math.max(1, this.el.clientHeight);
    const rx = Math.cos(this.azimuth), ry = Math.sin(this.azimuth);
    this.target[0] += (-rx * dx - ry * dy / Math.max(0.25, Math.sin(this.elevation))) * k;
    this.target[1] += (-ry * dx + rx * dy / Math.max(0.25, Math.sin(this.elevation))) * k;
    const g = this.engine.heightAt(this.target[0], this.target[1]);
    if (g === g) this.target[2] += (g - this.target[2]) * 0.2;
  }
  zoom(f) { this.distance = Math.max(this.min || 2, Math.min(this.max || 5000, this.distance * f)); }
  apply() {
    const ce = Math.cos(this.elevation), d = this.distance;
    this.engine.camera.target = this.target.slice();
    this.engine.camera.eye = [this.target[0] + d * ce * Math.sin(this.azimuth), this.target[1] - d * ce * Math.cos(this.azimuth), this.target[2] + d * Math.sin(this.elevation)];
    this.engine.requestRender();
    if (this.onChange) this.onChange();
  }
  // Frame the whole scene.
  fit(size, zMid, zRange) {
    this.target = [size[0] / 2, size[1] / 2, zMid];
    const span = Math.hypot(size[0], size[1], zRange);
    this.distance = span * 0.95; this.min = span * 0.01; this.max = span * 4;
    this.apply();
  }
  // Smoothly move to look at a point from a given distance.
  flyTo(point, distance, ms = 700) {
    const from = { t: this.target.slice(), d: this.distance }, start = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - start) / ms), e = k * k * (3 - 2 * k);
      this.target = from.t.map((v, i) => v + (point[i] - v) * e);
      this.distance = from.d + (distance - from.d) * e;
      this.apply(); this.touch();
      if (k < 1 && this.enabled) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// Walks at eye height. With a trail line it follows the line (distance `d` along it); without one it roams freely over the ground.
export class WalkControls {
  constructor(engine, el, line) {
    this.engine = engine; this.el = el; this.line = line; this.enabled = false;
    this.d = 0; this.yaw = 0; this.pitch = -0.12; this.eye = 1.65; this.speed = 1.4; this.playing = false;
    this.pos = [0, 0]; this.heading = 0; this.keys = new Set();
    this.touch = interaction(engine);
    this.onMove = null;
    let last = null;
    el.addEventListener('pointerdown', (e) => { if (this.enabled) { last = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId); } });
    el.addEventListener('pointermove', (e) => {
      if (!this.enabled || !last) return;
      this.yaw -= (e.clientX - last.x) * 0.004; this.pitch = Math.max(-1.2, Math.min(1.0, this.pitch - (e.clientY - last.y) * 0.004));
      last = { x: e.clientX, y: e.clientY }; this.apply(); this.touch();
    });
    const end = () => { last = null; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', (e) => { if (!this.enabled) return; e.preventDefault(); this.advance(-e.deltaY * 0.01 * (this.fine ? 0.3 : 1)); }, { passive: false });
    window.addEventListener('keydown', (e) => { if (this.enabled && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) { this.keys.add(e.code); if (e.code === 'Space') { e.preventDefault(); this.playing = !this.playing; if (this.onMove) this.onMove(); } } });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
  }
  get length() { return this.line ? this.line.d[this.line.d.length - 1] : 0; }
  at(d) {
    const L = this.line, n = L.d.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L.d[m] <= d) lo = m; else hi = m; }
    const t = L.d[hi] > L.d[lo] ? (d - L.d[lo]) / (L.d[hi] - L.d[lo]) : 0;
    return [L.x[lo] + (L.x[hi] - L.x[lo]) * t, L.y[lo] + (L.y[hi] - L.y[lo]) * t, L.z[lo] + (L.z[hi] - L.z[lo]) * t];
  }
  advance(dd) {
    if (this.line) { this.d = Math.max(0, Math.min(this.length, this.d + dd)); }
    else { const h = this.heading + this.yaw; this.pos[0] += -Math.sin(h) * dd; this.pos[1] += Math.cos(h) * dd; }
    this.apply(); this.touch();
    if (this.onMove) this.onMove();
  }
  update(dt) {
    if (!this.enabled) return;
    const k = this.keys, fwd = (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0) - (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0);
    const turn = (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0) - (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);
    if (turn) { this.yaw += turn * dt * 1.2; this.apply(); this.touch(); }
    const v = (this.playing ? 1 : 0) + fwd * 1.6;
    if (v) { this.advance(v * this.speed * dt); if (this.line && this.d >= this.length) this.playing = false; }
  }
  apply() {
    let p, heading;
    if (this.line) {
      p = this.at(this.d);
      const look = this.fine ? 1.2 : 6, a = this.at(Math.max(0, this.d - look * 0.3)), b = this.at(Math.min(this.length, this.d + look));
      heading = Math.atan2(-(b[0] - a[0]), b[1] - a[1]);
      // ease the heading so hairpins do not snap
      let diff = heading - this.heading; while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
      this.heading += this.started ? diff * 0.18 : diff; this.started = true;
      if (Math.abs(diff) > 0.01) this.engine.requestRender();
    } else {
      const g = this.engine.heightAt(this.pos[0], this.pos[1]);
      p = [this.pos[0], this.pos[1], g === g ? g : (this.lastZ ?? 0)]; this.lastZ = p[2];
    }
    const h = this.heading + this.yaw, cp = Math.cos(this.pitch);
    const eye = [p[0], p[1], p[2] + this.eye];
    this.engine.camera.eye = eye;
    this.engine.camera.target = [eye[0] - Math.sin(h) * cp, eye[1] + Math.cos(h) * cp, eye[2] + Math.sin(this.pitch)];
    this.position = p;
    this.engine.requestRender();
  }
}
