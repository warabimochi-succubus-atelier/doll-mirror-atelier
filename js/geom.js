// 座標計算：2D アフィン行列・中心線・多角形
//
// 行列は canvas の setTransform と同じ並び [a, b, c, d, e, f]（x' = a·x + c·y + e、y' = b·x + d·y + f）
// 画像の座標は左上が原点、x が右、y が下。

export const I = () => [1, 0, 0, 1, 0, 0];
/** m ∘ n（n を先に当て、次に m を当てる） */
export const mul = (m, ...rest) => rest.reduce((a, n) => [
  a[0] * n[0] + a[2] * n[1], a[1] * n[0] + a[3] * n[1],
  a[0] * n[2] + a[2] * n[3], a[1] * n[2] + a[3] * n[3],
  a[0] * n[4] + a[2] * n[5] + a[4], a[1] * n[4] + a[3] * n[5] + a[5],
], m);
export const inv = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
export const ap = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
/** 平行移動を除いた部分（向き・長さだけを変える） */
export const apv = (m, v) => [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
export const T = (x, y) => [1, 0, 0, 1, x, y];
export const R = (rad) => { const c = Math.cos(rad), s = Math.sin(rad); return [c, s, -s, c, 0, 0]; };
export const S = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export const scaleOf = (m) => Math.hypot(m[0], m[1]);
export const DEG = Math.PI / 180;

// ---------------- 中心線 ----------------
// 中心線は映像（撮影画像）の中央を通り、角度 deg（時計回りが正）だけ垂直から傾いた線。
// u：線の向き（下向き）、n：線に直交し画面右側を向く向き。

export function axis(w, h, deg) {
  const r = deg * DEG;
  return { c: [w / 2, h / 2], u: [-Math.sin(r), Math.cos(r)], n: [Math.cos(r), Math.sin(r)] };
}
/** 中心線を軸とした反転（鏡映）の行列 */
export function reflectM(ax) {
  const [ux, uy] = ax.u;
  const a = 2 * ux * ux - 1, b = 2 * ux * uy, d = 2 * uy * uy - 1;
  const [cx, cy] = ax.c;
  return [a, b, b, d, cx - (a * cx + b * cy), cy - (b * cx + d * cy)];
}
/** 中心線から見た側：正 = 画面右側、負 = 画面左側 */
export const sideOf = (ax, p) => (p[0] - ax.c[0]) * ax.n[0] + (p[1] - ax.c[1]) * ax.n[1];
/** 中心線に沿った位置（中央から下向きの距離） */
export const alongOf = (ax, p) => (p[0] - ax.c[0]) * ax.u[0] + (p[1] - ax.c[1]) * ax.u[1];
/** 中心線の座標系（along：下向き、side：右向き）から画像の座標へ */
export const fromAxis = (ax, along, side) => [ax.c[0] + ax.u[0] * along + ax.n[0] * side, ax.c[1] + ax.u[1] * along + ax.n[1] * side];
/** 中心線のどちらか一方の側を覆う多角形（クリップ用）。side：+1 画面右側、-1 画面左側 */
export function halfPlane(ax, side, L) {
  const p = (a, s) => fromAxis(ax, a, s);
  return [p(-L, 0), p(L, 0), p(L, side * L), p(-L, side * L)];
}

// ---------------- 多角形 ----------------

export function bbox(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
export function area(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  return Math.abs(s / 2);
}
export function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}
/** 主軸の向き（ラジアン）。眉・アイラインなど細長いパーツの「長さ方向」 */
export function principalAngle(pts) {
  const [mx, my] = centroid(pts);
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { const dx = x - mx, dy = y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}
export function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** 点を間引く（指でなぞった軌跡は点が多すぎるため） */
export function simplify(pts, minDist) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) >= minDist) out.push(p);
  }
  return out;
}
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
/** 大きさ (w, h) を、枠 (W, H) いっぱいに覆うように中央へ置いたときの矩形（はみ出した分は左右・上下対称に切れる） */
export function coverRect(w, h, W, H) {
  const s = Math.max(W / w, H / h);
  return { x: (W - w * s) / 2, y: (H - h * s) / 2, w: w * s, h: h * s, s };
}
/** 大きさ (w, h) を、枠 (W, H) の中に収まるように中央へ置いたときの矩形 */
export function containRect(w, h, W, H) {
  const s = Math.min(W / w, H / h);
  return { x: (W - w * s) / 2, y: (H - h * s) / 2, w: w * s, h: h * s, s };
}
