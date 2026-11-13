// シミュレーション（パーツ移動・形の変更）の内容と描画、取り消し（Undo / Redo）
// 仕様書「シミュレーション画面」「パーツ選択」「パーツ移動シミュレーション」「形の変更」を参照
//
// 重ね順：取り込み画像 → 形の変更（輪郭の変形）→ 元の位置の処理（薄くする・消す）→ パーツの仮置きレイヤー（乗算）
// パーツの選択範囲は取り込み画像の座標で持ち、形の変更がある場合は変形を当てた位置で扱う。

import * as G from './geom.js';
import * as IM from './imaging.js';
import * as SH from './shape.js';
import { Warper, Tps, fadeAt } from './warp.js';

const UNDO_MAX = 100;

// ---------------- パーツの名前 ----------------
// 名前は「側」と「番号」だけ（例：右1、左2、中央1）。側は囲んだ範囲の位置（中心線のどちら側か）から決める。
// 左右は「ドール本人から見た左右」：中心線より画面右側が左、画面左側が右
const SIDE_WORD = { L: '左', R: '右', C: '中央' };
const OPPOSITE = { L: 'R', R: 'L' };
const partNameOf = (side, no) => `${SIDE_WORD[side]}${no}`;
/** 画面上の位置を添えた名前（例：左1（画面右側）） */
export function partLabel(n) {
  if (n.startsWith('左')) return `${n}（画面右側）`;
  if (n.startsWith('右')) return `${n}（画面左側）`;
  return n;
}
/** 左右コピーのコピー先の側（中央のパーツはコピーできないため null） */
export const copySide = (p) => OPPOSITE[p.side] || null;

let seq = 1;

export class Sim {
  /**
   * @param cap 取り込み画像 { canvas, w, h, angle, guides: { eyeY, spacing, frame }, time }
   */
  constructor(cap) {
    this.cap = cap;
    this.parts = [];
    this.sel = null;          // 編集中のパーツの id
    this.shape = SH.initShape(cap); // 形の変更（取っ手・スライダーの値）
    this.undoStack = [];
    this.redoStack = [];
    this.ver = 1;             // 内容が変わるたびに増やす（描画のキャッシュの判定に使う）
    this.deformVer = 1;       // 形の変更が変わるたびに増やす
    this.partsVer = 1;        // パーツの抽出をやり直した時点の deformVer（ドラッグ中は進めない）
    this.warper = new Warper();
    this._ctl = null; this._ctlVer = 0;
    this._view = null; this._viewVer = 0;
    this._deformed = null; this._deformedVer = 0;
    this._full = null; this._fullVer = 0;
  }

  get ax() { return G.axis(this.cap.w, this.cap.h, this.cap.angle); }
  get refl() { return G.reflectM(this.ax); }
  get hasContent() { return this.parts.length > 0 || SH.changed(this.shape, this.ax); }
  part(id) { return this.parts.find((p) => p.id === id) || null; }
  get selPart() { return this.part(this.sel); }

  // ---------------- 取り消し（Undo / Redo） ----------------
  snapshot() {
    return {
      parts: this.parts.map((p) => ({ ...p, poly: p.poly.map((q) => q.slice()), t: { ...p.t }, pivot: p.pivot?.slice() || null, copy: p.copy ? structuredClone(p.copy) : null, _ex: undefined, _ox: undefined })),
      shape: SH.cloneShape(this.shape),
      sel: this.sel,
    };
  }
  restore(s) {
    this.parts = s.parts.map((p) => ({ ...p }));
    this.shape = SH.cloneShape(s.shape);
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
  /**
   * 形の変更が変わったとき。live（ドラッグ・スライダーの操作中）は画像の変形だけを描き直し、
   * パーツの抽出は指を離したとき（settle）にやり直す（抽出は重いため）
   */
  touchDeform(live = false) {
    this.deformVer++; this.ver++;
    if (!live) this.settle();
  }
  /** パーツの抽出を、今の形の変更に合わせてやり直す */
  settle() {
    if (this.partsVer === this.deformVer) return;
    this.partsVer = this.deformVer;
    this.parts.forEach((p) => { p._ex = null; p._ox = null; });
    this.ver++;
  }
  /** 中心線の角度を変えたとき（取り込み画像に適用する場合）：中心線を基準にした計算をやり直す */
  setAngle(deg) { this.cap.angle = deg; this.touchDeform(); }

  // ---------------- 形の変更 ----------------
  /**
   * 変形の制御点と TPS（形の変更が変わったときだけ作り直す）。
   * 制御点の並び（元の位置）が前と同じなら TPS の準備を使い回し、動かした量だけ解き直す
   */
  controls() {
    if (this._ctl && this._ctlVer === this.deformVer) return this._ctl;
    const c = SH.controls(this.shape, this.ax);
    if (!c.identity) {
      const t = this._tps;
      const same = t && t.P.length === c.P.length && t.P.every((v, i) => v === c.P[i]);
      try {
        this._tps = same ? t : new Tps(c.P);
        c.tps = this._tps.solve(c.Q);
      } catch { c.identity = true; this._tps = null; } // 制御点が重なって解けない場合は変形しない
    }
    this._ctl = c; this._ctlVer = this.deformVer;
    return c;
  }
  /** 点 p の変形による移動量 */
  disp(p) {
    const c = this.controls();
    if (c.identity) return [0, 0];
    const f = fadeAt(c.box, p[0], p[1]);
    if (!f) return [0, 0];
    const d = c.tps.dispInto(p[0], p[1], [0, 0]);
    return [d[0] * f, d[1] * f];
  }
  /** 表示用の変形した画像（WebGL の canvas。取り込み画像の上に重ねて描く。変形がなければ null） */
  deformedView() {
    const c = this.controls();
    if (c.identity) return null;
    if (this._view && this._viewVer === this.deformVer) return this._view;
    this._view = this.warper.render(this.cap.canvas, c.tps, c.box); this._viewVer = this.deformVer;
    return this._view;
  }
  /** 形の変更を当てた画像（2D の canvas。パーツの抽出に使う） */
  deformed() {
    const view = this.deformedView();
    if (!view) return this.cap.canvas;
    if (this._deformed && this._deformedVer === this.deformVer) return this._deformed;
    if (!this._deformed) this._deformed = IM.canvas(this.cap.w, this.cap.h);
    const x = this._deformed.getContext('2d', { willReadFrequently: true });
    x.drawImage(this.cap.canvas, 0, 0); x.drawImage(view, 0, 0);
    this._deformedVer = this.deformVer;
    return this._deformed;
  }
  /** 形の変更の対象ごとに変形があるもの（ミラーの「基準でない側の修正」・再開時の案内に使う） */
  changedGroups() { return SH.GROUPS.filter((g) => SH.changed(this.shape, this.ax, g.id)).map((g) => g.id); }
  changedSides() { return SH.changedSides(this.shape, this.ax); }

  // ---------------- パーツ ----------------
  /** 囲んだ範囲の側：'L'（ドールの左＝画面右側）/ 'R'（ドールの右＝画面左側）/ 'C'（中心線にかかる中央） */
  sideOfPoly(poly) {
    const s = G.sideOf(this.ax, G.centroid(poly));
    return Math.abs(s) < this.cap.guides.spacing * this.cap.w * 0.35 ? 'C' : s > 0 ? 'L' : 'R';
  }
  /** その側で使われていない最も小さい番号 */
  freeNo(side, exceptId) {
    const used = new Set(this.parts.filter((p) => p.side === side && p.id !== exceptId).map((p) => p.no));
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }
  /** パーツの側を設定し、名前（側＋番号）を付け直す。側が変わらなければ名前はそのまま */
  setSide(p, side) {
    if (p.side === side && p.name) return;
    p.side = side; p.no = this.freeNo(side, p.id); p.name = partNameOf(side, p.no);
  }
  addPart(poly) {
    const p = {
      id: seq++, name: '', side: null, no: 0, visible: true, poly, feather: Math.max(3, Math.round(G.bbox(poly).h * 0.12)), strength: 0.5,
      origin: 'fade', t: { tx: 0, ty: 0, rot: 0, sl: 1, st: 1 }, pivot: null, copy: null, destAuto: false, _ex: null, _ox: null,
    };
    this.setSide(p, this.sideOfPoly(poly));
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
  warp(poly) { return this.controls().identity ? poly : poly.map((q) => { const d = this.disp(q); return [q[0] + d[0], q[1] + d[1]]; }); }

  /** パーツのレイヤー（コピーしたパーツはコピー元の範囲から取り出す）。形の変更の操作中は、操作前の抽出のまま使う */
  layerOf(p) {
    const key = `${this.partsVer}`;
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
    const key = `${this.partsVer}`;
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
  /** 左右コピー。反対側の新しいパーツ（その側の空いている番号）を作って返す。中央のパーツは null */
  copyPart(p) {
    const side = copySide(p);
    if (!side) return null;
    const no = this.freeNo(side);
    const c = {
      id: seq++, name: partNameOf(side, no), side, no, visible: true, poly: [], feather: p.feather, strength: p.strength, origin: p.origin,
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
  /** 形の変更に合わせて動いたパーツ（選択範囲のどこかが 0.5px 以上動いたもの） */
  partsInDeform() {
    if (this.controls().identity) return [];
    return this.parts.filter((p) => (p.copy ? p.copy.poly : p.poly).some((q) => Math.hypot(...this.disp(q)) >= 0.5));
  }

  // ---------------- 描画 ----------------
  /**
   * @param ctx 描画先、V 画像の座標 → 描画先の座標の行列
   * @param before true なら修正前（取り込み画像）だけを描く
   */
  render(ctx, V, before = false) {
    ctx.save();
    ctx.setTransform(...V);
    ctx.drawImage(this.cap.canvas, 0, 0);
    if (!before) {
      // 変形した画像を重ねる（WebGL で描いた画像をそのまま使い、2D の画像への写しは作らない。ドラッグ中も速く描けるように）
      const view = this.deformedView();
      if (view) ctx.drawImage(view, 0, 0);
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
