// Doll Mirror Atelier：画面の切り替えと操作
// 画面：カメラ（ホーム）・顔位置設定・ミラー・仮置き（パーツ移動）・設定・設置ガイド
// 仕様書「画面構成と操作の流れ」を参照

import * as G from './geom.js';
import * as IM from './imaging.js';
import { cam } from './camera.js';
import { settings, save } from './settings.js';
import { Sim, copySide } from './sim.js';
import { $, $$, esc, toast, choose } from './ui.js';
/* global APP_VERSION */

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const TITLES = { face: '顔位置設定', mirror: 'ミラー', sim: '仮置き', setup: '設置ガイド', settings: '設定' };
const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

// 作業内容（アプリを開いている間だけ保持する。端末には保存しない）
const S = {
  screen: 'home',
  mirrorCap: null,   // ミラーの撮影画像 { canvas, w, h, angle, guides, time }
  sim: null,         // 仮置き
  lastCap: null,     // 前回の撮影画像（輪郭表示用。ミラー・仮置きのどちらかと共用）
  headMoved: false,  // ヘッドが動いた可能性がある（ミラーで、顔位置設定で元の位置に戻すよう案内する）
  startupNote: true, // 起動時の「ヘッドを中心線に合わせて撮影してください」
  resumeNote: false, // アプリに戻ったときの、元の位置を確かめる案内（ホーム）
  simTab: 'move',    // 仮置きのパネルのタブ（'move'：動かす、'size'：大きさ、'makeup'：メイク）
  flip: false,       // ホームのライブ映像の左右反転（表示だけ。ボタンを押している間だけ。左右の取り違えを防ぐため）
  // which：表示する画像。ライブから始める（開くたびに撮影して待たせない。止めて見たいときに撮影する）
  mirror: { basis: 'left', which: 'live', view: { s: 1, x: 0, y: 0 } }, // view：表示の拡大・移動（画面の座標）
  face: { angle0: 0, view: { s: 1, x: 0, y: 0 } }, // view：顔位置設定の表示の拡大・移動（画面の座標）
  capturing: 0,      // 撮影（待ち時間）中の番号。画面を離れたら取りやめる
  // 仮置き画面
  view: null, before: false, mode: null, dirty: true,
  checks: { light: 0, sharp: null, t: 0 },
};
const edgeCache = new WeakMap();
const tintCache = {};
const edgesOf = (cv) => { let m = edgeCache.get(cv); if (!m) { m = IM.edgeMask(cv); edgeCache.set(cv, m); } return m; };
// 輪郭の線の色は、撮影画像ごとにヘッドの色から自動で決める（ホームの輪郭表示とミラーの「輪郭のみ」で共通）
const lineColorCache = new WeakMap();
const lineColorOf = (cv) => {
  let c = lineColorCache.get(cv);
  if (!c) { c = IM.lineColorFor(cv, frameRect(cv.width, cv.height)); lineColorCache.set(cv, c); }
  return c;
};

const cv = $('#cv'), ctx = cv.getContext('2d');
cam.init($('#video'));

// ======================================================================
// 画面の切り替え
// ======================================================================
const stack = [];
let popSilently = false;

function show(s) {
  const prev = S.screen;
  S.screen = s;
  document.body.dataset.screen = s;
  $$('[data-show]').forEach((el) => {
    el.hidden = !el.dataset.show.split(' ').includes(s);
  });
  $('#bar-title').textContent = TITLES[s] || '';
  if (prev !== s) S.capturing++; // 待ち時間中に画面を移ったら撮影をやめる
  // 顔位置設定を離れるとき（「‹」・戻る・設置ガイドへ移る等、どの方法でも）は、変えた角度を撮影画像に適用する
  if (prev === 'face' && s !== 'face') applyFaceAngle();
  S.dirty = true;
  S.mode = null;
  if (s === 'face') { S.face.angle0 = settings.angle; S.startupNote = false; S.resumeNote = false; updateFace(); }
  zoomOpen = false;
  if (s === 'mirror') updateMirror();
  if (s === 'sim') { S.dirty = true; updateSimPanel(); }
  if (s === 'home') updateHome();
  if (s === 'settings') updateSettings();
  updateBanner();
  updateZoomButtons();
  $('#count').hidden = true;
}
/**
 * 画面を移る。移る先が戻るの履歴に既にある場合（ミラー ⇄ 仮置きの行き来など）は、新しく積まずに、
 * その画面まで履歴を巻き戻す（何度行き来しても、戻るでホームまで少ない回数で戻れるように）
 */
function go(s) {
  if (s === S.screen) return;
  const i = stack.lastIndexOf(s);
  if (i >= 0) {
    const k = stack.length - i; // 巻き戻すブラウザの履歴の数（今の画面の分を含む）
    stack.length = i;
    popSilently = true; history.go(-k);
    show(s);
    return;
  }
  stack.push(S.screen);
  history.pushState({ s }, '');
  show(s);
}
function back(fromPop = false) {
  if (S.screen === 'home') return;
  const prev = stack.pop() || 'home';
  if (!fromPop) { popSilently = true; history.back(); }
  show(prev);
}
window.addEventListener('popstate', () => {
  if (popSilently) { popSilently = false; return; }
  back(true);
});
$('#btn-back').addEventListener('click', () => back());
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]');
  if (g) go(g.dataset.go);
});

// ======================================================================
// カメラ
// ======================================================================
cam.onState = () => { updateCamMsg(); updateZoomButtons(); };
cam.zoom = settings.zoom;
cam.fps = settings.fps;

function updateCamMsg() {
  const m = $('#cam-msg');
  const st = cam.state;
  if (st === 'live') { m.hidden = true; return; }
  m.hidden = false;
  if (st === 'intro') {
    m.innerHTML = `<div class="box"><h2>カメラを使います</h2>
      <p>このアプリは、スタンドに固定したドールヘッドを背面カメラで映し続けて使います。カメラの映像・撮影した画像は端末の外に送らず、保存もしません。</p>
      <p>次にブラウザから「カメラの使用を許可しますか」と尋ねられたら、<b>許可</b>を選んでください。ホーム画面から起動した場合、起動のたびに尋ねられることがあります。</p>
      <button class="btn btn-primary" id="cam-go">カメラを起動</button></div>`;
    $('#cam-go').onclick = () => { settings.camIntroDone = true; save(); startCamera(); };
  } else if (st === 'denied') {
    m.innerHTML = `<div class="box"><h2>カメラが許可されていません</h2>
      <p>このアプリはカメラの映像を使うため、カメラの利用が必要です。</p>
      <p>iPhone：設定アプリ →「Safari」→「カメラ」を「許可」または「確認」にします（ホーム画面から起動した場合も同じです）。<br>Android：アドレスバーの左のアイコン →「権限」→「カメラ」を許可します。</p>
      <button class="btn btn-primary" id="cam-go">もう一度試す</button></div>`;
    $('#cam-go').onclick = () => startCamera();
  } else if (st === 'starting') {
    m.innerHTML = '<div class="box"><p>カメラを起動しています…</p></div>';
  } else if (st === 'idle') {
    m.innerHTML = '<div class="box"><p>カメラは停止しています</p><button class="btn btn-primary" id="cam-go">カメラを起動</button></div>';
    $('#cam-go').onclick = () => startCamera();
  } else {
    m.innerHTML = `<div class="box"><h2>カメラを使えません</h2><p>${esc(cam.error || 'カメラを起動できませんでした')}</p>
      <p>このアプリは https で開く必要があります。ほかのアプリがカメラを使っている場合は閉じてください。</p>
      <button class="btn btn-primary" id="cam-go">もう一度試す</button></div>`;
    $('#cam-go').onclick = () => startCamera();
  }
}
async function startCamera() {
  await cam.start();
  if (cam.state === 'live' && !settings.firstRunDone) {
    // 初回起動時は顔位置設定を表示する
    settings.firstRunDone = true; save();
    go('face');
  }
}
// アプリがバックグラウンドに移るとカメラを止め、前面に戻ったら再開する
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    cam.stop();
  } else if (settings.camIntroDone) {
    // 撮影画像がある場合、離れている間にヘッドが動いたかもしれない：ミラーとホームで、元の位置を確かめるよう案内する
    if (S.mirrorCap || S.sim) { S.headMoved = true; S.resumeNote = true; }
    startCamera().then(updateBanner);
  }
});

// ---------------- ズーム ----------------
function zoomChoices() {
  const r = cam.zoomRange();
  const list = [1, 1.5, 2, 3, 4, 5, 8].filter((z) => z >= r.min - 0.01 && z <= r.max + 0.01);
  if (!list.length) list.push(r.min);
  return list;
}
/**
 * 倍率の表示（映像・画像の右）。どの画面でも、今の倍率を小さく1つだけ表示し、タップすると倍率の候補を開く
 * （細かい調整はピンチ。映像を隠す部分を小さくするため、候補は開いたときだけ表示する）
 * - ホーム：カメラのズーム倍率（撮影する範囲が変わる）
 * - 顔位置設定・ミラー：表示の拡大（1× が映像の全体）
 * - 仮置き：表示の拡大（1× が画像の全体）
 */
let zoomOpen = false, zoomHtml = '';
const VIEW_ZOOMS = [1, 1.5, 2, 3, 4];
/** 今の画面の倍率と候補（倍率の表示が無い画面・状態では null） */
function zoomState() {
  if (S.screen === 'home') return cam.ready ? { v: cam.zoom, list: zoomChoices(), label: 'ズーム倍率' } : null;
  if (S.screen === 'face' || S.screen === 'mirror') return cam.ready ? { v: liveView().s, list: VIEW_ZOOMS, label: '表示の倍率' } : null;
  if (S.screen === 'sim') return S.sim && S.view ? { v: S.view.s / simFitScale(), list: VIEW_ZOOMS, label: '表示の倍率' } : null;
  return null;
}
function updateZoomButtons() {
  const z = $('#zoom'), st = zoomState();
  if (!st) zoomOpen = false;
  const html = !st ? '' : `<button class="zoom-cur mono" aria-expanded="${zoomOpen}" aria-label="${st.label} ${st.v.toFixed(1)}倍（タップで候補を表示）">${st.v.toFixed(1)}×</button>`
    + (zoomOpen ? `<div class="zoom-list">${st.list.map((v) => `<button data-z="${v}" class="${Math.abs(v - st.v) < 0.01 ? 'on' : ''}">${v}×</button>`).join('')}</div>` : '');
  // 毎コマ呼ぶため、変わったときだけ書き換える（押している途中のボタンを作り直さないように）
  if (html !== zoomHtml) { z.innerHTML = html; zoomHtml = html; }
}
/** 候補から選んだ倍率にする */
function chooseZoom(v) {
  const c = [cv.width / 2, cv.height / 2];
  if (S.screen === 'home') setZoom(v);
  else if (liveView()) {
    const lv = liveView();
    if (v === 1) Object.assign(lv, { s: 1, x: 0, y: 0 }); else zoomLive(v / lv.s, c);
  } else if (S.screen === 'sim' && S.sim) {
    if (v === 1) fitView(); else zoomView((v * simFitScale()) / S.view.s, c);
  }
}
async function setZoom(v) {
  if (Math.abs(v - cam.zoom) < 0.01) return;
  await cam.setZoom(v);
  finishZoom();
}
/**
 * ズーム倍率を変え終えたとき：設定に保存する。
 * 撮影画像と倍率が違うことは、ミラーの映像の上の表示で知らせる（倍率を変えるたびにトーストを出すと煩わしいため）
 */
function finishZoom() {
  settings.zoom = cam.zoom; save();
  updateZoomButtons(); renderChips();
}
/**
 * ホームのピンチ・マウスホイールによるズーム（操作中）。倍率は 0.1 刻み。
 * カメラのズーム制御は呼び出しに時間がかかるため、前の呼び出しが終わるまでは最後の値だけを残して待たせる
 */
const camZoom = { busy: false, next: null, active: false, timer: 0, wheel: null };
function pinchZoom(z) {
  const r = cam.zoomRange();
  z = Math.round(G.clamp(z, r.min, r.max) * 10) / 10;
  camZoom.active = true;
  camZoom.next = z;
  if (camZoom.busy) return;
  (async () => {
    camZoom.busy = true;
    while (camZoom.next != null) {
      const v = camZoom.next; camZoom.next = null;
      if (Math.abs(v - cam.zoom) >= 0.01) await cam.setZoom(v);
      updateZoomButtons(); renderChips();
    }
    camZoom.busy = false;
  })();
}
/** ピンチ・マウスホイールのズームを終える */
function endPinchZoom() {
  if (!camZoom.active) return;
  camZoom.active = false; camZoom.wheel = null;
  const done = () => (camZoom.busy ? setTimeout(done, 50) : finishZoom());
  done();
}
$('#zoom').addEventListener('click', (e) => {
  const b = e.target.closest('[data-z]');
  if (b) { zoomOpen = false; chooseZoom(+b.dataset.z); updateZoomButtons(); return; }
  if (e.target.closest('.zoom-cur')) { zoomOpen = !zoomOpen; updateZoomButtons(); }
});
// 候補を開いたまま他の所を触ったら閉じる
document.addEventListener('pointerdown', (e) => { if (zoomOpen && !e.target.closest('#zoom')) { zoomOpen = false; updateZoomButtons(); } });

/**
 * 押している間だけ効くボタン（仮置きの「修正前」、ホームの左右反転）。
 * set(true) を押したとき、set(false) を離したとき・指がボタンから外れたときに呼ぶ
 */
function holdButton(el, set) {
  let on = false;
  const down = (e) => { e.preventDefault(); on = true; el.classList.add('pressing'); set(true); S.dirty = true; };
  const up = () => { if (!on) return; on = false; el.classList.remove('pressing'); set(false); S.dirty = true; };
  el.addEventListener('pointerdown', down);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => el.addEventListener(t, up));
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------- 撮影 ----------------
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function countdown(sec) {
  const token = ++S.capturing;
  const box = $('#count'), num = $('#count-num');
  for (let i = sec; i > 0; i--) {
    box.hidden = false; num.textContent = i;
    await wait(1000);
    if (token !== S.capturing) { box.hidden = true; return false; }
  }
  box.hidden = true;
  return token === S.capturing;
}
// 待ち時間の間に映像をタップしたら、撮影を取りやめる（画面に触れると端末が揺れるため、そのまま撮らない）。
// 映像の操作（ピンチ等）には渡さない。自分でタップして取りやめたため、トーストは出さない（枠が消えて分かる）
$('#count').addEventListener('pointerdown', (e) => {
  e.stopPropagation(); e.preventDefault();
  S.capturing++; $('#count').hidden = true;
});
/** 映像を撮影する（待ち時間の後。ピンぼけ・ブレのチェックは補助の表示の ON / OFF に関わらず行う） */
async function capture() {
  for (;;) {
    if (!cam.ready) { toast('カメラの映像がありません'); return null; }
    if (!(await countdown(settings.delay))) return null;
    const canvas = cam.grab();
    const val = IM.sharpness(canvas, frameRect(canvas.width, canvas.height));
    if (val < IM.SHARP_MIN) {
      const r = await choose({
        title: '画像がぼやけています',
        html: '<p>ピンぼけ、またはブレの可能性があります。端末とヘッドが動いていないこと、ピントが合っていることを確かめてから撮り直してください。</p>',
        choices: [{ value: 'retry', label: '撮り直す' }, { value: 'use', label: 'このまま使う' }],
      });
      if (r === 'retry') continue;
      if (r !== 'use') return null;
    }
    const cap = {
      canvas, w: canvas.width, h: canvas.height, angle: settings.angle, zoom: cam.zoom, time: new Date(),
      guides: { frame: settings.frame },
    };
    S.lastCap = cap;
    return cap;
  }
}
/** フレームガイドの楕円を囲む矩形（鮮明さの判定範囲） */
function frameRect(w, h) {
  const ry = (settings.frame * h) / 2, rx = ry * IM.FRAME_ASPECT;
  return { x: Math.max(0, w / 2 - rx), y: Math.max(0, h / 2 - ry), w: Math.min(w, 2 * rx), h: Math.min(h, 2 * ry) };
}

// ======================================================================
// 描画
// ======================================================================
function fitCanvas() {
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * DPR())), h = Math.max(1, Math.round(r.height * DPR()));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; S.dirty = true; if (S.view?.auto) fitView(); }
}
/**
 * 描画のループ。端末が熱くならないよう、描き直すのは必要なときだけにする。
 * カメラの画面では、新しいコマが届いたときと、操作（S.dirty）があったときだけ。仮置きでは操作があったときだけ
 */
let lastFrame = null;
function loop() {
  requestAnimationFrame(loop);
  if ($('#stage').hidden) return;
  fitCanvas();
  updateZoomButtons();
  if (S.screen === 'sim') { if (S.dirty && S.sim) { S.dirty = false; drawSim(); } return; }
  const f = cam.ready ? cam.frameKey() : null;
  if (f === lastFrame && !S.dirty) return;
  lastFrame = f; S.dirty = false;
  drawLive();
}
// 操作があったら描き直す（ピンチ・ボタン・スライダー等で表示が変わるため。新しいコマを待つと、コマ数が少ないときに遅れて見える）
['pointerdown', 'pointermove', 'pointerup', 'wheel', 'click', 'input', 'change', 'keydown'].forEach((t) => document.addEventListener(t, () => { S.dirty = true; }, { capture: true, passive: true }));

/** 線を引く（画面の座標） */
function line(a, b, color, w = 1.5, dash = null) {
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  ctx.strokeStyle = color; ctx.lineWidth = w * DPR(); ctx.setLineDash(dash ? dash.map((d) => d * DPR()) : []); ctx.stroke(); ctx.setLineDash([]);
}

/**
 * 中心線と、目盛り付きの横線（中心線に直角）。M：映像の座標 → 画面の座標。full でなければ中心線だけ
 * 横線と目盛りの間隔はフレームガイドの楕円の大きさから決める（目盛りの間隔は楕円の横の半径の 1/10）。
 * 横線は等間隔に何本も引き、目の高さに合わせて動かさなくても、近くの線で左右の高さと中心線からの距離を比べられるようにする
 */
function drawGuides(M, fw, fh, angle, full = true) {
  const ax = G.axis(fw, fh, angle);
  const P = (a, s) => G.ap(M, G.fromAxis(ax, a, s));
  const L = Math.max(fw, fh);
  line(P(-L, 0), P(L, 0), 'rgba(143,211,255,.95)', 1.5, [8, 6]);
  if (!full) return;
  const ry = (settings.frame * fh) / 2, rx = ry * IM.FRAME_ASPECT;
  const step = rx / GRID_TICKS, half = rx * 1.2, rows = Math.floor(ry * 1.1 / (step * GRID_ROW));
  for (let r = -rows; r <= rows; r++) {
    const a = r * step * GRID_ROW;
    // 真ん中の横線（フレームガイドの楕円の中心を通る線）は色を変え、基準の線として見分けやすくする
    const mid = r === 0, rgb = mid ? '255,128,170' : '255,211,107';
    line(P(a, -half), P(a, half), `rgba(${rgb},${mid ? 0.85 : 0.45})`, mid ? 1.5 : 1);
    // 目盛り：中心線から1目盛りごとに短い線、5目盛りごとに長い線
    for (let k = 1; k * step <= half; k++) {
      const t = (k % 5 === 0 ? 0.45 : 0.22) * step;
      for (const s of [-1, 1]) line(P(a - t, s * k * step), P(a + t, s * k * step), `rgba(${rgb},${mid ? 0.95 : 0.75})`, k % 5 === 0 ? 1.6 : 1);
    }
  }
}
/** 目盛りの数（楕円の横の半径あたり）と、横線の間隔（目盛りの数） */
const GRID_TICKS = 10, GRID_ROW = 6;
function drawFrameGuide(M, fw, fh, angle) {
  const c = G.ap(M, [fw / 2, fh / 2]), k = G.scaleOf(M);
  const ry = (settings.frame * fh) / 2, rx = ry * IM.FRAME_ASPECT;
  ctx.beginPath(); ctx.ellipse(c[0], c[1], rx * k, ry * k, angle * G.DEG, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,.8)'; ctx.lineWidth = 1.5 * DPR(); ctx.setLineDash([3 * DPR(), 5 * DPR()]); ctx.stroke(); ctx.setLineDash([]);
}

/** カメラ映像と、画面ごとの重ね表示 */
function drawLive() {
  const W = cv.width, H = cv.height;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
  if (!cam.ready) return;
  const v = cam.video, c = cam.crop();
  const d = G.coverRect(c.sw, c.sh, W, H);
  const fw = c.sw, fh = c.sh;
  let V = [d.s, 0, 0, d.s, d.x, d.y];
  if (liveView()) {
    // 顔位置設定・ミラー：ピンチで拡大した表示。映像と重ね表示を同じ変換で描き、重ね表示が映像に追従する
    const fv = clampLiveView();
    V = G.mul([fv.s, 0, 0, fv.s, fv.x, fv.y], V);
  } else if (S.screen === 'home' && S.flip) {
    // 左右反転：映像と補助の表示をまとめて、画面の中央で左右に反転する
    V = G.mul([-1, 0, 0, 1, W, 0], V);
  }
  ctx.setTransform(...V);
  ctx.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, fw, fh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const a = settings.assist;

  if (S.screen === 'home') {
    if (a.frame) drawFrameGuide(V, fw, fh, settings.angle);
    if (a.center) drawGuides(V, fw, fh, settings.angle);
  } else if (S.screen === 'face') {
    // 元の位置：前回の撮影画像の輪郭（ガイドの下に描く）
    if (a.edge && S.lastCap) drawCapEdges(S.lastCap, V, fw, settings.edgeAlpha);
    drawFrameGuide(V, fw, fh, settings.angle);
    drawGuides(V, fw, fh, settings.angle);
    // 照明の左右差・ピンぼけの判定は、設置して撮影する顔位置設定でだけ行う（ホームでは行わず、端末の発熱を抑える）
    runChecks(c);
  } else if (S.screen === 'mirror') {
    drawMirror(V, fw, fh);
  }
}

/**
 * 撮影画像の座標 → 映像の座標。撮影した後にズーム倍率を変えた場合は、倍率の比で映像の中央を基準に拡大・縮小する
 * （ズームは映像の中央を基準に拡大するため、比で合わせるとヘッドに重なる）
 */
function capToFrame(cap, fw, fh) {
  const k = zoomRatio(cap);
  return G.mul(G.T(fw / 2, fh / 2), G.S(k), G.T(-fw / 2, -fh / 2), G.S(fw / cap.w));
}
/** 今のズーム倍率 ÷ 撮影したときのズーム倍率 */
const zoomRatio = (cap) => (cap.zoom && cam.zoom ? cam.zoom / cap.zoom : 1);

function drawCapEdges(cap, V, fw, alpha) {
  ctx.save();
  ctx.globalAlpha = 1 - alpha / 100;
  ctx.setTransform(...G.mul(V, capToFrame(cap, fw, (fw * cap.h) / cap.w)));
  ctx.drawImage(IM.tintEdges(edgesOf(cap.canvas), lineColorOf(cap.canvas), tintCache), 0, 0, cap.w, cap.h);
  ctx.restore();
}

/** ミラーに表示する画像の種類：'live'（今の映像）/ 'before'（撮影画像）/ 'after'（仮置きの結果） */
const mirrorWhich = () => (S.mirror.which === 'after' && S.sim ? 'after' : S.mirror.which === 'live' ? 'live' : 'before');
/**
 * ミラー：片側を中心線で反転し、反対側（重ねる側）の半分にだけ重ねる。
 * ライブは今の映像（撮影しない）、撮影画像はミラーで撮影した画像、仮置きはパーツ移動の結果を反転する
 */
function drawMirror(V, fw, fh) {
  const which = mirrorWhich();
  let Vc, w, h, angle, paint;
  if (which === 'live') {
    // 今の映像を、映像の座標のまま反転する（中心線は今の角度）。輪郭は使わない（コマごとに取り出すと重いため）
    const v = cam.video, c = cam.crop();
    Vc = V; w = fw; h = fh; angle = settings.angle;
    paint = () => ctx.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, fw, fh);
  } else {
    const cap = which === 'after' ? S.sim.cap : S.mirrorCap;
    if (!cap) return;
    const img = which === 'after' ? S.sim.full() : cap.canvas;
    Vc = G.mul(V, capToFrame(cap, fw, fh)); w = cap.w; h = cap.h; angle = cap.angle;
    paint = settings.mirrorMode === 'edge'
      ? () => ctx.drawImage(IM.tintEdges(edgesOf(img), lineColorOf(cap.canvas), tintCache), 0, 0, cap.w, cap.h)
      : () => ctx.drawImage(img, 0, 0);
  }
  const ax = G.axis(w, h, angle);
  // basis は重ねる側：'left' は画面右側を反転して画面左側へ、'right' はその逆
  const side = S.mirror.basis === 'left' ? -1 : 1;
  const poly = G.halfPlane(ax, side, Math.max(w, h) * 2).map((p) => G.ap(Vc, p));
  ctx.save();
  ctx.beginPath(); poly.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.clip();
  ctx.globalAlpha = 1 - settings.mirrorAlpha / 100;
  ctx.setTransform(...G.mul(Vc, G.reflectM(ax)));
  paint();
  ctx.restore();
  if (settings.assist.center) drawGuides(Vc, w, h, angle, false);
}

// ---------------- 照明の左右差・ピンぼけのチェック（一定間隔で行う） ----------------
const checkCanvas = IM.canvas(1, 1);
function runChecks(c) {
  const now = performance.now();
  if (now - S.checks.t < 500) return;
  S.checks.t = now;
  const a = settings.assist;
  if (!a.light && !a.sharp) { renderChips(); return; }
  if (a.light) {
    const s = Math.min(1, 400 / Math.max(c.sw, c.sh));
    checkCanvas.width = Math.round(c.sw * s); checkCanvas.height = Math.round(c.sh * s);
    checkCanvas.getContext('2d', { willReadFrequently: true }).drawImage(cam.video, c.sx, c.sy, c.sw, c.sh, 0, 0, checkCanvas.width, checkCanvas.height);
    S.checks.light = IM.lightBalance(checkCanvas, checkCanvas.width, checkCanvas.height, { angle: settings.angle, frame: settings.frame });
  } else S.checks.light = 0;
  // 鮮明さは、撮影時のチェック（capture）と同じ解像度で判定するため、縮小した画像ではなく映像から直接求める
  // （判定の値は画像の縮め方で変わるため。表示では出ないのに撮影すると「ぼやけています」と出る食い違いを防ぐ）
  if (a.sharp) {
    const fr = frameRect(c.sw, c.sh);
    S.checks.sharp = IM.sharpness(cam.video, { ...fr, x: fr.x + c.sx, y: fr.y + c.sy });
  } else S.checks.sharp = null;
  renderChips();
}
function renderChips() {
  const chips = [];
  if (S.screen === 'home') {
    if (S.flip) chips.push('<span class="pill bad">左右反転中（画面の左右がふだんと逆です）</span>');
  }
  if (S.screen === 'face') {
    const a = settings.assist, l = S.checks.light;
    chips.push(`<span class="pill">中心線の角度 <b class="mono">${fmtAngle(settings.angle)}</b></span>`);
    // 重ねたまま忘れないよう、重ねている間は何をする表示かを出す
    if (a.edge && S.lastCap) chips.push('<span class="pill">輪郭にヘッドを合わせてください</span>');
    // 照明の左右差（l > 0：画面右側が明るい〔画面左側が暗い〕）とピンぼけ。撮影する前に直せるよう、顔位置設定で知らせる
    if (a.light && Math.abs(l) > IM.LIGHT_DIFF) chips.push(`<span class="pill warn">${l > 0 ? '左' : '右'}側が暗めです</span>`);
    if (a.sharp && S.checks.sharp != null && S.checks.sharp < IM.SHARP_MIN) chips.push('<span class="pill warn">ピンぼけ・ブレの可能性があります</span>');
  }
  if (S.screen === 'mirror' && (mirrorWhich() === 'live' || S.mirrorCap || S.sim)) {
    // 重ねる側・表示する画像はパネルのボタンで分かるため、映像の上には出さない（眉・額にかからないよう、表示は短く少なくする）。
    // パネルに無い撮影の時刻と、パネルからは分からない注意だけを出す。
    // 仮置きで覆われる側の修正が映らないことは出さない（ミラーの仕組みそのもので、左右コピーで両側にパーツがあるといつも出続けるため）
    const which = mirrorWhich();
    const mc = which === 'after' ? S.sim.cap : which === 'before' ? S.mirrorCap : null;
    if (mc) chips.push(`<span class="pill">${hhmm(mc.time)} 撮影</span>`);
    if (mc && Math.abs(zoomRatio(mc) - 1) > 0.01) chips.push('<span class="pill warn">ズーム違い：撮り直すとはっきりします</span>');
  }
  if (S.screen === 'sim' && S.sim) {
    if (S.before) chips.push('<span class="pill bad">修正前を表示中</span>');
    // 編集中のパーツは、パネルのパーツの名前で分かるため出さない。囲む・支点を決める操作中だけ、何をするかを出す
    if (S.mode === 'lasso') chips.push('<span class="pill">指でなぞって、パーツにする範囲を囲んでください</span>');
    else if (S.mode === 'relasso') chips.push('<span class="pill">選択範囲を囲み直してください</span>');
    else if (S.mode === 'redest') chips.push('<span class="pill">もとからあるメイクを薄くする・消す範囲を囲んでください</span>');
    else if (S.mode === 'pivot') chips.push('<span class="pill">回転の支点にする位置をタップしてください</span>');
  }
  const html = chips.join('');
  const el = $('#chips');
  if (el.innerHTML !== html) el.innerHTML = html;
}
const fmtAngle = (a) => `${a > 0 ? '+' : a < 0 ? '−' : ''}${Math.abs(a).toFixed(1)}°`;

// ======================================================================
// 案内（バナー）
// ======================================================================
function updateBanner() {
  const b = $('#banner'), t = $('#banner-text'), act = $('#banner-act');
  act.innerHTML = '';
  let show = false;
  if (S.screen === 'home' && S.startupNote && cam.ready) {
    // 顔位置設定の「撮影して完了」が、元の位置・ミラーの撮影画像・仮置きの出発点になるため、撮影まで案内する
    t.textContent = 'ヘッドを中心線に合わせて撮影してください';
    act.innerHTML = '<button class="btn btn-primary btn-s" data-go="face">顔位置設定へ</button>';
    show = true;
  } else if (S.screen === 'home' && S.resumeNote && cam.ready && (S.mirrorCap || S.sim)) {
    // アプリを切り替えるたびに出るため、短くする（確かめ方は「顔位置設定へ」のボタンとマニュアルで分かる）
    t.textContent = 'ヘッドが動いていないか確かめてください';
    act.innerHTML = '<button class="btn btn-primary btn-s" data-go="face">顔位置設定へ</button>';
    show = true;
  } else if (S.screen === 'mirror' && S.headMoved && mirrorWhich() !== 'live' && (S.mirrorCap || S.sim)) {
    // 撮影画像・仮置きのどちらでも、ヘッドを撮影したときの位置に戻せば重なる（撮影画像は、顔位置設定の「撮影して完了」で撮り直される）
    t.textContent = 'ヘッドの位置が変わっている場合は、顔位置設定で撮影したときの輪郭に合わせて戻してください';
    act.innerHTML = '<button class="btn btn-primary btn-s" data-go="face">顔位置設定へ</button>';
    show = true;
  }
  b.hidden = !show;
}
$('#banner-x').addEventListener('click', () => {
  if (S.screen === 'home') { S.startupNote = false; S.resumeNote = false; }
  if (S.screen === 'mirror') S.headMoved = false;
  updateBanner();
});

// ======================================================================
// カメラ（ホーム）
// ======================================================================
function updateHome() {
  $('#home-hint').hidden = cam.wakeSupported;
  renderChips();
}
holdButton($('#btn-flip'), (v) => { S.flip = v; renderChips(); });
$('#btn-mirror').addEventListener('click', () => openMirror());
$('#btn-sim').addEventListener('click', () => openSim());

// ---------------- 水準器 ----------------
// on：センサーの値を受け取っている、seen：値が届いた、none：値が届かない（センサーが無い）、granted：iOS で利用が許可された
const level = { roll: 0, pitch: 0, seen: false, on: false, none: false, granted: false, timer: 0 };
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  // 下向き（重力）の向き。Android は反力（上向き）を返すため向きを反転する
  let x = isIOS ? a.x : -a.x, y = isIOS ? a.y : -a.y;
  const z = isIOS ? a.z : -a.z;
  const ang = ((screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI) / 180;
  [x, y] = [x * Math.cos(ang) - y * Math.sin(ang), x * Math.sin(ang) + y * Math.cos(ang)];
  const roll = Math.atan2(x, -y) / G.DEG, pitch = Math.atan2(z, Math.hypot(x, y)) / G.DEG;
  level.roll = level.seen ? level.roll * 0.8 + roll * 0.2 : roll;
  level.pitch = level.seen ? level.pitch * 0.8 + pitch * 0.2 : pitch;
  level.seen = true;
  level.none = false; // 最初の値が遅れて届いた場合も表示する
}
function startLevel() {
  if (level.on) return;
  level.on = true; level.seen = false; level.none = false;
  window.addEventListener('devicemotion', onMotion);
  clearTimeout(level.timer);
  level.timer = setTimeout(() => { if (level.on && !level.seen) level.none = true; }, 1500);
}
/** 顔位置設定を離れたら、センサーの値を受け取るのをやめる（電池のため） */
function stopLevel() {
  if (!level.on) return;
  level.on = false;
  window.removeEventListener('devicemotion', onMotion);
  clearTimeout(level.timer);
}
function updateLevel() {
  const el = $('#level'), ask = $('#level-ask');
  // 水準器はスタンドの設置に使うため、顔位置設定に出す
  const want = settings.assist.level && S.screen === 'face';
  if (!want) stopLevel();
  // iOS は、許可をユーザーの操作で求める（一度許可されたら、開いている間は尋ね直さない）
  const needAsk = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function' && !level.granted;
  ask.hidden = !(want && needAsk);
  if (want && !needAsk && !level.on && 'DeviceMotionEvent' in window) startLevel();
  el.hidden = !(want && level.seen && !level.none);
  if (el.hidden) return;
  const flat = Math.abs(level.roll) < 1 && Math.abs(level.pitch) < 1;
  el.classList.toggle('flat', flat);
  const k = 2.4;
  el.querySelector('i').style.transform = `translate(${G.clamp(level.roll * k, -14, 14)}px, ${G.clamp(-level.pitch * k, -14, 14)}px)`;
  $('#level-val').textContent = `左右 ${Math.abs(level.roll).toFixed(1)}°  前後 ${Math.abs(level.pitch).toFixed(1)}°`;
}
$('#level-ask').addEventListener('click', async () => {
  try {
    const r = await DeviceMotionEvent.requestPermission();
    if (r === 'granted') { level.granted = true; startLevel(); }
    else toast('モーションセンサーが許可されなかったため、水準器は使えません');
  } catch { toast('水準器を使えませんでした'); }
});
setInterval(updateLevel, 120);

// ======================================================================
// 顔位置設定
// ======================================================================
function updateFace() {
  // 元の位置（前回の撮影画像の輪郭）
  const has = !!S.lastCap;
  $('#btn-edge').disabled = !has;
  $('#btn-edge').setAttribute('aria-pressed', String(has && settings.assist.edge));
  $('#edge-hint').textContent = has
    ? `${hhmm(S.lastCap.time)} の輪郭に合わせます`
    : '「撮影して完了」を押すと、次から使えます';
  $('#edge-alpha-row').hidden = !(has && settings.assist.edge);
  $('#edge-alpha').value = settings.edgeAlpha;
  $('#edge-alpha-v').textContent = `${settings.edgeAlpha}%`;
  renderChips();
}
$('#btn-edge').addEventListener('click', () => { settings.assist.edge = !settings.assist.edge; save(); updateFace(); });
$('#edge-alpha').addEventListener('input', (e) => { settings.edgeAlpha = +e.target.value; save(); updateFace(); });
$$('[data-angle]').forEach((b) => b.addEventListener('click', () => {
  settings.angle = Math.round(G.clamp(settings.angle + +b.dataset.angle, -10, 10) * 10) / 10; save(); updateFace();
}));
$('#btn-angle0').addEventListener('click', () => { settings.angle = 0; save(); updateFace(); });

// ---------------- 顔位置設定・ミラーの表示（拡大・移動） ----------------
const FACE_ZOOM_MAX = 8;
/** 今の画面の表示の拡大・移動（顔位置設定とミラーだけ。それ以外は null） */
function liveView() { return S.screen === 'face' ? S.face.view : S.screen === 'mirror' ? S.mirror.view : null; }
/** 拡大した表示が画面の外にはみ出さないようにする（1倍未満にはしない）。今の表示を返す */
function clampLiveView() {
  const v = liveView(), W = cv.width, H = cv.height;
  v.s = G.clamp(v.s, 1, FACE_ZOOM_MAX);
  v.x = G.clamp(v.x, W - W * v.s, 0); v.y = G.clamp(v.y, H - H * v.s, 0);
  return v;
}
/** 表示を at（画面の座標）を中心に f 倍する */
function zoomLive(f, at) {
  const v = liveView(), s = G.clamp(v.s * f, 1, FACE_ZOOM_MAX), k = s / v.s;
  v.x = at[0] - (at[0] - v.x) * k; v.y = at[1] - (at[1] - v.y) * k; v.s = s;
  clampLiveView();
}

$('#btn-face-help').addEventListener('click', () => choose({ title: '合わせ方', html: $('#face-help').innerHTML, cancel: '閉じる' }));
/**
 * 撮影して完了：合わせ終えたヘッドを撮影し、ミラーの撮影画像（と元の位置の輪郭）にしてから戻る。
 * 撮影せずに戻るときは「‹」。カメラが使えないときは撮影せずに戻る
 */
$('#btn-face-done').addEventListener('click', async () => {
  if (cam.ready) {
    const cap = await capture();
    if (!cap) return; // 取りやめた（ぼやけの確認でキャンセル等）：画面に残る
    if (S.screen !== 'face') return;
    S.mirrorCap = cap;
    // 撮影画像の角度は今の角度。仮置きにも今の角度を当て、ヘッドは今合わせたので案内は出さない
    S.face.angle0 = settings.angle;
    if (S.sim && Math.abs(S.sim.cap.angle - settings.angle) > 0.001) S.sim.setAngle(settings.angle);
    S.headMoved = false;
    toast('撮影しました'); // どこで使えるかは、ホームの入口の説明とマニュアルで分かる
  }
  back();
});

/**
 * 顔位置設定を離れるとき（show() から呼ぶ）：角度を変えた場合は、既にある撮影画像にもいつも適用する（ミラーの反転・左右コピーの位置を計算し直す）。
 * 設置ガイドへ移ってから戻る場合も、離れる時点で適用する（戻ったときに開いたときの角度を今の角度にするため、後からでは差が分からない）。
 * ヘッドを動かしたために角度を直した場合に備え、ミラーを開いたときに元の位置に戻すよう案内する（「撮影して完了」では撮り直すため案内しない）。
 * 適用するかを選ぶ確認は出さない（理由を思い出して選ぶのが難しく、角度の差は小さいため）
 */
function applyFaceAngle() {
  const a0 = S.face.angle0, a1 = settings.angle;
  if (Math.abs(a0 - a1) < 0.001 || !(S.mirrorCap || S.sim)) return;
  if (S.mirrorCap) S.mirrorCap.angle = a1;
  if (S.sim && Math.abs(S.sim.cap.angle - a1) > 0.001) S.sim.setAngle(a1);
  S.face.angle0 = a1;
  // トーストは出さない（ミラーを開いたときの、元の位置に戻す案内で分かる）
  S.headMoved = true;
}

// ======================================================================
// ミラー
// ======================================================================
/** ミラーを開く。撮影はしない（ライブから始め、撮影画像は「今の映像を撮影」か顔位置設定の「撮影して完了」で撮る） */
function openMirror(which) {
  if (which) S.mirror.which = which;
  go('mirror');
  updateMirror();
}
/** ミラーで今の映像を撮影し、撮影画像の表示にする。撮影できなかったら false */
async function shootMirror() {
  const cap = await capture();
  if (!cap || S.screen !== 'mirror') return false;
  S.mirrorCap = cap; S.headMoved = false;
  S.mirror.which = 'before';
  return true;
}
function setSeg(sel, v) { $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
function updateMirror() {
  if (!S.sim && S.mirror.which === 'after') S.mirror.which = 'live';
  if (!S.mirrorCap && S.mirror.which === 'before') S.mirror.which = 'live';
  setSeg('#m-basis', S.mirror.basis);
  setSeg('#m-which', S.mirror.which);
  $('#m-which [data-v=after]').disabled = !S.sim;
  const live = mirrorWhich() === 'live';
  // ライブは「画像」だけ（輪郭をコマごとに取り出すと端末が熱くなるため）。「輪郭のみ」を押すと撮影画像に切り替える
  setSeg('#m-mode', live ? 'img' : settings.mirrorMode);
  $('#m-alpha').value = settings.mirrorAlpha;
  $('#m-alpha-v').textContent = `${settings.mirrorAlpha}%`;
  renderChips();
  updateBanner();
}
$('#m-basis').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { S.mirror.basis = v; updateMirror(); } });
$('#m-which').addEventListener('click', async (e) => {
  const b = e.target.closest('button'), v = b?.dataset.v;
  if (!v || b.disabled) return;
  if (v === 'before' && !S.mirrorCap) {
    // 撮影画像に切り替えたとき、まだ撮影画像が無ければ撮影する
    if (await shootMirror()) updateMirror();
    return;
  }
  S.mirror.which = v; updateMirror();
});
$('#m-mode').addEventListener('click', async (e) => {
  const b = e.target.closest('button'), v = b?.dataset.v;
  if (!v || b.disabled) return;
  // ライブで「輪郭のみ」を選んだら、撮影画像に切り替える（無ければ撮影する）
  // （輪郭をコマごとに取り出すと端末が熱くなるため。パネルに常に説明を出す代わりに、押したときに知らせる）
  if (v === 'edge' && mirrorWhich() === 'live') {
    if (S.mirrorCap) S.mirror.which = 'before';
    else if (!(await shootMirror())) return;
    // 理由（ライブでは端末が熱くなる）はマニュアルに書き、トーストは短くする（映像を長く覆わないように）
    toast('輪郭は撮影画像で表示します');
  }
  settings.mirrorMode = v; save(); updateMirror();
});
$('#m-alpha').addEventListener('input', (e) => { settings.mirrorAlpha = +e.target.value; save(); $('#m-alpha-v').textContent = `${settings.mirrorAlpha}%`; });
// 今の映像を撮影：ライブ・撮影画像・仮置きのどれを表示していても、撮影して撮影画像の表示にする
// （表示と映像の上の撮影の時刻が変わって分かるため、トーストは出さない）
$('#btn-shot').addEventListener('click', async () => {
  if (!(await shootMirror())) return;
  updateMirror();
});
// ミラーのヘッダーの「仮置き」：仮置きがあれば、選ばずにそのまま戻る（仮置き ⇄ ミラーの往復で毎回選ばせない）。
// 新しく始めるかを選ぶのは、ホームの入口から
$('#btn-m-sim').addEventListener('click', () => (S.sim ? go('sim') : openSim()));

// ======================================================================
// 仮置き
// ======================================================================
/**
 * 仮置きを開く。元にする画像は、アプリで1つの撮影画像（顔位置設定の「撮影して完了」・ミラーの「今の映像を撮影」で撮ったもの）。
 * 撮影画像が古い場合に備え、今の映像を撮影して始めることも選べる（そのとき撮った画像も撮影画像にする）。
 * 仮置きは始めたときの画像を使い続ける（後で撮影画像を撮り直しても、パーツの位置がずれないように変えない）
 */
async function openSim() {
  const sim = S.sim, cont = !!(sim && sim.hasContent), cap0 = S.mirrorCap;
  let r = 'shoot';
  if (cont || cap0) {
    const choices = [];
    if (cont) choices.push({ value: 'continue', label: '続きから', desc: `前回の仮置き（パーツ ${sim.parts.length}つ、${hhmm(sim.cap.time)} の画像）と、取り消しの履歴をそのまま使います。` });
    if (cap0) choices.push({ value: 'cap', label: `${hhmm(cap0.time)} の撮影画像で始める`, desc: '撮影せずに、今ある撮影画像で始めます。その後に進めたメイクは入っていません。' });
    choices.push({ value: 'shoot', label: '今の映像を撮影して始める', desc: 'メイクを進めた後はこちら。撮影した画像は、ミラーの撮影画像にもなります。' });
    r = await choose({
      title: '仮置き',
      html: cont ? '<p>新しく始めると、前回のパーツ移動と取り消しの履歴は消えます（元に戻せません）。</p>' : '',
      choices,
    });
    if (r === 'continue') { go('sim'); return; }
    // 前回の仮置きが消えることは、このダイアログに書いてあるため、もう一度は確かめない
    if (r !== 'cap' && r !== 'shoot') return;
  }
  if (S.screen !== 'home' && S.screen !== 'mirror') return;
  let cap = cap0;
  if (r === 'shoot') {
    cap = await capture();
    if (!cap) return;
    // どこで撮っても撮影画像は1つ（ミラーの撮影画像にもする）
    S.mirrorCap = cap; S.headMoved = false;
  }
  // 中心線の角度は仮置きごとに持つ（撮影画像の角度を書き換えないよう、写しを渡す。画像そのものは共用する）
  S.sim = new Sim({ ...cap, guides: { ...cap.guides } });
  S.view = null;
  go('sim');
}
$('#btn-sim-mirror').addEventListener('click', () => openMirror('after'));

// ---------------- 表示（拡大・移動） ----------------
/** 画像全体を表示する倍率（仮置きの倍率の表示の 1×） */
function simFitScale() {
  const cap = S.sim.cap, m = 8 * DPR();
  return G.containRect(cap.w, cap.h, cv.width - 2 * m, cv.height - 2 * m).s;
}
function fitView() {
  const cap = S.sim.cap, m = 8 * DPR();
  const r = G.containRect(cap.w, cap.h, cv.width - 2 * m, cv.height - 2 * m);
  S.view = { s: r.s, x: r.x + m, y: r.y + m, auto: true };
  S.dirty = true;
}
const viewM = () => [S.view.s, 0, 0, S.view.s, S.view.x, S.view.y];
const toImg = (p) => G.ap(G.inv(viewM()), p);
function zoomView(f, at) {
  const v = S.view, s = G.clamp(v.s * f, 0.02, 40);
  const k = s / v.s;
  v.x = at[0] - (at[0] - v.x) * k; v.y = at[1] - (at[1] - v.y) * k; v.s = s; v.auto = false;
  S.dirty = true;
}

function drawSim() {
  const sim = S.sim;
  if (!S.view) fitView();
  const W = cv.width, H = cv.height, V = viewM();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#1b1517'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  sim.render(ctx, V, S.before);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawGuides(G.mul(V), sim.cap.w, sim.cap.h, sim.cap.angle, false);
  if (S.before) { renderChips(); return; }
  const p = sim.selPart;
  for (const q of sim.parts) if (q !== p && q.visible) outlinePart(q, V, 'rgba(255,255,255,.45)', [3, 3]);
  if (p) {
    // コピー先の消す範囲（もとからあるメイクを薄くする・消す範囲）。「残す」では使わないため表示しない
    if (p.copy) { if (p.origin !== 'keep') polyPath(sim.destPoly(p).map((q) => G.ap(V, q)), 'rgba(255,211,107,.8)', [4, 3]); }
    else polyPath(p.poly.map((q) => G.ap(V, q)), 'rgba(255,255,255,.7)', [4, 3]);
    outlinePart(p, V, '#e08ba1', null);
    const { piv } = sim.frame(p);
    const c = G.ap(V, [piv[0] + p.t.tx, piv[1] + p.t.ty]), r = 6 * DPR();
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2 * DPR();
    ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.stroke();
    line([c[0] - 2 * r, c[1]], [c[0] + 2 * r, c[1]], '#ffd36b', 2); line([c[0], c[1] - 2 * r], [c[0], c[1] + 2 * r], '#ffd36b', 2);
  }
  if (G_.lasso) polyPath(G_.lasso.map((q) => G.ap(V, q)), '#fff', null, false);
  renderChips();
}
function polyPath(pts, color, dash, close = true) {
  if (pts.length < 2) return;
  ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); if (close) ctx.closePath();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5 * DPR(); ctx.setLineDash(dash ? dash.map((d) => d * DPR()) : []); ctx.stroke(); ctx.setLineDash([]);
}
function outlinePart(p, V, color, dash) {
  const ex = S.sim.layerOf(p), M = G.mul(V, S.sim.matrix(p));
  const pts = [[ex.x, ex.y], [ex.x + ex.w, ex.y], [ex.x + ex.w, ex.y + ex.h], [ex.x, ex.y + ex.h]].map((q) => G.ap(M, q));
  polyPath(pts, color, dash);
}

// ---------------- 画面の操作（ドラッグ・ピンチ） ----------------
// 1本指：パーツの上ならパーツを動かす、それ以外は画面を動かす
// 2本指：パーツを動かしている途中ならパーツの回転・拡大縮小、それ以外は画面の拡大・移動
const pts = new Map();
const G_ = { kind: null, lasso: null };
const stage = $('#stage');
const evPos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * DPR(), (e.clientY - r.top) * DPR()]; };

stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.ov, button')) return;
  const p = evPos(e);
  if (S.screen === 'home') {
    // ホーム：2本指（ピンチ）でズーム倍率を変える（1本指の操作は無い）
    if (!cam.ready) return;
    try { stage.setPointerCapture(e.pointerId); } catch { /* 取り込めなくても操作は続ける */ }
    pts.set(e.pointerId, p);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      G_.kind = 'homeZoom'; G_.z0 = cam.zoom; G_.p0 = { d: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    }
    return;
  }
  if (liveView()) {
    // 顔位置設定・ミラー：1本指で表示の移動、2本指（ピンチ）で表示の拡大・縮小
    try { stage.setPointerCapture(e.pointerId); } catch { /* 取り込めなくても操作は続ける */ }
    pts.set(e.pointerId, p);
    if (pts.size === 1) { G_.kind = 'facePan'; G_.last = p; }
    else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      G_.kind = 'facePinch'; G_.v0 = { ...liveView() };
      G_.p0 = { d: Math.hypot(b[0] - a[0], b[1] - a[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    }
    return;
  }
  if (S.screen !== 'sim' || !S.sim || S.before) return;
  if (!S.view) { fitCanvas(); fitView(); } // 最初の描画より前に触れた場合（画面の大きさに合わせてから表示を決める）
  try { stage.setPointerCapture(e.pointerId); } catch { /* 取り込めなくても操作は続ける */ }
  pts.set(e.pointerId, p);
  const sim = S.sim;
  if (pts.size === 1) {
    const q = toImg(p);
    G_.start = p; G_.last = p; G_.moved = false;
    if (S.mode === 'lasso' || S.mode === 'relasso' || S.mode === 'redest') { G_.kind = 'lasso'; G_.lasso = [q]; return; }
    if (S.mode === 'pivot') {
      const sp = sim.selPart;
      if (sp) { sim.begin(); sim.setPivot(sp, toPivotSpace(sp, q)); }
      S.mode = null; G_.kind = null; updateSimPanel(); S.dirty = true; return;
    }
    const hit = sim.selPart && sim.hit(sim.selPart, q) ? sim.selPart : [...sim.parts].reverse().find((x) => x.visible && sim.hit(x, q));
    if (hit) {
      if (sim.sel !== hit.id) { sim.sel = hit.id; updateSimPanel(); }
      sim.begin(); G_.kind = 'part'; G_.t0 = { ...hit.t }; G_.q0 = q;
      S.dirty = true; return;
    }
    G_.kind = 'pan';
  } else if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    G_.p0 = { a, b, d: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: Math.atan2(b[1] - a[1], b[0] - a[0]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    if (G_.kind === 'part') { G_.kind = 'partPinch'; G_.t0 = { ...sim.selPart.t }; }
    else { G_.kind = 'pinch'; G_.lasso = null; G_.v0 = { ...S.view }; }
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId)) return;
  const p = evPos(e);
  pts.set(e.pointerId, p);
  if (S.screen === 'home') {
    if (pts.size === 2 && G_.kind === 'homeZoom') {
      const [a, b] = [...pts.values()];
      pinchZoom(G_.z0 * Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, G_.p0.d));
    }
    return;
  }
  if (liveView()) {
    const v = liveView();
    if (pts.size === 1 && G_.kind === 'facePan') {
      v.x += p[0] - G_.last[0]; v.y += p[1] - G_.last[1]; clampLiveView();
      G_.last = p;
    } else if (pts.size === 2 && G_.kind === 'facePinch') {
      const [a, b] = [...pts.values()];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], v0 = G_.v0;
      const s = G.clamp(v0.s * Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1, G_.p0.d), 1, FACE_ZOOM_MAX);
      // ピンチの中心を基準に拡大し、指の移動に合わせて動かす
      v.s = s;
      v.x = mid[0] - (G_.p0.mid[0] - v0.x) * (s / v0.s);
      v.y = mid[1] - (G_.p0.mid[1] - v0.y) * (s / v0.s);
      clampLiveView();
    }
    return;
  }
  const sim = S.sim;
  if (!sim) return;
  if (pts.size === 1) {
    if (Math.hypot(p[0] - G_.start[0], p[1] - G_.start[1]) > 3 * DPR()) G_.moved = true;
    const q = toImg(p);
    if (G_.kind === 'lasso') { G_.lasso.push(q); S.dirty = true; }
    else if (G_.kind === 'part') {
      const sp = sim.selPart;
      sp.t.tx = G_.t0.tx + q[0] - G_.q0[0]; sp.t.ty = G_.t0.ty + q[1] - G_.q0[1];
      sim.touch(); S.dirty = true;
    } else if (G_.kind === 'pan') {
      S.view.x += p[0] - G_.last[0]; S.view.y += p[1] - G_.last[1]; S.view.auto = false; S.dirty = true;
    }
    G_.last = p;
  } else if (pts.size === 2 && G_.p0) {
    const [a, b] = [...pts.values()];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]), ang = Math.atan2(b[1] - a[1], b[0] - a[0]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const f = d / Math.max(1, G_.p0.d);
    G_.moved = true;
    if (G_.kind === 'partPinch') {
      const sp = sim.selPart, t0 = G_.t0;
      sp.t.rot = t0.rot + (ang - G_.p0.ang);
      sp.t.sl = G.clamp(t0.sl * f, 0.2, 5); sp.t.st = G.clamp(t0.st * f, 0.2, 5);
      sp.t.tx = t0.tx + (mid[0] - G_.p0.mid[0]) / S.view.s; sp.t.ty = t0.ty + (mid[1] - G_.p0.mid[1]) / S.view.s;
      sim.touch();
    } else if (G_.kind === 'pinch') {
      const v0 = G_.v0, s = G.clamp(v0.s * f, 0.02, 40);
      // ピンチの中心を基準に拡大し、指の移動に合わせて動かす
      S.view.s = s; S.view.auto = false;
      S.view.x = mid[0] - (G_.p0.mid[0] - v0.x) * (s / v0.s);
      S.view.y = mid[1] - (G_.p0.mid[1] - v0.y) * (s / v0.s);
    }
    S.dirty = true;
  }
});
function endPointer(e) {
  if (!pts.has(e.pointerId)) return;
  pts.delete(e.pointerId);
  if (S.screen === 'home') {
    if (G_.kind === 'homeZoom' && pts.size < 2) { G_.kind = null; G_.p0 = null; endPinchZoom(); }
    return;
  }
  if (liveView()) {
    // 2本指のうち1本を離した：残りの指で表示の移動を続ける
    if (pts.size === 1) { G_.kind = 'facePan'; G_.last = [...pts.values()][0]; } else if (!pts.size) G_.kind = null;
    G_.p0 = null;
    return;
  }
  const sim = S.sim;
  if (!sim) return;
  if (pts.size === 1 && (G_.kind === 'pinch' || G_.kind === 'partPinch')) {
    // 2本指のうち1本を離した：残りの指では画面の移動だけにする（顔位置設定・ミラーと同じ。パーツは動かさない）
    if (G_.kind === 'partPinch') { updateSimPanel(); }
    G_.kind = 'pan'; G_.p0 = null; G_.last = [...pts.values()][0];
    return;
  }
  if (pts.size > 0) return;
  const k = G_.kind;
  G_.kind = null; G_.p0 = null;
  if (k === 'lasso') finishLasso();
  else if (k === 'part') { if (!G_.moved) sim.cancel(); updateSimPanel(); }
  else if (k === 'partPinch') updateSimPanel();
  S.dirty = true;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
  if (liveView()) { e.preventDefault(); zoomLive(Math.exp(-e.deltaY * 0.0015), evPos(e)); return; }
  if (S.screen === 'home' && cam.ready) {
    // PC：マウスホイールでズーム倍率を変える（回し終えて少し経ったら保存する）
    e.preventDefault();
    // 1回の量が小さくても進むよう、丸める前の値を積み重ねる
    const r = cam.zoomRange();
    camZoom.wheel = G.clamp((camZoom.wheel ?? cam.zoom) * Math.exp(-e.deltaY * 0.0015), r.min, r.max);
    pinchZoom(camZoom.wheel);
    clearTimeout(camZoom.timer); camZoom.timer = setTimeout(endPinchZoom, 400);
    return;
  }
  if (S.screen !== 'sim' || !S.view) return;
  e.preventDefault();
  zoomView(Math.exp(-e.deltaY * 0.0015), evPos(e));
}, { passive: false });

/** 支点はパーツの基準（移動前）の座標で持つ：画面上の点を、今の移動・回転を戻した位置に直す */
function toPivotSpace(p, q) {
  const { piv, a } = S.sim.frame(p), t = p.t;
  const M = G.mul(G.T(piv[0] + t.tx, piv[1] + t.ty), G.R(t.rot), G.R(a), G.S(t.sl, t.st), G.R(-a), G.T(-piv[0], -piv[1]));
  return G.ap(G.inv(M), q);
}

function finishLasso() {
  const sim = S.sim, mode = S.mode;
  const poly = G.simplify(G_.lasso || [], 2 / S.view.s);
  G_.lasso = null;
  if (poly.length < 3 || G.area(poly) * S.view.s * S.view.s < 300 * DPR() * DPR()) {
    toast('もう少し大きく囲んでください'); S.dirty = true; return;
  }
  S.mode = null;
  if (mode === 'relasso' || mode === 'redest') {
    const p = sim.selPart;
    if (!p) return;
    sim.begin();
    if (mode === 'redest') { p.poly = poly; p.destAuto = false; p._ox = null; }
    else {
      if (p.copy) p.copy.poly = poly; else p.poly = poly; p._ex = null; p._ox = null;
      // 反対側を囲み直した場合は、名前（側）も付け直す（コピーしたパーツの側は、コピー先で決まっているため変えない）
      if (!p.copy) sim.setSide(p, sim.sideOfPoly(poly));
    }
    sim.touch(); updateSimPanel(); S.dirty = true;
    return;
  }
  // 名前は囲んだ位置（中心線のどちら側か）から自動で付ける（例：右1）。
  // 追加したパーツは選んだ状態でパネルに出るため、トーストは出さない（左右コピーも同じ）
  sim.begin();
  sim.addPart(poly);
  updateSimPanel(); S.dirty = true;
}

// ---------------- パネル（パーツ移動） ----------------
function updateSimPanel() {
  const sim = S.sim;
  if (!sim) return;
  $('#btn-undo').disabled = !sim.undoStack.length;
  $('#btn-redo').disabled = !sim.redoStack.length;
  $('#parts').innerHTML = sim.parts.map((p) => `<button class="part ${p.id === sim.sel ? 'on' : ''} ${p.visible ? '' : 'off'}" data-id="${p.id}">${esc(p.name)}</button>`).join('');
  $('#parts-empty').hidden = sim.parts.length > 0;
  $('#btn-lasso').setAttribute('aria-pressed', String(S.mode === 'lasso'));
  const p = sim.selPart;
  $('#part-ctl').hidden = !p;
  if (p) {
    $('#part-name').textContent = p.name;
    $('#part-vis').checked = p.visible;
    const i = sim.parts.indexOf(p);
    $('#part-up').disabled = i === sim.parts.length - 1;
    $('#part-down').disabled = i === 0;
    setSeg('#origin', p.origin);
    setSeg('#sim-tab', S.simTab);
    // hidden（場所ごと消える）ではなく見えなくするだけにし、領域の高さを一番高いタブに揃える（style.css の .tab-stack）
    $$('#part-ctl [data-tab]').forEach((el) => { el.classList.toggle('off', el.dataset.tab !== S.simTab); });
    $('#origin-lbl').textContent = p.copy ? 'コピー先のメイク' : '元のメイク';
    $('#feather').value = p.feather;
    $('#strength').value = Math.round(p.strength * 100);
    const cs = copySide(p);
    $('#btn-copy').textContent = cs ? `${cs === 'L' ? '左' : '右'}へコピー` : '左右コピーの対象外（中央のパーツ）';
    $('#btn-copy').disabled = !cs;
    $('#btn-pivot').setAttribute('aria-pressed', String(S.mode === 'pivot'));
    // コピーしたパーツ：もとからあるメイクを薄くする・消す範囲を囲み直す（「残す」では範囲を使わないため出さない）
    $('#btn-relasso').textContent = p.copy ? '消す範囲を囲み直す' : '囲み直す';
    $('#btn-relasso').title = p.copy ? 'コピー先に、もとからあるメイクを薄くする・消す範囲を囲み直します' : '選択範囲を囲み直します';
    $('#btn-relasso').hidden = !!p.copy && p.origin === 'keep';
    // 「メイク」タブの中で、コピー先の黄色の点線が何の範囲かを1行で示す（「残す」では点線を出さないため空にする）
    $('#part-note').textContent = p.copy && p.origin !== 'keep' ? `黄色の点線：もとのメイクを${p.origin === 'erase' ? '消す' : '薄くする'}範囲` : '';
  }
  renderChips();
}
$('#parts').addEventListener('click', (e) => {
  const b = e.target.closest('[data-id]'); if (!b) return;
  S.sim.sel = +b.dataset.id; S.mode = null; updateSimPanel(); S.dirty = true;
});
$('#btn-lasso').addEventListener('click', () => { S.mode = S.mode === 'lasso' ? null : 'lasso'; updateSimPanel(); S.dirty = true; });
$('#btn-relasso').addEventListener('click', () => { const p = S.sim.selPart; if (!p) return; S.mode = p.copy ? 'redest' : 'relasso'; updateSimPanel(); });
$('#btn-pivot').addEventListener('click', () => { S.mode = S.mode === 'pivot' ? null : 'pivot'; updateSimPanel(); });
$('#btn-undo').addEventListener('click', () => { if (S.sim.undo()) { updateSimPanel(); S.dirty = true; } });
$('#btn-redo').addEventListener('click', () => { if (S.sim.redo()) { updateSimPanel(); S.dirty = true; } });

/** パーツへの操作（取り消しの履歴に積んでから変える） */
function edit(f) {
  const sim = S.sim, p = sim.selPart;
  if (!p) return;
  sim.begin(); f(p, sim); sim.touch(); updateSimPanel(); S.dirty = true;
}
// 微調整：1回の量は画像上の実寸ではなく、表示倍率に応じた一定の見た目の量（量の切り替えは無い。大きく動かすときはドラッグ・ピンチ）
$$('[data-mv]').forEach((b) => b.addEventListener('click', () => edit((p) => {
  const [dx, dy] = b.dataset.mv.split(',').map(Number), st = (1.5 * DPR()) / S.view.s;
  p.t.tx += dx * st; p.t.ty += dy * st;
})));
$$('[data-rot]').forEach((b) => b.addEventListener('click', () => edit((p) => { p.t.rot += +b.dataset.rot * 0.5 * G.DEG; })));
$$('[data-sc]').forEach((b) => b.addEventListener('click', () => edit((p) => {
  // data-sc は「方向,向き」（方向：all 全体 / len 長さ〔パーツの長い方向〕 / thk 太さ〔長さに直角な方向〕）
  const [dir, sg] = b.dataset.sc.split(','), f = 1 + +sg * 0.01;
  if (dir !== 'thk') p.t.sl = G.clamp(p.t.sl * f, 0.2, 5);
  if (dir !== 'len') p.t.st = G.clamp(p.t.st * f, 0.2, 5);
})));
// 仮置きのパネルのタブ（動かす／大きさ／メイク）。パネルの表示だけで、取り消しの対象にしない
$('#sim-tab').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { S.simTab = v; updateSimPanel(); } });
$('#origin').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) edit((p) => { p.origin = v; }); });
$('#part-vis').addEventListener('change', (e) => edit((p) => { p.visible = e.target.checked; }));
$('#part-up').addEventListener('click', () => edit((p, sim) => { const i = sim.parts.indexOf(p); if (i < sim.parts.length - 1) [sim.parts[i], sim.parts[i + 1]] = [sim.parts[i + 1], sim.parts[i]]; }));
$('#part-down').addEventListener('click', () => edit((p, sim) => { const i = sim.parts.indexOf(p); if (i > 0) [sim.parts[i], sim.parts[i - 1]] = [sim.parts[i - 1], sim.parts[i]]; }));
$('#btn-del').addEventListener('click', () => { const sim = S.sim, p = sim.selPart; if (!p) return; sim.begin(); sim.removePart(p); updateSimPanel(); S.dirty = true; });
// スライダー：動かし始めに1回だけ履歴に積む
let sliding = false;
for (const id of ['feather', 'strength']) {
  const el = $('#' + id);
  el.addEventListener('input', () => {
    const p = S.sim.selPart; if (!p) return;
    if (!sliding) { S.sim.begin(); sliding = true; }
    const v = id === 'feather' ? +el.value : +el.value / 100;
    p[id] = v; if (p.copy) p.copy[id] = v;
    p._ex = null; p._ox = null; S.sim.touch(); S.dirty = true;
  });
  el.addEventListener('change', () => { sliding = false; updateSimPanel(); });
}
$('#btn-copy').addEventListener('click', () => {
  const sim = S.sim, p = sim.selPart; if (!p) return;
  sim.begin();
  // 反対側に新しいパーツとして追加する（既にある反対側のパーツは置き換えない）
  const r = sim.copyPart(p);
  if (!r) { sim.cancel(); return; }
  updateSimPanel(); S.dirty = true;
});

// ---------------- 修正前の一時表示（押している間だけ） ----------------
holdButton($('#btn-before'), (v) => { S.before = v; });

// ======================================================================
// 設定
// ======================================================================
function updateSettings() {
  $$('[data-assist]').forEach((el) => (el.checked = !!settings.assist[el.dataset.assist]));
  $('#s-frame').value = Math.round(settings.frame * 100);
  $('#s-delay').value = String(settings.delay);
  $('#s-fps').value = String(settings.fps);
  const fps = cam.ready && cam.actualFps ? ` · ${cam.actualFps} コマ/秒` : '';
  $('#s-camera').textContent = cam.ready ? `${cam.label || '（名前なし）'}${fps}` : 'カメラを起動していません';
}
$$('[data-assist]').forEach((el) => el.addEventListener('change', () => { settings.assist[el.dataset.assist] = el.checked; save(); }));
$('#s-frame').addEventListener('input', (e) => { settings.frame = +e.target.value / 100; save(); });
$('#s-delay').addEventListener('change', (e) => { settings.delay = +e.target.value; save(); });
$('#s-fps').addEventListener('change', async (e) => { settings.fps = +e.target.value; save(); await cam.setFps(settings.fps); updateSettings(); });

// ======================================================================
// このアプリについて・版と更新
// ======================================================================
const aboutDlg = $('#about-dialog');
// 先頭から表示する（横向き等で高さが足りない場合。前に開いたときのスクロール位置を残さない）
$$('[data-about]').forEach((b) => b.addEventListener('click', () => {
  aboutDlg.showModal();
  aboutDlg.querySelectorAll('*').forEach((el) => { if (el.scrollTop) el.scrollTop = 0; });
  aboutDlg.scrollTop = 0;
}));
aboutDlg.addEventListener('click', (e) => { if (e.target === aboutDlg) aboutDlg.close(); });
$('#dlg').addEventListener('click', (e) => { if (e.target.id === 'dlg') e.target.close(''); });
$$('[data-app-version]').forEach((el) => (el.textContent = `v${APP_VERSION}`));

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  const bar = $('#update-bar');
  let waiting = null, reloading = false;
  const offer = (w) => { waiting = w; bar.hidden = false; };
  $('#update-now').addEventListener('click', () => {
    if (!waiting) return location.reload();
    $('#update-now').disabled = true;
    waiting.postMessage('skipWaiting');
  });
  $('#update-later').addEventListener('click', () => (bar.hidden = true));
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !waiting) return; // 初めて入ったときは読み込み直さない
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
}

// ======================================================================
// 起動
// ======================================================================
// 開発用（index.html?demo）：ブラウザの開発ツールから作業内容を確かめられるようにする
if (new URLSearchParams(location.search).has('demo')) window.dma = { S, settings };
history.replaceState({ s: 'home' }, '');
show('home');
if (settings.camIntroDone) startCamera();
else cam.setState('intro');
updateCamMsg();
requestAnimationFrame(loop);
// カメラが起動したら、起動時の案内とズームのボタンを出す
const _onState = cam.onState;
cam.onState = (s) => { _onState(s); if (S.screen === 'home') { updateBanner(); updateHome(); } };
