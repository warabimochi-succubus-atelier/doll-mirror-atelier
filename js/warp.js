// 形の変更の変形：制御点（取っ手を通る曲線と固定点）による画像の変形と、その描画
// 仕様書「形の変更」と、技術構成の「形の変更の実装」を参照
//
// 変形は、制御点の元の位置 P と動かした後の位置 Q から、画像のすべての点の移動量を決める
// TPS（Thin Plate Spline）で行う。制御点をすべて正確に通り、その間を曲げが最も小さくなるように
// 滑らかにつなぐ。制御点の並び（P）が同じ間は、連立方程式の逆行列と、格子の頂点ごとの係数を使い回し、
// 動かした量（Q − P）が変わったときは掛け算だけで描き直す。
//
// 描画は WebGL で、画像を貼った格子の頂点を移動先へ動かして描く（指の動きに合わせて描き直せる速さにするため）。
// WebGL を使えない場合は、画素ごとに移動元を求めて描く（遅い）。

/** TPS の基底関数 U(r) = r² log r（r² で受け取る） */
const kern = (r2) => (r2 < 1e-12 ? 0 : 0.5 * r2 * Math.log(r2));

/**
 * TPS の変形。new Tps(P) で準備し、solve(Q) で動かした後の位置を与え、dispInto で点ごとの移動量を求める
 * @param P 制御点の元の位置 [x0, y0, x1, y1, ...]
 */
export class Tps {
  constructor(P) {
    const n = P.length >> 1, m = n + 3;
    // 座標は桁をそろえて計算する（基底関数の値が大きくなりすぎないように）
    let s = 1;
    for (let i = 0; i < P.length; i++) s = Math.max(s, Math.abs(P[i]));
    this.P = P; this.n = n; this.m = m; this.s = 1 / s;
    const X = new Float64Array(P.length);
    for (let i = 0; i < P.length; i++) X[i] = P[i] * this.s;
    this.X = X;
    // [K 1 x y; 1ᵀ 0; xᵀ 0; yᵀ 0] の逆行列（掃き出し法）。右辺の下3行は 0 なので、左の n 列だけ残す
    const A = new Float64Array(m * m), B = new Float64Array(m * m);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) { const dx = X[2 * i] - X[2 * j], dy = X[2 * i + 1] - X[2 * j + 1]; A[i * m + j] = kern(dx * dx + dy * dy); }
      const r = [1, X[2 * i], X[2 * i + 1]];
      for (let k = 0; k < 3; k++) { A[i * m + n + k] = r[k]; A[(n + k) * m + i] = r[k]; }
    }
    for (let i = 0; i < m; i++) B[i * m + i] = 1;
    for (let c = 0; c < m; c++) {
      let p = c, best = Math.abs(A[c * m + c]);
      for (let r = c + 1; r < m; r++) { const v = Math.abs(A[r * m + c]); if (v > best) { best = v; p = r; } }
      if (best < 1e-12) throw new Error('tps');
      if (p !== c) for (let k = 0; k < m; k++) { let t = A[c * m + k]; A[c * m + k] = A[p * m + k]; A[p * m + k] = t; t = B[c * m + k]; B[c * m + k] = B[p * m + k]; B[p * m + k] = t; }
      const iv = 1 / A[c * m + c];
      for (let k = 0; k < m; k++) { A[c * m + k] *= iv; B[c * m + k] *= iv; }
      for (let r = 0; r < m; r++) {
        if (r === c) continue;
        const f = A[r * m + c];
        if (!f) continue;
        for (let k = 0; k < m; k++) { A[r * m + k] -= f * A[c * m + k]; B[r * m + k] -= f * B[c * m + k]; }
      }
    }
    this.inv = new Float64Array(m * n);
    for (let r = 0; r < m; r++) for (let c = 0; c < n; c++) this.inv[r * n + c] = B[r * m + c];
    this.wx = new Float64Array(m); this.wy = new Float64Array(m);
  }
  /** 動かした後の位置 Q（P と同じ並び）から係数を求める */
  solve(Q) {
    const { n, m, inv, P } = this;
    for (let r = 0; r < m; r++) {
      let sx = 0, sy = 0;
      for (let c = 0, o = r * n; c < n; c++) { const v = inv[o + c]; sx += v * (Q[2 * c] - P[2 * c]); sy += v * (Q[2 * c + 1] - P[2 * c + 1]); }
      this.wx[r] = sx; this.wy[r] = sy;
    }
    return this;
  }
  /** 点 (x, y) の基底関数の値（長さ m）。同じ点を何度も計算する場合に row に書いて使い回す */
  row(x, y, row) {
    const { n, X, s } = this, px = x * s, py = y * s;
    for (let i = 0; i < n; i++) { const dx = px - X[2 * i], dy = py - X[2 * i + 1]; row[i] = kern(dx * dx + dy * dy); }
    row[n] = 1; row[n + 1] = px; row[n + 2] = py;
    return row;
  }
  /** 点 (x, y) の移動量を out に書く */
  dispInto(x, y, out) {
    const { n, X, s, wx, wy } = this, px = x * s, py = y * s;
    let dx = wx[n] + wx[n + 1] * px + wx[n + 2] * py, dy = wy[n] + wy[n + 1] * px + wy[n + 2] * py;
    for (let i = 0; i < n; i++) { const ex = px - X[2 * i], ey = py - X[2 * i + 1], k = kern(ex * ex + ey * ey); dx += wx[i] * k; dy += wy[i] * k; }
    out[0] = dx; out[1] = dy;
    return out;
  }
}

/**
 * 変形の範囲 box の縁での弱め（縁で 0、縁から band 以上内側で 1）。
 * 範囲の外は計算しないため、範囲の縁で移動量が途切れないようにする
 */
export function fadeAt(box, x, y) {
  const d = Math.min(x - box.x0, box.x1 - x, y - box.y0, box.y1 - y);
  if (d <= 0) return 0;
  if (d >= box.band) return 1;
  const t = d / box.band;
  return t * t * (3 - 2 * t);
}

// ---------------- 描画 ----------------

const VS = `
attribute vec2 aPos; attribute vec2 aTex;
uniform vec2 uSize;
varying vec2 vTex;
void main() {
  vTex = aTex / uSize;
  gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0);
}`;
const FS = `
precision mediump float;
uniform sampler2D uImg;
varying vec2 vTex;
void main() { gl_FragColor = texture2D(uImg, vTex); }`;

/** 格子の細かさ：長辺をこの数に分ける */
const CELLS = 56;

export class Warper {
  constructor() {
    this.gl = null; this.cv = null; this.src = null; this.failed = false;
    this.out = null; // CPU で描く場合の描画先
  }

  /** WebGL を準備する。使えなければ false */
  setup(w, h) {
    if (this.failed) return false;
    if (this.gl && !this.gl.isContextLost() && this.cv.width === w && this.cv.height === h) return true;
    try {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const gl = cv.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, antialias: false });
      if (!gl || w > gl.getParameter(gl.MAX_TEXTURE_SIZE) || h > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('webgl');
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader'); return s; };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link');
      gl.useProgram(prog);
      this.loc = { pos: gl.getAttribLocation(prog, 'aPos'), tex: gl.getAttribLocation(prog, 'aTex'), size: gl.getUniformLocation(prog, 'uSize') };
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
      this.bufPos = gl.createBuffer(); this.bufTex = gl.createBuffer(); this.bufIdx = gl.createBuffer();
      this.gl = gl; this.cv = cv; this.src = null; this.mesh = null;
      cv.addEventListener('webglcontextlost', () => { this.gl = null; });
      return true;
    } catch {
      this.failed = true; this.gl = null;
      return false;
    }
  }

  /** 格子（元の位置）と三角形の並び。画像の大きさごとに1回作る */
  makeMesh(w, h) {
    const step = Math.max(w, h) / CELLS;
    const nx = Math.ceil(w / step) + 1, ny = Math.ceil(h / step) + 1;
    const rest = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = (j * nx + i) * 2;
      rest[k] = Math.min(w, i * step); rest[k + 1] = Math.min(h, j * step);
    }
    const idx = new Uint16Array((nx - 1) * (ny - 1) * 6);
    let o = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
    return { w, h, nx, ny, rest, idx, pos: new Float32Array(rest.length) };
  }

  /**
   * 変形した画像を描く。返り値は描いた canvas（WebGL の canvas。続けて描くと上書きされる）
   * @param src 元の画像（2D の canvas）、tps 係数を求めた Tps、box 変形がある範囲 {x0, y0, x1, y1, band}（範囲の外は計算しない）
   */
  render(src, tps, box) {
    const w = src.width, h = src.height;
    if (!this.setup(w, h)) return this.renderCpu(src, tps, box);
    const gl = this.gl;
    if (!this.mesh || this.mesh.w !== w || this.mesh.h !== h) {
      this.mesh = this.makeMesh(w, h); this.rows = null;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufTex); gl.bufferData(gl.ARRAY_BUFFER, this.mesh.rest, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.idx, gl.STATIC_DRAW);
    }
    if (this.src !== src) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.src = src;
    }
    const m = this.mesh, pos = m.pos, R = this.rowsFor(tps, box), M = tps.m, wx = tps.wx, wy = tps.wy;
    pos.set(m.rest);
    for (let a = 0; a < R.idx.length; a++) {
      const k = R.idx[a], o = a * M;
      let dx = 0, dy = 0;
      for (let i = 0; i < M; i++) { const v = R.K[o + i]; dx += v * wx[i]; dy += v * wy[i]; }
      const f = R.fade[a];
      pos[2 * k] += dx * f; pos[2 * k + 1] += dy * f;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.loc.size, w, h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufPos); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.loc.pos); gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bufTex);
    gl.enableVertexAttribArray(this.loc.tex); gl.vertexAttribPointer(this.loc.tex, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx);
    gl.drawElements(gl.TRIANGLES, m.idx.length, gl.UNSIGNED_SHORT, 0);
    return this.cv;
  }

  /**
   * 範囲の中の格子の頂点ごとの基底関数の値（制御点の並びが同じ間は使い回す）
   */
  rowsFor(tps, box) {
    if (this.rows && this.rows.tps === tps && this.rows.mesh === this.mesh) return this.rows;
    const m = this.mesh, idx = [], fade = [];
    for (let k = 0; k < m.rest.length / 2; k++) {
      const f = fadeAt(box, m.rest[2 * k], m.rest[2 * k + 1]);
      if (f) { idx.push(k); fade.push(f); }
    }
    const M = tps.m, K = new Float32Array(idx.length * M), row = new Float64Array(M);
    idx.forEach((k, a) => { tps.row(m.rest[2 * k], m.rest[2 * k + 1], row); K.set(row, a * M); });
    this.rows = { tps, mesh: m, idx: Uint32Array.from(idx), fade: Float32Array.from(fade), K };
    return this.rows;
  }

  /** WebGL を使えない場合：範囲の中の画素ごとに、移動元（変形の逆）を格子で補間して描く */
  renderCpu(src, tps, box) {
    const w = src.width, h = src.height;
    if (!this.out || this.out.width !== w || this.out.height !== h) {
      this.out = document.createElement('canvas'); this.out.width = w; this.out.height = h;
    }
    const ox = this.out.getContext('2d', { willReadFrequently: true });
    ox.drawImage(src, 0, 0);
    const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
    const x1 = Math.min(w, Math.ceil(box.x1)), y1 = Math.min(h, Math.ceil(box.y1));
    const bw = x1 - x0, bh = y1 - y0;
    if (bw < 2 || bh < 2) return this.out;
    // 移動元の格子（出力の点 x → 元の画像の点 s。s + 移動量(s) = x を繰り返しで解く）
    const step = Math.max(8, Math.max(w, h) / CELLS);
    const gx = Math.ceil(bw / step) + 1, gy = Math.ceil(bh / step) + 1;
    const sx = new Float32Array(gx * gy), sy = new Float32Array(gx * gy), d = [0, 0];
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
      const x = x0 + i * step, y = y0 + j * step;
      let px = x, py = y;
      for (let it = 0; it < 4; it++) {
        const f = fadeAt(box, px, py);
        if (!f) { d[0] = 0; d[1] = 0; } else { tps.dispInto(px, py, d); d[0] *= f; d[1] *= f; }
        px = x - d[0]; py = y - d[1];
      }
      sx[j * gx + i] = px; sy[j * gx + i] = py;
    }
    const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const dst = ox.getImageData(x0, y0, bw, bh), dd = dst.data;
    for (let y = 0; y < bh; y++) {
      const fy = y / step, j = Math.min(gy - 2, Math.floor(fy)), v = fy - j;
      for (let x = 0; x < bw; x++) {
        const fx = x / step, i = Math.min(gx - 2, Math.floor(fx)), u = fx - i, k = j * gx + i;
        const X = (sx[k] * (1 - u) + sx[k + 1] * u) * (1 - v) + (sx[k + gx] * (1 - u) + sx[k + gx + 1] * u) * v;
        const Y = (sy[k] * (1 - u) + sy[k + 1] * u) * (1 - v) + (sy[k + gx] * (1 - u) + sy[k + gx + 1] * u) * v;
        if (Math.abs(X - (x0 + x)) < 0.05 && Math.abs(Y - (y0 + y)) < 0.05) continue;
        const qx = Math.min(w - 1.001, Math.max(0, X - 0.5)), qy = Math.min(h - 1.001, Math.max(0, Y - 0.5));
        const ix = Math.floor(qx), iy = Math.floor(qy), a = qx - ix, b = qy - iy;
        const k00 = (iy * w + ix) * 4, k10 = k00 + 4, k01 = k00 + w * 4, k11 = k01 + 4, o = (y * bw + x) * 4;
        for (let c = 0; c < 4; c++) dd[o + c] = (sd[k00 + c] * (1 - a) + sd[k10 + c] * a) * (1 - b) + (sd[k01 + c] * (1 - a) + sd[k11 + c] * a) * b;
      }
    }
    ox.putImageData(dst, x0, y0);
    return this.out;
  }
}
