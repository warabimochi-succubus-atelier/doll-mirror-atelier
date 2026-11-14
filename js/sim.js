// シミュレーション（パーツ移動）の内容と描画、取り消し（Undo / Redo）
// 仕様書「シミュレーション画面」「パーツ選択」「パーツ移動シミュレーション」を参照
//
// 重ね順：撮影画像 → 元のメイクの処理（薄くする・消す）→ パーツの仮置きレイヤー（乗算）
// パーツの選択範囲は撮影画像の座標で持つ。

import * as G from './geom.js';
import * as IM from './imaging.js';

const UNDO_MAX = 100;

// ---------------- パーツの名前 ----------------
// 名前は「側」と「番号」だけ（例：右1、左2、中央1）。側は囲んだ範囲の位置（中心線のどちら側か）から決める。
// 左右は「画面で見た左右」（正面から見た左右）：中心線より画面左側が左、画面右側が右
const SIDE_WORD = { L: '左', R: '右', C: '中央' };
const OPPOSITE = { L: 'R', R: 'L' };
const partNameOf = (side, no) => `${SIDE_WORD[side]}${no}`;
/** 左右コピーのコピー先の側（中央のパーツはコピーできないため null） */
export const copySide = (p) => OPPOSITE[p.side] || null;

let seq = 1;

export class Sim {
  /**
   * @param cap 撮影画像 { canvas, w, h, angle, guides: { frame }, time }
   */
  constructor(cap) {
    this.cap = cap;
    this.parts = [];
    this.sel = null;          // 編集中のパーツの id
    this.undoStack = [];
    this.redoStack = [];
    this.ver = 1;             // 内容が変わるたびに増やす（描画のキャッシュの判定に使う）
    this._full = null; this._fullVer = 0;
  }

  get ax() { return G.axis(this.cap.w, this.cap.h, this.cap.angle); }
  get refl() { return G.reflectM(this.ax); }
  /** 中心線からこの距離より近いものを中央とみなす（フレームガイドの楕円の横の半径の 1/10） */
  get centerHalf() { return ((this.cap.guides.frame * this.cap.h) / 2) * IM.FRAME_ASPECT * 0.1; }
  get hasContent() { return this.parts.length > 0; }
  part(id) { return this.parts.find((p) => p.id === id) || null; }
  get selPart() { return this.part(this.sel); }

  // ---------------- 取り消し（Undo / Redo） ----------------
  snapshot() {
    return {
      parts: this.parts.map((p) => ({ ...p, poly: p.poly.map((q) => q.slice()), t: { ...p.t }, pivot: p.pivot?.slice() || null, copy: p.copy ? structuredClone(p.copy) : null, _ex: undefined, _ox: undefined })),
      sel: this.sel,
    };
  }
  restore(s) {
    this.parts = s.parts.map((p) => ({ ...p }));
    this.sel = this.part(s.sel) ? s.sel : (this.parts[this.parts.length - 1]?.id ?? null);
    this.touch();
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
  /** 中心線の角度を変えたとき（撮影画像に適用する場合）：コピー先の範囲（中心線で反転した位置）を取り出し直す */
  setAngle(deg) { this.cap.angle = deg; this.parts.forEach((p) => { p._ox = null; }); this.touch(); }

  // ---------------- パーツ ----------------
  /** 囲んだ範囲の側：'L'（画面左側）/ 'R'（画面右側）/ 'C'（中心線にかかる中央） */
  sideOfPoly(poly) {
    const s = G.sideOf(this.ax, G.centroid(poly));
    return Math.abs(s) < this.centerHalf * 1.15 ? 'C' : s > 0 ? 'R' : 'L';
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
  /** パーツのレイヤー（コピーしたパーツはコピー元の範囲から取り出す） */
  layerOf(p) {
    if (p._ex) return p._ex;
    const srcPoly = p.copy ? p.copy.poly : p.poly;
    const f = p.copy ? p.copy.feather : p.feather, s = p.copy ? p.copy.strength : p.strength;
    p._ex = IM.extract(this.cap.canvas, srcPoly, f, s);
    return p._ex;
  }
  /** 元のメイク（コピーしたパーツはコピー先のメイク）の処理に使う画像 */
  originOf(p) {
    if (!p.copy) return this.layerOf(p);
    if (p._ox) return p._ox;
    p._ox = IM.extract(this.cap.canvas, this.destPoly(p), p.feather, p.strength);
    return p._ox;
  }
  /** コピー先の範囲：自動で決めた場合は、コピー元（移動・回転等の後）の範囲を今の中心線で反転した位置 */
  destPoly(p) { if (!p.copy || !p.destAuto) return p.poly; const B = this.baseM(p); return p.copy.poly.map((q) => G.ap(B, q)); }

  /** パーツの基準の行列（コピーしたパーツは、コピー元の行列を中心線で反転したもの） */
  baseM(p) { return p.copy ? G.mul(this.refl, p.copy.m) : G.I(); }
  /** 支点と主軸（拡大縮小の長さ方向） */
  frame(p) {
    const B = this.baseM(p);
    const poly = p.copy ? p.copy.poly : p.poly;
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
    return Math.abs(s) < this.centerHalf ? 0 : Math.sign(s);
  }
  // ---------------- 描画 ----------------
  /**
   * @param ctx 描画先、V 画像の座標 → 描画先の座標の行列
   * @param before true なら修正前（撮影画像）だけを描く
   */
  render(ctx, V, before = false) {
    ctx.save();
    ctx.setTransform(...V);
    ctx.drawImage(this.cap.canvas, 0, 0);
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
  /** 修正後の画像（ミラーの「修正後」用。撮影画像と同じ大きさ） */
  full() {
    if (this._full && this._fullVer === this.ver) return this._full;
    const c = IM.canvas(this.cap.w, this.cap.h);
    this.render(c.getContext('2d'), G.I());
    this._full = c; this._fullVer = this.ver;
    return c;
  }
}
