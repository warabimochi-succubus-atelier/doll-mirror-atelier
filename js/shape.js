// 形の変更の内容：取っ手（輪郭・アイホールの制御点）、スライダーの値、左右対称・左右コピー
// 仕様書「形の変更」を参照
//
// 取っ手は「元の位置 r」（取り込み画像の輪郭の上の点。位置合わせで動かす）と
// 「移動量 d」（変形で動かす）を持つ。実際の移動量は d にスライダーの分を足したもの（effD）。
// 画像の変形は、取っ手（r → r + effD）と、動かない固定点から作る（warp.js）。
// 左右は「ドール本人から見た左右」：L はドールの左（画面右側）、R はドールの右（画面左側）。

import * as G from './geom.js';
import { FRAME_ASPECT } from './imaging.js';

/** 形の変更の対象 */
export const GROUPS = [
  { id: 'face', name: '輪郭（頬・あご）', screen: '' },
  { id: 'eyeR', name: '右アイホール', screen: '画面左側', side: 'R', pair: 'eyeL' },
  { id: 'eyeL', name: '左アイホール', screen: '画面右側', side: 'L', pair: 'eyeR' },
];
export const groupDef = (id) => GROUPS.find((g) => g.id === id);
export const groupLabel = (id) => { const d = groupDef(id); return d.screen ? `${d.name}（${d.screen}）` : d.name; };

const SGN = { L: 1, R: -1, C: 0 };
const OTHER = { L: 'R', R: 'L' };
export const sideLabel = (s) => (s === 'L' ? '左（画面右側）' : '右（画面左側）');

// 輪郭の取っ手：フレームガイドの楕円の上の角度（上端から測る）
const FACE_KEYS = [['temple', 'こめかみ', 70], ['cheek', '頬', 100], ['era', 'エラ', 125], ['jaw', 'あご', 152]];
const EYE_KEYS = [['in', '目頭'], ['top', '上縁'], ['out', '目尻'], ['bot', '下縁']];

// 変形の制御点：曲線を区切る細かさ（取っ手の間ごと）と、輪郭の固定の帯（顔の中心からの倍率）
const FACE_SEG = 6, EYE_SEG = 6, FACE_IN = 0.6, FACE_OUT = 1.45;
// アイホールの固定点：アイの部分（縁を中心へ縮めた倍率）と、外側の輪（横・縦の半径の倍率）
const EYE_IN = 0.3, EYE_OUT = [1.7, 2.4];

/** スライダー（Live2D のパラメーターに相当）。値は -1〜1 */
export const SLIDERS = {
  face: [
    { key: 'cheek', label: '頬の張り', plus: '外へ（パテ盛り）', minus: '内へ（削り）' },
    { key: 'era', label: 'エラ', plus: '外へ（パテ盛り）', minus: '内へ（削り）' },
    { key: 'jawW', label: 'あごの幅', plus: '広く（パテ盛り）', minus: '細く（削り）' },
    { key: 'chin', label: 'あごの長さ', plus: '長く（パテ盛り）', minus: '短く（削り）', shared: true },
  ],
  eye: [
    { key: 'up', label: '上縁（まぶたのライン）', plus: '上げる（削り）', minus: '下げる（パテ盛り）' },
    { key: 'down', label: '下縁', plus: '下げる（削り）', minus: '上げる（パテ盛り）' },
    { key: 'tail', label: '目尻', plus: '上げる', minus: '下げる' },
    { key: 'size', label: '大きさ', plus: '大きく（削り）', minus: '小さく（パテ盛り）' },
  ],
};
const eyeParams = () => ({ up: 0, down: 0, tail: 0, size: 0 });
const faceSide = () => ({ cheek: 0, era: 0, jawW: 0 });

/** 取り込み時の顔位置設定のガイド（目の高さの線・目頭マーク・フレームガイドの楕円）から、取っ手の初期位置を決める */
export function initShape(cap) {
  const ax = G.axis(cap.w, cap.h, cap.angle), g = cap.guides;
  const eye = (g.eyeY - 0.5) * cap.h, sp = g.spacing * cap.w;
  const ry = (g.frame * cap.h) / 2, rx = ry * FRAME_ASPECT;
  const hs = [];
  const add = (id, group, key, side, pair, label, along, s) => {
    const r = G.fromAxis(ax, along, s);
    hs.push({ id, group, key, side, pair, label, r, r0: r.slice(), d: [0, 0] });
  };
  for (const [key, label, deg] of FACE_KEYS) {
    const t = deg * G.DEG;
    for (const s of ['R', 'L']) add(key + s, 'face', key, s, key + OTHER[s], label, -ry * Math.cos(t), SGN[s] * rx * Math.sin(t));
  }
  add('chin', 'face', 'chin', 'C', null, 'あご先', ry, 0);
  const a = (sp * 0.95) / 2, b = a * 0.7;
  for (const s of ['R', 'L']) {
    const gid = 'eye' + s, k = SGN[s], c = sp / 2 + a;
    const pos = { in: [eye, k * (sp / 2)], top: [eye - b, k * c], out: [eye, k * (c + a)], bot: [eye + b, k * c] };
    for (const [key, label] of EYE_KEYS) add(`${gid}.${key}`, gid, key, s, `eye${OTHER[s]}.${key}`, label, ...pos[key]);
  }
  return { handles: hs, params: { face: { L: faceSide(), R: faceSide(), chin: 0 }, eyeL: eyeParams(), eyeR: eyeParams() } };
}

export function cloneShape(sh) {
  return {
    handles: sh.handles.map((h) => ({ ...h, r: h.r.slice(), r0: h.r0, d: h.d.slice() })),
    params: structuredClone(sh.params),
  };
}

const H = (sh, id) => sh.handles.find((h) => h.id === id);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);

/** 輪郭の中心と大きさ（頬の取っ手の中点を中心とする） */
function faceFrame(sh, ax) {
  const L = H(sh, 'cheekL').r, R = H(sh, 'cheekR').r, c = mid(L, R);
  return { c, rx: Math.max(1, len(sub(L, R)) / 2), ry: Math.max(1, dot(sub(H(sh, 'chin').r, c), ax.u)) };
}
/** アイホールの中心・向き・大きさ */
function eyeFrame(sh, gid, ax) {
  const i = H(sh, gid + '.in').r, o = H(sh, gid + '.out').r, t = H(sh, gid + '.top').r, b = H(sh, gid + '.bot').r;
  const c = mid(i, o), a = Math.max(1, len(sub(o, i)) / 2);
  const ex = [(o[0] - i[0]) / (2 * a), (o[1] - i[1]) / (2 * a)];
  const bb = Math.max(1, (Math.abs(dot(sub(t, c), ax.u)) + Math.abs(dot(sub(b, c), ax.u))) / 2);
  return { c, a, b: bb, ex };
}

/** スライダーの分の移動量 */
function paramD(sh, h, ax) {
  const u = ax.u, up = [-u[0], -u[1]];
  if (h.group === 'face') {
    const f = faceFrame(sh, ax), pc = sh.params.face.chin;
    if (h.key === 'chin') return [u[0] * f.ry * 0.1 * pc, u[1] * f.ry * 0.1 * pc];
    const p = sh.params.face[h.side], k = SGN[h.side], n = [ax.n[0] * k, ax.n[1] * k];
    const w = { temple: 0.04 * p.cheek, cheek: 0.12 * p.cheek + 0.03 * p.era, era: 0.04 * p.cheek + 0.12 * p.era + 0.04 * p.jawW, jaw: 0.03 * p.era + 0.12 * p.jawW }[h.key] * f.rx;
    const v = h.key === 'jaw' ? 0.04 * pc * f.ry : 0;
    return [n[0] * w + u[0] * v, n[1] * w + u[1] * v];
  }
  const e = eyeFrame(sh, h.group, ax), p = sh.params[h.group];
  const r = sub(h.r, e.c), s = 0.3 * p.size;
  let dx = r[0] * s, dy = r[1] * s;
  const m = e.b * 0.5;
  if (h.key === 'top') { dx += up[0] * m * p.up; dy += up[1] * m * p.up; }
  if (h.key === 'bot') { dx += u[0] * m * p.down; dy += u[1] * m * p.down; }
  if (h.key === 'out') { dx += up[0] * m * p.tail; dy += up[1] * m * p.tail; }
  // 上縁・下縁は、アイの中心から縦の半径の半分より近づけない（アイの部分の固定点を越えて画像が折り返さないように）
  if (h.key === 'top' || h.key === 'bot') {
    const dir = h.key === 'top' ? up : u, k = dot([r[0] + dx, r[1] + dy], dir), lim = e.b * 0.5;
    if (k < lim) { dx += dir[0] * (lim - k); dy += dir[1] * (lim - k); }
  }
  return [dx, dy];
}
/** 取っ手の実際の移動量（ドラッグ等の移動量 ＋ スライダーの分） */
export function effD(sh, h, ax) { const p = paramD(sh, h, ax); return [h.d[0] + p[0], h.d[1] + p[1]]; }
/** 変形後の取っ手の位置 */
export function moved(sh, h, ax) { const d = effD(sh, h, ax); return [h.r[0] + d[0], h.r[1] + d[1]]; }

/** 変形の向きから「削り」「パテ盛り」を判定する（変形していなければ null） */
export function kindOf(sh, h, ax) {
  const d = effD(sh, h, ax);
  if (len(d) < 0.5) return null;
  const c = h.group === 'face' ? faceFrame(sh, ax).c : eyeFrame(sh, h.group, ax).c;
  const out = dot(d, sub(h.r, c)) > 0;
  // 頬・あごを外へ＝パテ盛り、内へ＝削り。アイホールを広げる＝削り、狭める＝パテ盛り
  return h.group === 'face' ? (out ? 'パテ盛り' : '削り') : (out ? '削り' : 'パテ盛り');
}

/** 変形があるか（group を指定するとその対象だけ） */
export function changed(sh, ax, group = null) {
  return sh.handles.some((h) => (!group || h.group === group) && len(effD(sh, h, ax)) >= 0.5);
}
/** 変形がある側の一覧（+1 画面右側 / -1 画面左側 / 0 中央） */
export function changedSides(sh, ax) {
  const s = new Set();
  for (const h of sh.handles) if (len(effD(sh, h, ax)) >= 0.5) s.add(SGN[h.side]);
  return s;
}

// ---------------- 編集 ----------------

/** あご先は中心線の上に置き、左右対称のときは中心線に沿ってだけ動かす */
function onAxis(ax, p) { const a = G.alongOf(ax, p); return G.fromAxis(ax, a, 0); }

/** 取っ手の元の位置を変える（位置合わせ）。sym なら反対側も鏡のように動かす */
export function setRest(sh, id, r, ax, sym) {
  const h = H(sh, id);
  h.r = h.key === 'chin' ? onAxis(ax, r) : r.slice();
  if (sym && h.pair) H(sh, h.pair).r = G.ap(G.reflectM(ax), h.r);
}
/** アイホールの取っ手をまとめて動かす（位置合わせ） */
export function moveGroupRest(sh, gid, delta, ax, sym) {
  for (const h of sh.handles) if (h.group === gid) { h.r = [h.r[0] + delta[0], h.r[1] + delta[1]]; }
  if (sym) { const M = G.reflectM(ax); for (const h of sh.handles) if (h.group === gid && h.pair) H(sh, h.pair).r = G.ap(M, h.r); }
}
/** 取っ手の移動量を変える（変形）。sym なら反対側も鏡のように動かす */
export function setD(sh, id, d, ax, sym) {
  const h = H(sh, id);
  h.d = sym && h.key === 'chin' ? [ax.u[0] * dot(d, ax.u), ax.u[1] * dot(d, ax.u)] : d.slice();
  if (sym && h.pair) H(sh, h.pair).d = G.apv(G.reflectM(ax), h.d);
}
/** スライダーの値を変える。輪郭は side の側（sym なら両側）、アイホールは group（sym なら反対側のアイホールも） */
export function setParam(sh, group, side, key, v, sym) {
  if (group === 'face') {
    if (key === 'chin') { sh.params.face.chin = v; return; }
    sh.params.face[side][key] = v;
    if (sym) sh.params.face[OTHER[side]][key] = v;
  } else {
    sh.params[group][key] = v;
    if (sym) sh.params[groupDef(group).pair][key] = v;
  }
}
export function getParam(sh, group, side, key) {
  if (group === 'face') return key === 'chin' ? sh.params.face.chin : sh.params.face[side][key];
  return sh.params[group][key];
}
/** 左右コピー：輪郭は from の側の変形を反対側へ。アイホールは group の変形を反対側のアイホールへ */
export function copySide(sh, group, from, ax) {
  const M = G.reflectM(ax);
  if (group === 'face') {
    for (const h of sh.handles) if (h.group === 'face' && h.side === from) H(sh, h.pair).d = G.apv(M, h.d);
    sh.params.face[OTHER[from]] = { ...sh.params.face[from] };
  } else {
    const pg = groupDef(group).pair;
    for (const h of sh.handles) if (h.group === group) H(sh, h.pair).d = G.apv(M, h.d);
    sh.params[pg] = { ...sh.params[group] };
  }
}
/** 変形をリセット（取っ手の位置はそのまま） */
export function resetDeform(sh, group) {
  for (const h of sh.handles) if (h.group === group) h.d = [0, 0];
  if (group === 'face') sh.params.face = { L: faceSide(), R: faceSide(), chin: 0 };
  else sh.params[group] = eyeParams();
}
/** 取っ手の位置を初期に戻す（位置合わせのやり直し） */
export function resetRest(sh, group) { for (const h of sh.handles) if (h.group === group) h.r = h.r0.slice(); }

// ---------------- 変形の制御点 ----------------

/**
 * 変形の制御点と、変形を計算する範囲。
 * 取っ手を通る曲線（輪郭・アイホール）を細かく区切った点を「元の曲線 → 変形後の曲線」で動かし、
 * 曲線の内側と外側に帯のように並べた固定点で、変形を曲線の周りに収める。
 * 固定点の位置は元の位置（位置合わせ）だけから決める（変形の操作中は制御点の並びが変わらないようにして、
 * warp.js の計算の準備を使い回すため）
 * @returns {{ P: Float64Array, Q: Float64Array, box, identity }}
 */
export function controls(sh, ax) {
  const P = [], Q = [];
  const far = (p, dmin) => {
    for (let i = 0; i < P.length; i += 2) if (Math.hypot(P[i] - p[0], P[i + 1] - p[1]) < dmin) return false;
    return true;
  };
  const add = (p, q, dmin) => { if (far(p, dmin)) { P.push(p[0], p[1]); Q.push(q[0], q[1]); } };
  const fix = (p, dmin) => add(p, p, dmin);
  const eyes = ['eyeR', 'eyeL'].map((g) => eyeFrame(sh, g, ax));
  const inEye = (p, k) => eyes.some((e) => {
    const v = sub(p, e.c), x = dot(v, e.ex), y = v[0] * -e.ex[1] + v[1] * e.ex[0];
    return (x / (e.a * k)) ** 2 + (y / (e.b * k)) ** 2 < 1;
  });
  const minD = Math.max(4, Math.min(...eyes.map((e) => Math.min(e.a, e.b))) * 0.3);
  // 動く曲線：輪郭（開いた曲線）と、左右のアイホール（閉じた曲線）
  const face = outlineOrder(sh, 'face');
  const fr = curve(face.map((h) => h.r), false, FACE_SEG), fq = curve(face.map((h) => moved(sh, h, ax)), false, FACE_SEG);
  fr.forEach((p, i) => add(p, fq[i], 2));
  const eyeRest = [];
  for (const gid of ['eyeR', 'eyeL']) {
    const hs = outlineOrder(sh, gid);
    const er = curve(hs.map((h) => h.r), true, EYE_SEG).slice(0, -1), eq = curve(hs.map((h) => moved(sh, h, ax)), true, EYE_SEG);
    er.forEach((p, i) => add(p, eq[i], 2));
    eyeRest.push(er);
  }
  const nMove = P.length;
  // アイホール：アイの部分（中心と、縁を縮めた輪）と、アイホールの外側の輪を固定する
  for (const [gi, e] of eyes.entries()) {
    fix(e.c, minD);
    eyeRest[gi].forEach((p, k) => { if (k % 2 === 0) fix([e.c[0] + (p[0] - e.c[0]) * EYE_IN, e.c[1] + (p[1] - e.c[1]) * EYE_IN], minD); });
    const ey = [-e.ex[1], e.ex[0]];
    for (let k = 0; k < 12; k++) {
      const t = (k / 12) * Math.PI * 2, x = Math.cos(t) * e.a * EYE_OUT[0], y = Math.sin(t) * e.b * EYE_OUT[1];
      fix([e.c[0] + e.ex[0] * x + ey[0] * y, e.c[1] + e.ex[1] * x + ey[1] * y], minD);
    }
  }
  // 輪郭：顔の中心へ縮めた線と、外へ広げた線の上を固定する（間の帯の中で変形する。内側は目・鼻・口を動かさないため）
  const f = faceFrame(sh, ax), u = ax.u, n = ax.n;
  fix(f.c, minD);
  const scaled = (k) => fr.map((p) => [f.c[0] + (p[0] - f.c[0]) * k, f.c[1] + (p[1] - f.c[1]) * k]);
  for (const p of scaled(FACE_IN)) if (!inEye(p, 1.8)) fix(p, minD);
  for (const p of scaled(FACE_OUT)) fix(p, minD);
  // 鼻・口のあたり（中心線の上と、その左右）。あごの近くまで固定し、あごを動かしても口が動かないようにする
  for (const [a, s] of [[0.3, 0], [0.55, 0], [0.75, 0], [0.75, -0.22], [0.75, 0.22], [0.55, -0.3], [0.55, 0.3]]) {
    fix([f.c[0] + u[0] * a * f.ry + n[0] * s * f.rx, f.c[1] + u[1] * a * f.ry + n[1] * s * f.rx], minD);
  }
  // 額（輪郭の曲線はこめかみまでのため）
  const at = (a, s) => [f.c[0] + u[0] * a * f.ry + n[0] * s * f.rx, f.c[1] + u[1] * a * f.ry + n[1] * s * f.rx];
  for (const p of [at(-0.95, 0), at(-0.75, -0.6), at(-0.75, 0.6), at(-1.3, 0), at(-0.95, -1.1), at(-0.95, 1.1)]) fix(p, minD);
  let identity = true;
  for (let i = 0; i < nMove && identity; i++) if (Math.abs(P[i] - Q[i]) > 0.01) identity = false;
  // 計算する範囲：固定点を囲む矩形を少し広げる。範囲の縁にも固定点を置き、縁に向かって変形を弱める
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < P.length; i += 2) {
    x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]);
  }
  const band = Math.max(x1 - x0, y1 - y0) * 0.08;
  const box = { x0: x0 - band, y0: y0 - band, x1: x1 + band, y1: y1 + band, band };
  for (let k = 0; k < 4; k++) {
    const t = k / 4;
    for (const p of [[box.x0 + (box.x1 - box.x0) * t, box.y0], [box.x1, box.y0 + (box.y1 - box.y0) * t],
      [box.x1 - (box.x1 - box.x0) * t, box.y1], [box.x0, box.y1 - (box.y1 - box.y0) * t]]) fix(p, 1);
  }
  return { P: Float64Array.from(P), Q: Float64Array.from(Q), box, identity };
}

// ---------------- 表示用の曲線 ----------------

/** 取っ手を通る滑らかな曲線（Catmull-Rom）。closed なら閉じた曲線 */
export function curve(pts, closed, seg = 10) {
  const n = pts.length, out = [];
  const p = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = p(i - 1), b = p(i), c = p(i + 1), d = p(i + 2);
    for (let k = 0; k < seg; k++) {
      const t = k / seg, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * b[j] + (-a[j] + c[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t2 + (-a[j] + 3 * b[j] - 3 * c[j] + d[j]) * t3)));
    }
  }
  out.push(closed ? pts[0] : pts[n - 1]);
  return out;
}
/** 対象の取っ手を、曲線の順に並べる（輪郭は画面左のこめかみ → あご先 → 画面右のこめかみ、アイホールは一周） */
export function outlineOrder(sh, group) {
  if (group === 'face') {
    const ids = ['templeR', 'cheekR', 'eraR', 'jawR', 'chin', 'jawL', 'eraL', 'cheekL', 'templeL'];
    return ids.map((id) => H(sh, id));
  }
  return EYE_KEYS.map(([k]) => H(sh, `${group}.${k}`));
}
export { H as handleOf, eyeFrame };
