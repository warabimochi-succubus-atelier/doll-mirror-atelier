// シミュレーション（パーツ移動・形の変更）の内容と描画、取り消し（Undo / Redo）
// 仕様書「シミュレーション画面」「パーツ選択」「パーツ移動シミュレーション」「形の変更」を参照
//
// 重ね順：取り込み画像 → 形の変更（輪郭の変形）→ 元の位置の処理（薄くする・消す）→ パーツの仮置きレイヤー（乗算）
// パーツの選択範囲は取り込み画像の座標で持ち、形の変更がある場合は変形を当てた位置で扱う。

import * as G from './geom.js';
import * as IM from './imaging.js';

const UNDO_MAX = 100;

// ---------------- パーツの名前（想定対象） ----------------
export const PART_NAMES = [
  '左眉', '右眉', '左アイライン', '右アイライン', '左チーク', '右チーク', '左アイシャドウ', '右アイシャドウ',
  '左まつ毛', '右まつ毛', 'リップ', 'その他（ドールの左）', 'その他（ドールの右）', 'その他（中央）',
];
const isOther = (n) => n.startsWith('その他');
/** 左右コピーのコピー先の名前（コピーできないものは null） */
export function pairName(n) {
  if (n === 'リップ' || n === 'その他（中央）') return null;
  if (n === 'その他（ドールの左）') return 'その他（ドールの右）';
  if (n === 'その他（ドールの右）') return 'その他（ドールの左）';
  if (n.startsWith('左')) return '右' + n.slice(1);
  if (n.startsWith('右')) return '左' + n.slice(1);
  return null;
}
/** 画面上の位置を添えた名前（例：左眉（画面右側）） */
export function partLabel(n) {
  if (n.startsWith('左') || n === 'その他（ドールの左）') return `${n}（画面右側）`;
  if (n.startsWith('右') || n === 'その他（ドールの右）') return `${n}（画面左側）`;
  return n;
}

// ---------------- 形の変更の対象 ----------------
export const TARGETS = [
  { id: 'eyeL', name: '左アイホール', screen: '画面右側', side: 1, kind: 'eye', pair: 'eyeR' },
  { id: 'eyeR', name: '右アイホール', screen: '画面左側', side: -1, kind: 'eye', pair: 'eyeL' },
  { id: 'cheekL', name: '左頬のライン', screen: '画面右側', side: 1, kind: 'face', pair: 'cheekR' },
  { id: 'cheekR', name: '右頬のライン', screen: '画面左側', side: -1, kind: 'face', pair: 'cheekL' },
  { id: 'jaw', name: 'あごのライン', screen: '', side: 0, kind: 'face', pair: null },
];
export const targetLabel = (d) => (d.screen ? `${d.name}（${d.screen}）` : d.name);

let seq = 1;

export class Sim {
  /**
   * @param cap 取り込み画像 { canvas, w, h, angle, guides: { eyeY, spacing, frame }, time }
   */
  constructor(cap) {
    this.cap = cap;
    this.parts = [];
    this.sel = null;          // 編集中のパーツの id
    this.targets = initTargets(cap);
    this.undoStack = [];
    this.redoStack = [];
    this.ver = 1;             // 内容が変わるたびに増やす（描画のキャッシュの判定に使う）
    this.deformVer = 1;
    this._deformed = null; this._deformedVer = 0;
    this._full = null; this._fullVer = 0;
  }

  get ax() { return G.axis(this.cap.w, this.cap.h, this.cap.angle); }
  get refl() { return G.reflectM(this.ax); }
  get hasContent() { return this.parts.length > 0 || this.targets.some((t) => !IM.gridIsZero(this.eff(t))); }
  part(id) { return this.parts.find((p) => p.id === id) || null; }
  get selPart() { return this.part(this.sel); }

  // ---------------- 取り消し（Undo / Redo） ----------------
  snapshot() {
    return {
      parts: this.parts.map((p) => ({ ...p, poly: p.poly.map((q) => q.slice()), t: { ...p.t }, pivot: p.pivot?.slice() || null, copy: p.copy ? structuredClone(p.copy) : null, _ex: undefined, _ox: undefined })),
      targets: this.targets.map((t) => ({ ...t, own: { dx: t.own.dx.slice(), dy: t.own.dy.slice() }, mirror: t.mirror ? cloneMirror(t.mirror) : null, _eff: undefined })),
      sel: this.sel,
    };
  }
  restore(s) {
    this.parts = s.parts.map((p) => ({ ...p }));
    this.targets = s.targets.map((t) => ({ ...t }));
    this.sel = this.part(s.sel) ? s.sel : (this.parts[this.parts.length - 1]?.id ?? null);
    this.touchDeform();
  }
  /** 操作の直前に呼ぶ（その時点の状態を取り消しの履歴に積む） */
  begin() {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > UNDO_MAX) this.undoStack.shift();
    this.redoStack = [];
  }
  /** 直前に begin() したが、何も変わらなかった場合に履歴から外す */
  cancel() { this.undoStack.pop(); }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); return true; }

  touch() { this.ver++; }
  touchDeform() { this.deformVer++; this.targets.forEach((t) => (t._eff = null)); this.parts.forEach((p) => { p._ex = null; p._ox = null; }); this.ver++; }
  /** 中心線の角度を変えたとき（取り込み画像に適用する場合）：中心線を基準にした計算をやり直す */
  setAngle(deg) { this.cap.angle = deg; this.touchDeform(); }

  // ---------------- 形の変更 ----------------
  tdef(id) { return TARGETS.find((d) => d.id === id); }
  target(id) { return this.targets.find((t) => t.id === id); }

  /** 実際に当てる移動量の格子（左右コピーの反転を含む） */
  eff(t) {
    if (t._eff) return t._eff;
    let g = t.own;
    if (t.mirror?.from) {
      // 反対側の対象からのコピー：コピー元の変形を中心線で反転したもの ＋ コピー後に加えた変形
      const M = this.refl, src = t.mirror.snap;
      const c = G.ap(M, [src.cx, src.cy]);
      t.cx = c[0]; t.cy = c[1]; t.R = src.R;
      g = IM.emptyGrid();
      for (let j = 0; j < IM.GRID_N; j++) for (let i = 0; i < IM.GRID_N; i++) {
        const k = j * IM.GRID_N + i, p = IM.nodePos(t, i, j);
        const v = G.apv(M, IM.sampleRaw(src, src.g, ...G.ap(M, p)));
        g.dx[k] = t.own.dx[k] + v[0]; g.dy[k] = t.own.dy[k] + v[1];
      }
    } else if (t.mirror?.side) {
      // あごのライン：変形した側の半分を中心線で反転し、もう半分に当てる
      const ax = this.ax, M = this.refl, s = t.mirror.side;
      g = IM.emptyGrid();
      for (let j = 0; j < IM.GRID_N; j++) for (let i = 0; i < IM.GRID_N; i++) {
        const k = j * IM.GRID_N + i, p = IM.nodePos(t, i, j);
        if (G.sideOf(ax, p) * s >= 0) { g.dx[k] = t.own.dx[k]; g.dy[k] = t.own.dy[k]; }
        else { const v = G.apv(M, IM.sampleRaw(t, t.own, ...G.ap(M, p))); g.dx[k] = v[0]; g.dy[k] = v[1]; }
      }
    }
    t._eff = g;
    return g;
  }
  /** 点 p の変形による移動量（すべての対象の合計） */
  disp(p) {
    let dx = 0, dy = 0;
    for (const t of this.targets) {
      const g = this.eff(t);
      if (IM.gridIsZero(g)) continue;
      const v = IM.sample(t, g, p[0], p[1]);
      dx += v[0]; dy += v[1];
    }
    return [dx, dy];
  }
  /** 形の変更を当てた画像 */
  deformed() {
    if (this._deformedVer === this.deformVer && this._deformed) return this._deformed;
    const list = this.targets.map((t) => ({ t, g: this.eff(t) })).filter((x) => !IM.gridIsZero(x.g));
    this._deformed = list.length ? IM.applyDeform(this.cap.canvas, list) : this.cap.canvas;
    this._deformedVer = this.deformVer;
    return this._deformed;
  }
  /** 影響範囲の中で、ドラッグした向きに輪郭を押し広げる・引き込む */
  brush(t, at, delta, radius) {
    const s2 = 2 * (radius / 2) ** 2;
    for (let j = 0; j < IM.GRID_N; j++) for (let i = 0; i < IM.GRID_N; i++) {
      const p = IM.nodePos(t, i, j), k = j * IM.GRID_N + i;
      const d2 = (p[0] - at[0]) ** 2 + (p[1] - at[1]) ** 2;
      const w = Math.exp(-d2 / s2);
      if (w < 0.002) continue;
      t.own.dx[k] = G.clamp(t.own.dx[k] + delta[0] * w, -t.R * 0.6, t.R * 0.6);
      t.own.dy[k] = G.clamp(t.own.dy[k] + delta[1] * w, -t.R * 0.6, t.R * 0.6);
    }
    this.touchDeform();
  }
  /** アイホール全体の拡大縮小（ds：倍率の増減。0.05 で 5% 拡大） */
  scaleTarget(t, ds) {
    for (let j = 0; j < IM.GRID_N; j++) for (let i = 0; i < IM.GRID_N; i++) {
      const p = IM.nodePos(t, i, j), k = j * IM.GRID_N + i;
      t.own.dx[k] += (p[0] - t.cx) * ds * 0.6;
      t.own.dy[k] += (p[1] - t.cy) * ds * 0.6;
    }
    this.touchDeform();
  }
  /** コピーで反転している対象を、今の見た目のまま自分の変形に固定する（範囲を動かすとき等） */
  bakeMirror(t) {
    if (!t.mirror) return;
    const g = this.eff(t);
    t.own = { dx: g.dx.slice(), dy: g.dy.slice() };
    t.mirror = null; t._eff = null;
  }
  /** 範囲（中心・半径）を変える。変形は範囲に対する位置のまま保つ */
  moveTarget(t, cx, cy, R) {
    this.bakeMirror(t);
    t.cx = cx; t.cy = cy; t.R = R;
    this.touchDeform();
  }
  resetTarget(t) {
    const d = initTargets(this.cap).find((x) => x.id === t.id);
    t.own = IM.emptyGrid(); t.mirror = null; t.cx = d.cx; t.cy = d.cy; t.R = d.R;
    // この対象からコピーしていた反対側は、コピーした時点の形を残す
    this.touchDeform();
  }
  /** 左右コピー：反対側の同じ対象へ。あごのラインは side（+1 画面右側 / -1 画面左側）の半分をもう半分へ */
  copyTarget(t, side) {
    const d = this.tdef(t.id);
    if (d.id === 'jaw') {
      this.bakeMirror(t);
      t.mirror = { side };
    } else {
      const dst = this.target(d.pair);
      const g = this.eff(t);
      dst.mirror = { from: t.id, snap: { cx: t.cx, cy: t.cy, R: t.R, g: { dx: g.dx.slice(), dy: g.dy.slice() } } };
      dst.own = IM.emptyGrid();
    }
    this.touchDeform();
  }
  /** 変形がある対象（ミラーの「基準でない側の修正」の判定に使う） */
  deformedTargets() { return this.targets.filter((t) => !IM.gridIsZero(this.eff(t))); }

  // ---------------- パーツ ----------------
  usedNames() { return new Set(this.parts.map((p) => p.name)); }
  nameFree(n, exceptId) { return isOther(n) || !this.parts.some((p) => p.name === n && p.id !== exceptId); }
  /** 囲んだ位置から名前の候補を決める */
  suggestName(poly) {
    const ax = this.ax, [cx, cy] = G.centroid(poly), g = this.cap.guides;
    const side = G.sideOf(ax, [cx, cy]), along = G.alongOf(ax, [cx, cy]);
    const eye = (g.eyeY - 0.5) * this.cap.h, sp = g.spacing * this.cap.w;
    const lr = side > 0 ? '左' : '右';
    let base;
    if (Math.abs(side) < sp * 0.35) base = along > eye + sp ? 'リップ' : 'その他（中央）';
    else if (along < eye - sp * 0.55) base = lr + '眉';
    else if (along < eye + sp * 0.4) base = lr + 'アイライン';
    else base = lr + 'チーク';
    if (this.nameFree(base)) return base;
    const other = side > 0 ? 'その他（ドールの左）' : 'その他（ドールの右）';
    return Math.abs(side) < sp * 0.35 ? 'その他（中央）' : other;
  }
  addPart(poly, name) {
    const p = {
      id: seq++, name, visible: true, poly, feather: Math.max(3, Math.round(G.bbox(poly).h * 0.12)), strength: 0.5,
      origin: 'fade', t: { tx: 0, ty: 0, rot: 0, sl: 1, st: 1 }, pivot: null, copy: null, destAuto: false, _ex: null, _ox: null,
    };
    this.parts.push(p);
    this.sel = p.id;
    this.touch();
    return p;
  }
  removePart(p) {
    this.parts = this.parts.filter((x) => x !== p);
    if (this.sel === p.id) this.sel = this.parts[this.parts.length - 1]?.id ?? null;
    this.touch();
  }
  /** 変形を当てた選択範囲 */
  warp(poly) { return this.deformedTargets().length ? poly.map((q) => { const d = this.disp(q); return [q[0] + d[0], q[1] + d[1]]; }) : poly; }

  /** パーツのレイヤー（コピーしたパーツはコピー元の範囲から取り出す） */
  layerOf(p) {
    const key = `${this.deformVer}`;
    if (p._ex && p._exKey === key) return p._ex;
    const srcPoly = p.copy ? p.copy.poly : p.poly;
    const f = p.copy ? p.copy.feather : p.feather, s = p.copy ? p.copy.strength : p.strength;
    p._ex = IM.extract(this.deformed(), this.warp(srcPoly), f, s);
    p._exKey = key;
    return p._ex;
  }
  /** 元の位置（コピーしたパーツはコピー先の範囲）の処理に使う画像 */
  originOf(p) {
    if (!p.copy) return this.layerOf(p);
    const key = `${this.deformVer}`;
    if (p._ox && p._oxKey === key) return p._ox;
    p._ox = IM.extract(this.deformed(), this.warp(this.destPoly(p)), p.feather, p.strength);
    p._oxKey = key;
    return p._ox;
  }
  /** コピー先の範囲：自動で決めた場合は、コピー元（移動・回転等の後）の範囲を今の中心線で反転した位置 */
  destPoly(p) { if (!p.copy || !p.destAuto) return p.poly; const B = this.baseM(p); return p.copy.poly.map((q) => G.ap(B, q)); }

  /** パーツの基準の行列（コピーしたパーツは、コピー元の行列を中心線で反転したもの） */
  baseM(p) { return p.copy ? G.mul(this.refl, p.copy.m) : G.I(); }
  /** 支点と主軸（拡大縮小の長さ方向） */
  frame(p) {
    const B = this.baseM(p);
    const poly = this.warp(p.copy ? p.copy.poly : p.poly);
    const bb = G.bbox(poly);
    let a = G.principalAngle(poly);
    const v = G.apv(B, [Math.cos(a), Math.sin(a)]);
    a = Math.atan2(v[1], v[0]);
    const piv = p.pivot || G.ap(B, [bb.cx, bb.cy]);
    return { piv, a, bb, B };
  }
  /** パーツの行列：基準の行列のあとに、支点を中心とした移動・回転・拡大縮小（長さ方向／太さ方向）を当てる */
  matrix(p) {
    const { piv, a, B } = this.frame(p), t = p.t;
    return G.mul(G.T(piv[0] + t.tx, piv[1] + t.ty), G.R(t.rot), G.R(a), G.S(t.sl, t.st), G.R(-a), G.T(-piv[0], -piv[1]), B);
  }
  /** 支点を変える（見た目が変わらないように移動量を直す） */
  setPivot(p, q) {
    const { piv } = this.frame(p);
    const M = this.matrix(p);
    p.pivot = q;
    const M2 = this.matrix(p);
    // 新しい支点で同じ見た目になるよう、ずれた分を移動量に足す
    const a = G.ap(M, piv), b = G.ap(M2, piv);
    p.t.tx += a[0] - b[0]; p.t.ty += a[1] - b[1];
    this.touch();
  }
  /** 画面上の点 q（画像の座標）がパーツの上か */
  hit(p, q) {
    const ex = this.layerOf(p);
    const r = G.ap(G.inv(this.matrix(p)), q);
    const m = Math.max(6, 0.08 * Math.max(ex.w, ex.h));
    return r[0] >= ex.x - m && r[1] >= ex.y - m && r[0] <= ex.x + ex.w + m && r[1] <= ex.y + ex.h + m;
  }
  /** 左右コピー。返り値：作ったパーツ。コピー先と同じ名前のパーツがあれば replace の指定が必要 */
  copyPart(p, replace) {
    const name = pairName(p.name);
    if (!name) return null;
    const same = isOther(name) ? null : this.parts.find((x) => x.name === name);
    if (same && !replace) return { conflict: same };
    if (same) this.parts = this.parts.filter((x) => x !== same);
    const c = {
      id: seq++, name, visible: true, poly: [], feather: p.feather, strength: p.strength, origin: p.origin,
      t: { tx: 0, ty: 0, rot: 0, sl: 1, st: 1 }, pivot: null, destAuto: true, _ex: null, _ox: null,
      // コピー元の範囲と、その時点の行列を記録する（中心線を変えたときに反転位置を計算し直すため）
      copy: { srcId: p.id, poly: (p.copy ? p.copy.poly : p.poly).map((q) => q.slice()), feather: p.copy ? p.copy.feather : p.feather, strength: p.copy ? p.copy.strength : p.strength, m: this.matrix(p) },
    };
    c.poly = this.destPoly(c).map((q) => q.slice());
    this.parts.push(c);
    this.sel = c.id;
    this.touch();
    return c;
  }
  /** 中心線から見たパーツの側（+1 画面右側 / -1 画面左側 / 0 中央） */
  partSide(p) {
    const ex = this.layerOf(p);
    const c = G.ap(this.matrix(p), [ex.x + ex.w / 2, ex.y + ex.h / 2]);
    const s = G.sideOf(this.ax, c);
    return Math.abs(s) < this.cap.guides.spacing * this.cap.w * 0.3 ? 0 : Math.sign(s);
  }
  /** 形の変更の影響範囲と重なるパーツ */
  partsInDeform() {
    const ts = this.deformedTargets();
    if (!ts.length) return [];
    return this.parts.filter((p) => {
      const bb = G.bbox(p.copy ? p.copy.poly : p.poly);
      return ts.some((t) => bb.x < t.cx + t.R && bb.x + bb.w > t.cx - t.R && bb.y < t.cy + t.R && bb.y + bb.h > t.cy - t.R);
    });
  }

  // ---------------- 描画 ----------------
  /**
   * @param ctx 描画先、V 画像の座標 → 描画先の座標の行列
   * @param before true なら修正前（取り込み画像）だけを描く
   */
  render(ctx, V, before = false) {
    ctx.save();
    ctx.setTransform(...V);
    ctx.drawImage(before ? this.cap.canvas : this.deformed(), 0, 0);
    if (!before) {
      const vis = this.parts.filter((p) => p.visible);
      for (const p of vis) {
        if (p.origin === 'keep') continue;
        const o = this.originOf(p);
        ctx.drawImage(p.origin === 'erase' ? o.erase : o.fade, o.x, o.y);
      }
      ctx.globalCompositeOperation = 'multiply';
      for (const p of vis) {
        const ex = this.layerOf(p);
        ctx.setTransform(...G.mul(V, this.matrix(p)));
        ctx.drawImage(ex.layer, ex.x, ex.y);
      }
    }
    ctx.restore();
  }
  /** 修正後の画像（ミラーの「修正後」用。取り込み画像と同じ大きさ） */
  full() {
    if (this._full && this._fullVer === this.ver) return this._full;
    const c = IM.canvas(this.cap.w, this.cap.h);
    this.render(c.getContext('2d'), G.I());
    this._full = c; this._fullVer = this.ver;
    return c;
  }
}

function cloneMirror(m) {
  if (m.side) return { side: m.side };
  return { from: m.from, snap: { ...m.snap, g: { dx: m.snap.g.dx.slice(), dy: m.snap.g.dy.slice() } } };
}

/** 対象の影響範囲の初期位置：顔位置設定のガイド（目の高さの線・目頭マーク・フレームガイドの楕円）から決める */
function initTargets(cap) {
  const ax = G.axis(cap.w, cap.h, cap.angle), g = cap.guides;
  const eye = (g.eyeY - 0.5) * cap.h, sp = g.spacing * cap.w;
  const ry = (g.frame * cap.h) / 2, rx = ry * IM.FRAME_ASPECT;
  const eyeW = sp * 0.95;
  const mk = (id, along, side, R) => { const c = G.fromAxis(ax, along, side); return { id, cx: c[0], cy: c[1], R, own: IM.emptyGrid(), mirror: null, _eff: null }; };
  return [
    mk('eyeL', eye, sp / 2 + eyeW / 2, eyeW * 0.95),
    mk('eyeR', eye, -(sp / 2 + eyeW / 2), eyeW * 0.95),
    mk('cheekL', ry * 0.28, rx * 0.92, rx * 0.42),
    mk('cheekR', ry * 0.28, -rx * 0.92, rx * 0.42),
    mk('jaw', ry * 0.86, 0, rx * 0.55),
  ];
}
