// 座標計算（js/geom.js）と仮置き（js/sim.js）のテスト。画面を開かずに確かめられる部分だけを扱う
// 使い方: node --test tools/test.mjs   （Node.js 18 以降。外部のライブラリは使わない）

import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../js/geom.js';
import { Sim, copySide } from '../js/sim.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} と ${b} が近くない`);
const nearP = (p, q, eps = 1e-9) => { near(p[0], q[0], eps); near(p[1], q[1], eps); };

// ---------------- geom.js ----------------

test('行列：逆行列をかけると元に戻る', () => {
  const m = G.mul(G.T(12, -5), G.R(0.7), G.S(2, 0.5));
  nearP(G.ap(G.mul(G.inv(m), m), [3, 4]), [3, 4]);
});

test('中心線の反転：2回で元に戻り、線の上の点は動かない', () => {
  for (const deg of [0, 3.5, -10]) {
    const ax = G.axis(400, 600, deg), M = G.reflectM(ax);
    nearP(G.ap(M, G.ap(M, [37, 210])), [37, 210]);
    const onLine = G.fromAxis(ax, 120, 0);
    nearP(G.ap(M, onLine), onLine);
    // 反転すると、中心線からの距離は同じで側が入れ替わる
    const p = G.fromAxis(ax, -40, 55);
    near(G.sideOf(ax, G.ap(M, p)), -55);
    near(G.alongOf(ax, G.ap(M, p)), -40);
  }
});

test('中心線の側：画面右側が正', () => {
  const ax = G.axis(100, 100, 0);
  assert.ok(G.sideOf(ax, [80, 50]) > 0);
  assert.ok(G.sideOf(ax, [20, 50]) < 0);
});

test('多角形：面積・内外の判定・間引き', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  near(G.area(sq), 100);
  assert.equal(G.pointInPoly([5, 5], sq), true);
  assert.equal(G.pointInPoly([15, 5], sq), false);
  assert.equal(G.simplify([[0, 0], [0.5, 0], [1, 0], [3, 0]], 1).length, 3);
});

test('coverRect / containRect：中央に置く', () => {
  const c = G.coverRect(100, 50, 200, 200);
  near(c.s, 4); near(c.x, -100); near(c.y, 0);
  const n = G.containRect(100, 50, 200, 200);
  near(n.s, 2); near(n.x, 0); near(n.y, 50);
});

// ---------------- sim.js ----------------

// 撮影画像の代わり（画素を読む処理〔layerOf 等〕は使わない）
const cap = () => ({ canvas: null, w: 1000, h: 1000, angle: 0, guides: { frame: 0.6 }, time: new Date() });
const box = (cx, cy, r = 30) => [[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]];

test('パーツの名前：囲んだ側と、その側で空いている番号', () => {
  const sim = new Sim(cap());
  assert.equal(sim.addPart(box(300, 400)).name, '左1');
  assert.equal(sim.addPart(box(700, 400)).name, '右1');
  assert.equal(sim.addPart(box(500, 600)).name, '中央1');
  const l2 = sim.addPart(box(250, 600));
  assert.equal(l2.name, '左2');
  sim.removePart(sim.parts[0]); // 左1 を消すと、次の左は 1 を使う
  assert.equal(sim.addPart(box(200, 300)).name, '左1');
});

test('境界のぼかし：上限は撮影画像の大きさに合わせ、初めの値は上限を超えない', () => {
  const small = new Sim(cap());
  assert.equal(small.featherMax, 40);
  const big = new Sim({ ...cap(), w: 2160, h: 3840 });
  assert.equal(big.featherMax, 115);
  const cheek = big.addPart(box(500, 2300, 400)); // 高さ 800px：12% は 96
  assert.equal(cheek.feather, 96);
  const huge = big.addPart(box(1500, 2000, 800)); // 高さ 1600px：12% は 192 → 上限 115
  assert.equal(huge.feather, 115);
});

test('左右コピー：反対側の位置に作られ、中央はコピーできない', () => {
  const sim = new Sim(cap());
  const p = sim.addPart(box(300, 400));
  const c = sim.copyPart(p);
  assert.equal(c.name, '右1');
  assert.equal(copySide(c), 'L');
  nearP(G.centroid(c.poly), [700, 400], 1e-6);
  const mid = sim.addPart(box(500, 500));
  assert.equal(sim.copyPart(mid), null);
});

test('支点を変えても見た目（行列）は変わらない', () => {
  const sim = new Sim(cap());
  const p = sim.addPart(box(300, 400));
  p.t = { tx: 12, ty: -7, rot: 0.3, sl: 1.4, st: 0.8 };
  const before = sim.matrix(p);
  sim.setPivot(p, [250, 420]);
  const after = sim.matrix(p);
  for (const q of [[0, 0], [300, 400], [900, 100]]) nearP(G.ap(after, q), G.ap(before, q), 1e-6);
});

test('取り消し・やり直し', () => {
  const sim = new Sim(cap());
  sim.begin(); const p = sim.addPart(box(300, 400));
  sim.begin(); p.t.tx = 50;
  assert.equal(sim.undo(), true);
  assert.equal(sim.selPart.t.tx, 0);
  assert.equal(sim.undo(), true);
  assert.equal(sim.parts.length, 0);
  assert.equal(sim.undo(), false);
  assert.equal(sim.redo(), true);
  assert.equal(sim.redo(), true);
  assert.equal(sim.selPart.t.tx, 50);
  assert.equal(sim.redo(), false);
});
