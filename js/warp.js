// 形の変更の変形：制御点（取っ手と固定点）による画像の変形と、その描画
// 仕様書「形の変更」と、技術構成の「形の変更の実装」を参照
//
// 変形は、制御点の元の位置 P と動かした後の位置 Q から、画像のすべての点の移動先を決める
// 移動最小二乗法（MLS：Moving Least Squares、剛体版）で行う。制御点の近くほどその制御点に従い、
// 間は滑らかにつながる。取っ手の周りに動かない固定点を置き、変形が顔の他の部分に広がらないようにする。
//
// 描画は WebGL で、画像を貼った格子の頂点を移動先へ動かして描く（指の動きに合わせて描き直せる速さにするため）。
// WebGL を使えない場合は、画素ごとに移動元を求めて描く（遅い）。

/**
 * 点 (vx, vy) の移動先（MLS・剛体版）
 * @param P 制御点の元の位置 [x0, y0, x1, y1, ...]、Q 動かした後の位置（同じ並び）
 */
export function mls(P, Q, vx, vy) { const o = [0, 0]; mlsInto(P, Q, vx, vy, o); return o; }

let W = new Float64Array(0);
/** mls と同じ。結果を out に書く（格子の頂点ごとに呼ぶため、配列を作らない） */
export function mlsInto(P, Q, vx, vy, out) {
  const n = P.length >> 1;
  if (W.length < n) W = new Float64Array(n);
  let sw = 0, px = 0, py = 0, qx = 0, qy = 0;
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    const dx = P[j] - vx, dy = P[j + 1] - vy, d2 = dx * dx + dy * dy;
    if (d2 < 1e-6) { out[0] = Q[j]; out[1] = Q[j + 1]; return; } // 制御点の上はその移動先
    const wi = 1 / d2;
    W[i] = wi; sw += wi;
    px += wi * P[j]; py += wi * P[j + 1]; qx += wi * Q[j]; qy += wi * Q[j + 1];
  }
  px /= sw; py /= sw; qx /= sw; qy /= sw;
  const cx = vx - px, cy = vy - py;
  let fx = 0, fy = 0;
  for (let i = 0, j = 0; i < n; i++, j += 2) {
    const ax = P[j] - px, ay = P[j + 1] - py, bx = Q[j] - qx, by = Q[j + 1] - qy;
    const al = ax * cx + ay * cy, be = ax * cy - ay * cx, wi = W[i];
    fx += wi * (bx * al - by * be); fy += wi * (bx * be + by * al);
  }
  const fl = Math.sqrt(fx * fx + fy * fy), cl = Math.sqrt(cx * cx + cy * cy);
  if (fl < 1e-9) { out[0] = vx - px + qx; out[1] = vy - py + qy; return; }
  out[0] = qx + (cl * fx) / fl; out[1] = qy + (cl * fy) / fl;
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

/** 制御点が1つも動いていないか */
export function isIdentity(P, Q) {
  for (let i = 0; i < P.length; i++) if (Math.abs(P[i] - Q[i]) > 0.01) return false;
  return true;
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
   * @param src 元の画像（2D の canvas）、P / Q 制御点、box 変形がある範囲 {x0, y0, x1, y1}（範囲の外は計算しない）
   */
  render(src, P, Q, box) {
    const w = src.width, h = src.height;
    if (!this.setup(w, h)) return this.renderCpu(src, P, Q, box);
    const gl = this.gl;
    if (!this.mesh || this.mesh.w !== w || this.mesh.h !== h) {
      this.mesh = this.makeMesh(w, h);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.bufTex); gl.bufferData(gl.ARRAY_BUFFER, this.mesh.rest, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bufIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.idx, gl.STATIC_DRAW);
    }
    if (this.src !== src) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.src = src;
    }
    const m = this.mesh, pos = m.pos, q = [0, 0];
    pos.set(m.rest);
    for (let k = 0; k < pos.length; k += 2) {
      const x = m.rest[k], y = m.rest[k + 1];
      const f = fadeAt(box, x, y);
      if (!f) continue;
      mlsInto(P, Q, x, y, q);
      pos[k] = x + (q[0] - x) * f; pos[k + 1] = y + (q[1] - y) * f;
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

  /** WebGL を使えない場合：範囲の中の画素ごとに、移動元（Q → P の変形）を格子で補間して描く */
  renderCpu(src, P, Q, box) {
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
    // 移動元の格子（出力の点 → 元の画像の点）
    const step = Math.max(8, Math.max(w, h) / CELLS);
    const gx = Math.ceil(bw / step) + 1, gy = Math.ceil(bh / step) + 1;
    const sx = new Float32Array(gx * gy), sy = new Float32Array(gx * gy);
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
      const x = x0 + i * step, y = y0 + j * step, f = fadeAt(box, x, y);
      const s = f ? mls(Q, P, x, y) : [x, y];
      sx[j * gx + i] = x + (s[0] - x) * f; sy[j * gx + i] = y + (s[1] - y) * f;
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
