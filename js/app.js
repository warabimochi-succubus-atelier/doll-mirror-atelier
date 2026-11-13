// Doll Mirror Atelier：画面の切り替えと操作
// 画面：カメラ（ホーム）・顔位置設定・ミラー・シミュレーション（パーツ移動／形の変更）・設定・設置ガイド
// 仕様書「画面構成と操作の流れ」を参照

import * as G from './geom.js';
import * as IM from './imaging.js';
import { cam } from './camera.js';
import { settings, save, LINE_COLORS } from './settings.js';
import { Sim, PART_NAMES, pairName, partLabel, TARGETS, targetLabel } from './sim.js';
import { $, $$, esc, toast, choose } from './ui.js';
/* global APP_VERSION */

const DPR = () => Math.min(window.devicePixelRatio || 1, 2);
const TITLES = { face: '顔位置設定', mirror: 'ミラー', sim: 'シミュレーション', setup: '設置ガイド', settings: '設定' };
const hhmm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

// 作業内容（アプリを開いている間だけ保持する。端末には保存しない）
const S = {
  screen: 'home',
  mirrorCap: null,   // ミラーの取り込み画像 { canvas, w, h, angle, guides, time }
  sim: null,         // シミュレーション
  lastCap: null,     // 前回の取り込み画像（輪郭表示用。ミラー・シミュレーションのどちらかと共用）
  headMoved: false,  // ヘッドが動いた可能性がある（ミラーで取り直しを案内する）
  startupNote: true, // 起動時の「ヘッドが中心線に合っているか確認してください」
  mirror: { basis: 'left', which: 'before', adj: { x: 0, y: 0, s: 1, r: 0 } },
  face: { angle0: 0, loupe: true, focus: null },
  capturing: 0,      // 取り込み（待ち時間）中の番号。画面を離れたら取りやめる
  // シミュレーション画面
  tab: 'parts', view: null, before: false, mode: null, big: false, tBig: false,
  tSel: 'eyeL', brush: 45, lastBrush: null, kind: null, dirty: true,
  checks: { light: 0, sharp: null, t: 0 },
};
const edgeCache = new WeakMap();
const tintCache = {};
const edgesOf = (cv) => { let m = edgeCache.get(cv); if (!m) { m = IM.edgeMask(cv); edgeCache.set(cv, m); } return m; };

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
    const on = el.dataset.show.split(' ').includes(s);
    el.hidden = !on || (el.dataset.tabpanel ? el.dataset.tabpanel !== S.tab : false);
  });
  $('#bar-title').textContent = TITLES[s] || '';
  if (prev !== s) S.capturing++; // 待ち時間中に画面を移ったら取り込みをやめる
  S.mode = null;
  if (s === 'face') { S.face.angle0 = settings.angle; S.startupNote = false; updateFace(); }
  if (s === 'mirror') updateMirror();
  if (s === 'sim') { S.dirty = true; updateSimPanel(); }
  if (s === 'home') updateHome();
  if (s === 'settings') updateSettings();
  updateBanner();
  updateZoomButtons();
  $('#count').hidden = true;
}
function go(s) {
  if (s === S.screen) return;
  stack.push(S.screen);
  history.pushState({ s }, '');
  show(s);
}
async function back(fromPop = false) {
  if (S.screen === 'home') return;
  if (S.screen === 'face' && !(await leaveFace())) {
    if (fromPop) history.pushState({}, '');
    return;
  }
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

function updateCamMsg() {
  const m = $('#cam-msg');
  const st = cam.state;
  if (st === 'live') { m.hidden = true; return; }
  m.hidden = false;
  if (st === 'intro') {
    m.innerHTML = `<div class="box"><h2>カメラを使います</h2>
      <p>このアプリは、スタンドに固定したドールヘッドを背面カメラで映し続けて使います。カメラの映像・取り込んだ画像は端末の外に送らず、保存もしません。</p>
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
    if (S.mirrorCap || S.sim) S.headMoved = true;
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
function updateZoomButtons() {
  const z = $('#zoom');
  if (!cam.ready) { z.innerHTML = ''; return; }
  z.innerHTML = zoomChoices().map((v) => `<button data-z="${v}" class="${Math.abs(v - cam.zoom) < 0.01 ? 'on' : ''}">${v}×</button>`).join('');
}
async function setZoom(v) {
  if (Math.abs(v - cam.zoom) < 0.01) return;
  await cam.setZoom(v);
  settings.zoom = cam.zoom; save();
  if (S.mirrorCap || S.sim) { S.headMoved = true; toast('ズームを変えたため、ミラーの取り込み画像と重ならない場合があります。取り直してください'); }
  updateZoomButtons();
}
$('#zoom').addEventListener('click', (e) => { const b = e.target.closest('[data-z]'); if (b) setZoom(+b.dataset.z); });

// ---------------- 取り込み ----------------
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
/** 映像を取り込む（待ち時間の後。ピンぼけ・ブレのチェックは補助の表示の ON / OFF に関わらず行う） */
async function capture() {
  for (;;) {
    if (!cam.ready) { toast('カメラの映像がありません'); return null; }
    if (!(await countdown(settings.delay))) return null;
    const canvas = cam.grab();
    const val = IM.sharpness(canvas, frameRect(canvas.width, canvas.height));
    if (val < IM.SHARP_MIN) {
      const r = await choose({
        title: '画像がぼやけています',
        html: '<p>ピンぼけ、またはブレの可能性があります。端末とヘッドが動いていないこと、ピントが合っていることを確かめてから取り直してください。</p>',
        choices: [{ value: 'retry', label: '取り直す' }, { value: 'use', label: 'このまま使う' }],
      });
      if (r === 'retry') continue;
      if (r !== 'use') return null;
    }
    const cap = {
      canvas, w: canvas.width, h: canvas.height, angle: settings.angle, time: new Date(),
      guides: { eyeY: settings.eyeY, spacing: settings.spacing, frame: settings.frame },
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
function loop() {
  requestAnimationFrame(loop);
  if ($('#stage').hidden) return;
  fitCanvas();
  if (S.screen === 'sim') { if (S.dirty && S.sim) { S.dirty = false; drawSim(); } return; }
  drawLive();
}

/** 線を引く（画面の座標） */
function line(a, b, color, w = 1.5, dash = null) {
  ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  ctx.strokeStyle = color; ctx.lineWidth = w * DPR(); ctx.setLineDash(dash ? dash.map((d) => d * DPR()) : []); ctx.stroke(); ctx.setLineDash([]);
}

/** 中心線と合わせ用ガイド（目の高さの線・目頭マーク・鼻先と口の目安）。M：映像の座標 → 画面の座標 */
function drawGuides(M, fw, fh, angle, full = true) {
  const ax = G.axis(fw, fh, angle);
  const P = (a, s) => G.ap(M, G.fromAxis(ax, a, s));
  const L = Math.max(fw, fh);
  line(P(-L, 0), P(L, 0), 'rgba(143,211,255,.95)', 1.5, [8, 6]);
  if (!full) return;
  const eye = (settings.eyeY - 0.5) * fh, sp = settings.spacing * fw, tick = fh * 0.022;
  line(P(eye, -fw * 0.42), P(eye, fw * 0.42), 'rgba(255,211,107,.9)', 1.2, [4, 4]);
  for (const s of [-1, 1]) line(P(eye - tick, s * sp / 2), P(eye + tick, s * sp / 2), '#ffd36b', 3);
  // 鼻先・口の中央が中心線上に来ることを示す目安
  const k = G.scaleOf(M);
  ctx.strokeStyle = 'rgba(143,211,255,.95)'; ctx.lineWidth = 1.5 * DPR();
  const n = P(eye + sp * 0.95, 0);
  ctx.beginPath(); ctx.arc(n[0], n[1], Math.max(4 * DPR(), sp * 0.09 * k), 0, Math.PI * 2); ctx.stroke();
  for (const s of [-1, 1]) line(P(eye + sp * 1.65, s * sp * 0.22), P(eye + sp * 1.65, s * sp * 0.08), 'rgba(143,211,255,.95)', 2);
}
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
  ctx.drawImage(v, c.sx, c.sy, c.sw, c.sh, d.x, d.y, d.w, d.h);
  const fw = c.sw, fh = c.sh, V = [d.s, 0, 0, d.s, d.x, d.y];
  S.live = { V, fw, fh };
  const a = settings.assist;

  if (S.screen === 'home') {
    if (a.edge && S.lastCap) drawCapEdges(S.lastCap, V, fw, settings.edgeAlpha);
    if (a.frame) drawFrameGuide(V, fw, fh, settings.angle);
    if (a.center) drawGuides(V, fw, fh, settings.angle);
    runChecks(c);
  } else if (S.screen === 'face') {
    drawFrameGuide(V, fw, fh, settings.angle);
    drawGuides(V, fw, fh, settings.angle);
    if (S.face.loupe) drawLoupe(V, fw, fh, c);
  } else if (S.screen === 'mirror') {
    drawMirror(V, fw, fh);
  }
}

function drawCapEdges(cap, V, fw, alpha) {
  const k = fw / cap.w;
  ctx.save();
  ctx.globalAlpha = 1 - alpha / 100;
  ctx.setTransform(...G.mul(V, G.S(k)));
  ctx.drawImage(IM.tintEdges(edgesOf(cap.canvas), settings.lineColor, tintCache), 0, 0, cap.w, cap.h);
  ctx.restore();
}

/** ルーペ：映像の一部を拡大して、目頭・鼻先と線の重なりを確かめる */
function drawLoupe(V, fw, fh, c) {
  const W = cv.width, R = Math.min(W, cv.height) * 0.2;
  const ax = G.axis(fw, fh, settings.angle);
  const f = S.face.focus || G.fromAxis(ax, (settings.eyeY - 0.5) * fh, 0);
  const fs = G.ap(V, f);
  const center = [fs[0] > W / 2 ? R + 12 * DPR() : W - R - 12 * DPR(), R + 12 * DPR()];
  const Z = 3;
  const M = G.mul(G.T(center[0], center[1]), G.S(Z), G.T(-fs[0], -fs[1]), V);
  ctx.save();
  ctx.beginPath(); ctx.arc(center[0], center[1], R, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = '#111'; ctx.fillRect(center[0] - R, center[1] - R, 2 * R, 2 * R);
  ctx.setTransform(...M);
  ctx.drawImage(cam.video, c.sx, c.sy, c.sw, c.sh, 0, 0, fw, fh);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  drawGuides(M, fw, fh, settings.angle);
  ctx.restore();
  ctx.beginPath(); ctx.arc(center[0], center[1], R, 0, Math.PI * 2);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * DPR(); ctx.stroke();
}

/** ミラー：取り込み画像の基準の側を中心線で反転し、反対側の半分にだけ重ねる */
function drawMirror(V, fw, fh) {
  const which = S.mirror.which === 'after' && S.sim ? 'after' : 'before';
  const cap = which === 'after' ? S.sim.cap : S.mirrorCap;
  if (!cap) return;
  const img = which === 'after' ? S.sim.full() : cap.canvas;
  const Vc = G.mul(V, G.S(fw / cap.w));
  const ax = G.axis(cap.w, cap.h, cap.angle);
  const a = S.mirror.adj;
  const adj = G.mul(G.T(ax.c[0] + a.x * cap.w, ax.c[1] + a.y * cap.w), G.R(a.r * G.DEG), G.S(a.s), G.T(-ax.c[0], -ax.c[1]));
  // 左基準：ドールの左顔（画面右側）を反転して画面左側へ。右基準はその逆
  const side = S.mirror.basis === 'left' ? -1 : 1;
  const poly = G.halfPlane(ax, side, Math.max(cap.w, cap.h) * 2).map((p) => G.ap(Vc, p));
  ctx.save();
  ctx.beginPath(); poly.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.clip();
  ctx.globalAlpha = 1 - settings.mirrorAlpha / 100;
  ctx.setTransform(...G.mul(Vc, adj, G.reflectM(ax)));
  if (settings.mirrorMode === 'edge') ctx.drawImage(IM.tintEdges(edgesOf(img), settings.lineColor, tintCache), 0, 0, cap.w, cap.h);
  else ctx.drawImage(img, 0, 0);
  ctx.restore();
  if (settings.assist.center) drawGuides(Vc, cap.w, cap.h, cap.angle, false);
}

// ---------------- 照明の左右差・ピンぼけのチェック（一定間隔で行う） ----------------
const checkCanvas = IM.canvas(1, 1);
function runChecks(c) {
  const now = performance.now();
  if (now - S.checks.t < 500) return;
  S.checks.t = now;
  const a = settings.assist;
  if (!a.light && !a.sharp) { renderChips(); return; }
  const s = Math.min(1, 400 / Math.max(c.sw, c.sh));
  checkCanvas.width = Math.round(c.sw * s); checkCanvas.height = Math.round(c.sh * s);
  checkCanvas.getContext('2d', { willReadFrequently: true }).drawImage(cam.video, c.sx, c.sy, c.sw, c.sh, 0, 0, checkCanvas.width, checkCanvas.height);
  S.checks.light = a.light ? IM.lightBalance(checkCanvas, checkCanvas.width, checkCanvas.height, { angle: settings.angle, eyeY: settings.eyeY, frame: settings.frame }) : 0;
  S.checks.sharp = a.sharp ? IM.sharpness(checkCanvas, frameRect(checkCanvas.width, checkCanvas.height)) : null;
  renderChips();
}
function renderChips() {
  const chips = [];
  if (S.screen === 'home') {
    const a = settings.assist, l = S.checks.light;
    if (a.light && Math.abs(l) > IM.LIGHT_DIFF) chips.push(`<span class="pill warn">${l > 0 ? 'ドールの右側（画面左側）' : 'ドールの左側（画面右側）'}が暗めです</span>`);
    if (a.sharp && S.checks.sharp != null && S.checks.sharp < IM.SHARP_MIN) chips.push('<span class="pill warn">ピンぼけ・ブレの可能性があります</span>');
  }
  if (S.screen === 'face') chips.push(`<span class="pill">中心線の角度 <b class="mono">${fmtAngle(settings.angle)}</b></span>`);
  if (S.screen === 'mirror' && (S.mirrorCap || S.sim)) {
    chips.push(`<span class="pill">${S.mirror.basis === 'left' ? '左基準：ドールの左顔（画面右側）を反転' : '右基準：ドールの右顔（画面左側）を反転'}</span>`);
    chips.push(`<span class="pill">${S.mirror.which === 'after' && S.sim ? '修正後' : '修正前'}</span>`);
  }
  if (S.screen === 'sim' && S.sim) {
    if (S.before) chips.push('<span class="pill bad">修正前を表示中</span>');
    if (S.tab === 'parts') {
      const p = S.sim.selPart;
      if (S.mode === 'lasso') chips.push('<span class="pill">指でなぞって、パーツにする範囲を囲んでください</span>');
      else if (S.mode === 'relasso') chips.push('<span class="pill">選択範囲を囲み直してください</span>');
      else if (S.mode === 'redest') chips.push('<span class="pill">コピー先の範囲を囲み直してください</span>');
      else if (S.mode === 'pivot') chips.push('<span class="pill">回転の支点にする位置をタップしてください</span>');
      else if (p) chips.push(`<span class="pill">${esc(partLabel(p.name))}を編集中</span>`);
    } else {
      chips.push(`<span class="pill">${esc(targetLabel(S.sim.tdef(S.tSel)))}</span>`);
      if (S.kind) chips.push(`<span class="pill ${S.kind === '削り' ? 'cut' : 'putty'}">${S.kind}</span>`);
      if (S.mode === 'area') chips.push('<span class="pill">影響範囲をドラッグで動かします</span>');
    }
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
    t.textContent = 'ヘッドが中心線に合っているか確認してください';
    act.innerHTML = '<button class="btn btn-primary btn-s" data-go="face">顔位置設定へ</button>';
    show = true;
  } else if (S.screen === 'mirror' && S.headMoved && (S.mirrorCap || S.sim)) {
    t.textContent = 'ヘッドの位置が変わっている場合は取り直してください（表示方法「輪郭のみ」で重なりを確かめられます）';
    show = true;
  }
  b.hidden = !show;
}
$('#banner-x').addEventListener('click', () => {
  if (S.screen === 'home') S.startupNote = false;
  if (S.screen === 'mirror') S.headMoved = false;
  updateBanner();
});

// ======================================================================
// カメラ（ホーム）
// ======================================================================
function updateHome() {
  const has = !!S.lastCap;
  $('#btn-edge').disabled = !has;
  $('#btn-edge').setAttribute('aria-pressed', String(has && settings.assist.edge));
  $('#edge-hint').textContent = has ? `前回の取り込み画像（${hhmm(S.lastCap.time)}）` : '前回の取り込み画像がありません';
  $('#edge-alpha-row').hidden = !(has && settings.assist.edge);
  $('#edge-alpha').value = settings.edgeAlpha;
  $('#edge-alpha-v').textContent = `${settings.edgeAlpha}%`;
  $('#home-hint').textContent = cam.wakeSupported ? '補助の ON / OFF は設定から' : 'この端末は画面の消灯を止められません。自動ロックの時間を長くしてください';
  renderChips();
}
$('#btn-edge').addEventListener('click', () => { settings.assist.edge = !settings.assist.edge; save(); updateHome(); });
$('#edge-alpha').addEventListener('input', (e) => { settings.edgeAlpha = +e.target.value; save(); updateHome(); });
$('#btn-mirror').addEventListener('click', () => openMirror());
$('#btn-sim').addEventListener('click', () => openSim());

// ---------------- 水準器 ----------------
const level = { roll: 0, pitch: 0, seen: false, on: false };
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
}
function startLevel() {
  if (level.on) return;
  level.on = true;
  window.addEventListener('devicemotion', onMotion);
  setTimeout(() => { if (!level.seen) level.none = true; }, 1500);
}
function updateLevel() {
  const el = $('#level'), ask = $('#level-ask');
  const want = settings.assist.level && S.screen === 'home';
  const needAsk = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function' && !level.on;
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
    if (r === 'granted') startLevel();
    else toast('モーションセンサーが許可されなかったため、水準器は使えません');
  } catch { toast('水準器を使えませんでした'); }
});
setInterval(updateLevel, 120);

// ======================================================================
// 顔位置設定
// ======================================================================
function updateFace() {
  $('#angle-v').textContent = fmtAngle(settings.angle);
  $('#btn-loupe').setAttribute('aria-pressed', String(S.face.loupe));
  renderChips();
}
$$('[data-angle]').forEach((b) => b.addEventListener('click', () => {
  settings.angle = Math.round(G.clamp(settings.angle + +b.dataset.angle, -10, 10) * 10) / 10; save(); updateFace();
}));
$('#btn-angle0').addEventListener('click', () => { settings.angle = 0; save(); updateFace(); });
$$('[data-eye]').forEach((b) => b.addEventListener('click', () => { settings.eyeY = G.clamp(settings.eyeY + +b.dataset.eye, 0.15, 0.85); save(); }));
$$('[data-sp]').forEach((b) => b.addEventListener('click', () => { settings.spacing = G.clamp(settings.spacing + +b.dataset.sp, 0.02, 0.45); save(); }));
$('#btn-loupe').addEventListener('click', () => { S.face.loupe = !S.face.loupe; updateFace(); });
$('#btn-face-help').addEventListener('click', () => choose({ title: '合わせ方', html: $('#face-help').innerHTML, cancel: '閉じる' }));
$('#btn-face-done').addEventListener('click', () => back());

/** 顔位置設定を閉じる前：角度を変えた場合に、既にある取り込み画像に適用するかを選ぶ。false なら閉じない */
async function leaveFace() {
  const a0 = S.face.angle0, a1 = settings.angle;
  if (Math.abs(a0 - a1) < 0.001 || !(S.mirrorCap || S.sim)) return true;
  const r = await choose({
    title: '取り込み画像にも適用しますか',
    html: `<p>中心線の角度を <b class="mono">${fmtAngle(a0)} → ${fmtAngle(a1)}</b> に変えました。ミラー・シミュレーションの取り込み画像があります。</p>`,
    choices: [
      { value: 'apply', label: '取り込み画像にも適用する', desc: 'ヘッドを動かさず、角度の合わせ方だけを直した場合。ミラーの反転と左右コピーを計算し直します（操作の履歴は残ります）。' },
      { value: 'keep', label: '適用しない', desc: 'ヘッドを付け直した・スタンドを動かした場合。取り込み画像はそのまま使います。取り直しをおすすめします。' },
    ],
    cancel: '顔位置設定に戻る',
  });
  if (!r) return false;
  if (r === 'apply') {
    if (S.mirrorCap) S.mirrorCap.angle = a1;
    if (S.sim) S.sim.setAngle(a1);
  } else {
    S.headMoved = true;
    toast('取り込み画像はそのままです。ミラーは取り直しをおすすめします');
  }
  return true;
}

// ======================================================================
// ミラー
// ======================================================================
async function openMirror(which) {
  if (which) S.mirror.which = which;
  go('mirror');
  if (!S.mirrorCap) {
    const cap = await capture();
    if (!cap) { if (S.screen === 'mirror' && !S.mirrorCap) back(); return; }
    S.mirrorCap = cap; S.headMoved = false;
  }
  updateMirror();
}
function setSeg(sel, v) { $$(`${sel} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === v)); }
function updateMirror() {
  if (!S.sim && S.mirror.which === 'after') S.mirror.which = 'before';
  setSeg('#m-basis', S.mirror.basis);
  setSeg('#m-which', S.mirror.which);
  $('#m-which [data-v=after]').disabled = !S.sim;
  setSeg('#m-mode', settings.mirrorMode);
  $('#m-colors-row').hidden = settings.mirrorMode !== 'edge';
  renderSwatches($('#m-colors'));
  $('#m-alpha').value = settings.mirrorAlpha;
  $('#m-alpha-v').textContent = `${settings.mirrorAlpha}%`;
  const note = $('#m-after-note');
  if (S.mirror.which === 'after' && S.sim) {
    const msgs = [];
    const basisSide = S.mirror.basis === 'left' ? 1 : -1;
    const other = S.sim.parts.some((p) => p.visible && S.sim.partSide(p) === -basisSide)
      || S.sim.deformedTargets().some((t) => (S.sim.tdef(t.id).side || 0) === -basisSide || t.id === 'jaw');
    if (other) msgs.push('基準でない側の修正は表示されません。両側の修正をあわせて見るには、シミュレーション画面を使ってください。');
    msgs.push(`修正後の画像は、シミュレーション開始時（${hhmm(S.sim.cap.time)}）の取り込み画像がもとです。その後に進めたメイク・削り・パテ盛りは反映されません。`);
    note.innerHTML = msgs.map(esc).join('<br>');
    note.hidden = false;
  } else note.hidden = true;
  renderChips();
  updateBanner();
}
$('#m-basis').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { S.mirror.basis = v; updateMirror(); } });
$('#m-which').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v && !e.target.closest('button').disabled) { S.mirror.which = v; updateMirror(); } });
$('#m-mode').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) { settings.mirrorMode = v; save(); updateMirror(); } });
$('#m-alpha').addEventListener('input', (e) => { settings.mirrorAlpha = +e.target.value; save(); $('#m-alpha-v').textContent = `${settings.mirrorAlpha}%`; });
$('#m-adj').addEventListener('click', (e) => {
  const k = e.target.closest('[data-adj]')?.dataset.adj; if (!k) return;
  const a = S.mirror.adj, sg = k[1] === '+' ? 1 : -1;
  if (k[0] === 'x') a.x += 0.0015 * sg; else if (k[0] === 'y') a.y += 0.0015 * sg;
  else if (k[0] === 's') a.s = G.clamp(a.s * (1 + 0.004 * sg), 0.8, 1.25); else a.r += 0.2 * sg;
});
$('#m-adj0').addEventListener('click', () => { S.mirror.adj = { x: 0, y: 0, s: 1, r: 0 }; });
$('#btn-retake').addEventListener('click', async () => {
  const cap = await capture();
  if (!cap) return;
  S.mirrorCap = cap; S.headMoved = false;
  toast('取り直しました');
  updateMirror();
});
$('#btn-m-sim').addEventListener('click', () => openSim());

function renderSwatches(el) {
  el.innerHTML = LINE_COLORS.map(([c, n]) => `<button class="swatch ${c === settings.lineColor ? 'on' : ''}" style="background:${c}" data-c="${c}" title="${n}" aria-label="${n}"></button>`).join('');
}
document.addEventListener('click', (e) => {
  const sw = e.target.closest('.swatch[data-c]');
  if (!sw) return;
  settings.lineColor = sw.dataset.c; save();
  $$('.swatches').forEach(renderSwatches);
});

// ======================================================================
// シミュレーション
// ======================================================================
async function openSim() {
  if (S.sim && S.sim.hasContent) {
    const sim = S.sim, nParts = sim.parts.length, nT = sim.deformedTargets().length;
    const r = await choose({
      title: 'シミュレーション',
      html: `<p>前回のシミュレーション（パーツ ${nParts}つ・形の変更 ${nT}か所、${hhmm(sim.cap.time)} に取り込み）があります。</p>`,
      choices: [
        { value: 'continue', label: '続きから', desc: '前回の取り込み画像と、パーツ移動・形の変更、取り消しの履歴をそのまま使います。' },
        { value: 'new', label: '取り直して新しく始める', desc: '今の映像を取り込みます。前回のパーツ移動・形の変更と履歴は消えます。' },
      ],
    });
    if (r === 'continue') { go('sim'); return; }
    if (r !== 'new') return;
    const ok = await choose({
      title: '前回のシミュレーションを消しますか',
      html: '<p>パーツ移動・形の変更と、取り消しの履歴が消えます。元に戻せません。</p>',
      choices: [{ value: 'yes', label: '消して取り直す', danger: true }],
    });
    if (ok !== 'yes') return;
  }
  if (S.screen !== 'home' && S.screen !== 'mirror') return;
  const cap = await capture();
  if (!cap) return;
  S.sim = new Sim(cap);
  S.view = null; S.tab = 'parts'; S.tSel = 'eyeL'; S.lastBrush = null; S.kind = null;
  go('sim');
}
$('#btn-sim-mirror').addEventListener('click', () => openMirror('after'));
$$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
  S.tab = b.dataset.tab; S.mode = null;
  $$('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  $$('[data-tabpanel]').forEach((p) => (p.hidden = p.dataset.tabpanel !== S.tab));
  updateSimPanel();
}));

// ---------------- 表示（拡大・移動） ----------------
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
$('#btn-fit').addEventListener('click', () => S.sim && fitView());

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
  if (S.tab === 'parts') {
    const p = sim.selPart;
    for (const q of sim.parts) if (q !== p && q.visible) outlinePart(q, V, 'rgba(255,255,255,.45)', [3, 3]);
    if (p) {
      // コピー先の範囲（元の位置の処理をする範囲）
      if (p.copy) polyPath(sim.warp(sim.destPoly(p)).map((q) => G.ap(V, q)), 'rgba(255,211,107,.8)', [4, 3]);
      else polyPath(sim.warp(p.poly).map((q) => G.ap(V, q)), 'rgba(255,255,255,.7)', [4, 3]);
      outlinePart(p, V, '#e08ba1', null);
      const { piv } = sim.frame(p);
      const c = G.ap(V, [piv[0] + p.t.tx, piv[1] + p.t.ty]), r = 6 * DPR();
      ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2 * DPR();
      ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, Math.PI * 2); ctx.stroke();
      line([c[0] - 2 * r, c[1]], [c[0] + 2 * r, c[1]], '#ffd36b', 2); line([c[0], c[1] - 2 * r], [c[0], c[1] + 2 * r], '#ffd36b', 2);
    }
  } else {
    const t = sim.target(S.tSel);
    sim.eff(t);
    const c = G.ap(V, [t.cx, t.cy]), R = t.R * S.view.s;
    ctx.beginPath(); ctx.arc(c[0], c[1], R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(143,211,255,.10)'; ctx.fill();
    ctx.strokeStyle = S.mode === 'area' ? '#ffd36b' : '#8fd3ff'; ctx.lineWidth = 1.5 * DPR(); ctx.setLineDash([5 * DPR(), 4 * DPR()]); ctx.stroke(); ctx.setLineDash([]);
    if (S.lastBrush && S.mode !== 'area') {
      const b = G.ap(V, S.lastBrush);
      ctx.beginPath(); ctx.arc(b[0], b[1], brushRadius(t) * S.view.s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,211,107,.9)'; ctx.lineWidth = 1.5 * DPR(); ctx.stroke();
    }
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
const brushRadius = (t) => (t.R * S.brush) / 100;

// ---------------- 画面の操作（ドラッグ・ピンチ） ----------------
// 1本指：パーツの上ならパーツを動かす、影響範囲の中なら輪郭を押す、それ以外は画面を動かす
// 2本指：パーツを動かしている途中ならパーツの回転・拡大縮小、それ以外は画面の拡大・移動
const pts = new Map();
const G_ = { kind: null, lasso: null };
const stage = $('#stage');
const evPos = (e) => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * DPR(), (e.clientY - r.top) * DPR()]; };

stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.ov, button')) return;
  const p = evPos(e);
  if (S.screen === 'face') { if (S.live) S.face.focus = G.ap(G.inv(S.live.V), p); return; }
  if (S.screen !== 'sim' || !S.sim || S.before) return;
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
    if (S.tab === 'parts') {
      const hit = sim.selPart && sim.hit(sim.selPart, q) ? sim.selPart : [...sim.parts].reverse().find((x) => x.visible && sim.hit(x, q));
      if (hit) {
        if (sim.sel !== hit.id) { sim.sel = hit.id; updateSimPanel(); }
        sim.begin(); G_.kind = 'part'; G_.t0 = { ...hit.t }; G_.q0 = q;
        S.dirty = true; return;
      }
    } else {
      const t = sim.target(S.tSel);
      sim.eff(t);
      const inside = Math.hypot(q[0] - t.cx, q[1] - t.cy) < t.R;
      if (inside && S.mode === 'area') { sim.begin(); G_.kind = 'area'; G_.c0 = [t.cx, t.cy]; G_.q0 = q; return; }
      if (inside) { sim.begin(); G_.kind = 'brush'; G_.qLast = q; G_.sum = 0; S.lastBrush = q; S.dirty = true; return; }
    }
    G_.kind = 'pan';
  } else if (pts.size === 2) {
    const [a, b] = [...pts.values()];
    G_.p0 = { a, b, d: Math.hypot(b[0] - a[0], b[1] - a[1]), ang: Math.atan2(b[1] - a[1], b[0] - a[0]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    if (G_.kind === 'part') { G_.kind = 'partPinch'; G_.t0 = { ...sim.selPart.t }; }
    else {
      if (G_.kind === 'brush' || G_.kind === 'area') { if (!G_.moved) sim.cancel(); }
      G_.kind = 'pinch'; G_.lasso = null; G_.v0 = { ...S.view };
    }
  }
});
stage.addEventListener('pointermove', (e) => {
  if (!pts.has(e.pointerId)) return;
  const p = evPos(e);
  pts.set(e.pointerId, p);
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
    } else if (G_.kind === 'brush') {
      const t = sim.target(S.tSel);
      const d = [q[0] - G_.qLast[0], q[1] - G_.qLast[1]];
      if (Math.hypot(...d) > 0.5) {
        sim.brush(t, G_.qLast, d, brushRadius(t));
        noteKind(t, G_.qLast, d);
        G_.qLast = q; S.lastBrush = q; S.dirty = true;
      }
    } else if (G_.kind === 'area') {
      const t = sim.target(S.tSel);
      sim.moveTarget(t, G_.c0[0] + q[0] - G_.q0[0], G_.c0[1] + q[1] - G_.q0[1], t.R); S.dirty = true;
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
  const sim = S.sim;
  if (!sim) return;
  if (pts.size === 1 && (G_.kind === 'pinch' || G_.kind === 'partPinch')) {
    // 2本指のうち1本を離した：残りの指では画面の移動だけにする
    if (G_.kind === 'partPinch') { updateSimPanel(); }
    G_.kind = 'none'; G_.p0 = null;
    return;
  }
  if (pts.size > 0) return;
  const k = G_.kind;
  G_.kind = null; G_.p0 = null;
  if (k === 'lasso') finishLasso();
  else if (k === 'part' || k === 'brush' || k === 'area') { if (!G_.moved) sim.cancel(); updateSimPanel(); }
  else if (k === 'partPinch') updateSimPanel();
  S.dirty = true;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', endPointer);
stage.addEventListener('wheel', (e) => {
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

/** ドラッグの向きから「削り」「パテ盛り」を判定する */
function noteKind(t, at, d) {
  const def = S.sim.tdef(t.id);
  const c = def.kind === 'eye' ? [t.cx, t.cy] : S.sim.ax.c;
  const out = [at[0] - c[0], at[1] - c[1]], n = Math.hypot(...out) || 1;
  const dot = (d[0] * out[0] + d[1] * out[1]) / n;
  G_.sum = (G_.sum || 0) + dot;
  // アイホールを広げる・頬やあごを内側へ引き込む＝削り。頬・あごを外側へ押し広げる・アイホールを狭める＝パテ盛り
  const outward = G_.sum > 0;
  S.kind = def.kind === 'eye' ? (outward ? '削り' : 'パテ盛り') : (outward ? 'パテ盛り' : '削り');
}

async function finishLasso() {
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
    else { if (p.copy) p.copy.poly = poly; else p.poly = poly; p._ex = null; p._ox = null; }
    sim.touch(); updateSimPanel(); S.dirty = true;
    return;
  }
  const name = await pickName(sim.suggestName(poly), null);
  if (!name) { updateSimPanel(); S.dirty = true; return; }
  sim.begin();
  sim.addPart(poly, name);
  updateSimPanel(); S.dirty = true;
}
async function pickName(value, exceptId) {
  const r = await choose({
    title: 'パーツの名前',
    html: '<p>名前は左右コピーのコピー先を決めるのにも使います。同じ名前のパーツは1つまでです（「その他」を除く）。</p>',
    select: { options: PART_NAMES.map((n) => [n, partLabel(n), !S.sim.nameFree(n, exceptId)]), value },
    ok: '決定',
  });
  return r?.selected || null;
}

// ---------------- パネル（パーツ移動） ----------------
function updateSimPanel() {
  const sim = S.sim;
  if (!sim) return;
  $$('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x.dataset.tab === S.tab));
  $$('[data-tabpanel]').forEach((x) => (x.hidden = S.screen !== 'sim' || x.dataset.tabpanel !== S.tab));
  $('#btn-undo').disabled = !sim.undoStack.length;
  $('#btn-redo').disabled = !sim.redoStack.length;
  if (S.tab === 'parts') {
    $('#parts').innerHTML = sim.parts.map((p) => `<button class="part ${p.id === sim.sel ? 'on' : ''} ${p.visible ? '' : 'off'}" data-id="${p.id}">${esc(partLabel(p.name))}</button>`).join('');
    $('#parts-empty').hidden = sim.parts.length > 0;
    $('#btn-lasso').setAttribute('aria-pressed', String(S.mode === 'lasso'));
    const p = sim.selPart;
    $('#part-ctl').hidden = !p;
    if (p) {
      $('#part-name').innerHTML = PART_NAMES.map((n) => `<option value="${esc(n)}" ${n === p.name ? 'selected' : ''} ${sim.nameFree(n, p.id) ? '' : 'disabled'}>${esc(partLabel(n))}</option>`).join('');
      $('#part-vis').textContent = p.visible ? '非表示' : '表示';
      const i = sim.parts.indexOf(p);
      $('#part-up').disabled = i === sim.parts.length - 1;
      $('#part-down').disabled = i === 0;
      setSeg('#origin', p.origin);
      $('#origin-lbl').textContent = p.copy ? 'コピー先' : '元の位置';
      $('#feather').value = p.feather;
      $('#strength').value = Math.round(p.strength * 100);
      const pn = pairName(p.name);
      $('#btn-copy').textContent = pn ? `${partLabel(pn)}へ左右コピー` : '左右コピーの対象外';
      $('#btn-copy').disabled = !pn;
      $('#btn-pivot').setAttribute('aria-pressed', String(S.mode === 'pivot'));
      $('#btn-relasso').textContent = p.copy ? 'コピー先を囲み直す' : '囲み直す';
      $('#step-size').textContent = S.big ? '大' : '小';
      const notes = [];
      if (p.copy) notes.push(`${p.destAuto ? 'コピー先の範囲は、コピー元を中心線で反転した位置に自動で決めています。' : 'コピー先の範囲は囲み直した範囲です。'}「コピー先」で、コピー先の既存メイクを残す・薄くする・消すを選べます。`);
      if (!p.visible) notes.push('非表示のパーツは、ミラーの修正後の画像にも含めません。');
      $('#part-note').textContent = notes.join(' ');
    }
  } else {
    $('#t-sel').innerHTML = TARGETS.map((d) => `<option value="${d.id}" ${d.id === S.tSel ? 'selected' : ''}>${esc(targetLabel(d))}${IMgridOn(d.id) ? '　●' : ''}</option>`).join('');
    const d = sim.tdef(S.tSel);
    $('#t-brush').value = S.brush;
    $('#t-size-row').hidden = d.kind !== 'eye';
    $('#t-step').textContent = S.tBig ? '大' : '小';
    if (d.id === 'jaw') {
      $('#t-copy').textContent = '画面右側の半分を左側へ'; $('#t-copy').dataset.side = '1';
      $('#t-copy2').textContent = '画面左側の半分を右側へ'; $('#t-copy2').dataset.side = '-1'; $('#t-copy2').hidden = false;
    } else {
      $('#t-copy').textContent = `${targetLabel(sim.tdef(d.pair))}へ左右コピー`; delete $('#t-copy').dataset.side;
      $('#t-copy2').hidden = true;
    }
    $('#t-area').setAttribute('aria-pressed', String(S.mode === 'area'));
    $('#t-area-row').hidden = S.mode !== 'area';
    const moved = sim.partsInDeform();
    $('#t-parts-note').hidden = !moved.length;
    $('#t-parts-note').textContent = moved.length ? `${moved.map((p) => `「${partLabel(p.name)}」`).join('')}は、形の変更に合わせて動きました。` : '';
  }
  renderChips();
}
const IMgridOn = (id) => { const t = S.sim.target(id); return !IM.gridIsZero(S.sim.eff(t)); };

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
// 微調整：1回の量は画像上の実寸ではなく、表示倍率に応じた一定の見た目の量
$('#step-size').addEventListener('click', () => { S.big = !S.big; updateSimPanel(); });
$$('[data-mv]').forEach((b) => b.addEventListener('click', () => edit((p) => {
  const [dx, dy] = b.dataset.mv.split(',').map(Number), st = ((S.big ? 8 : 1.5) * DPR()) / S.view.s;
  p.t.tx += dx * st; p.t.ty += dy * st;
})));
$$('[data-rot]').forEach((b) => b.addEventListener('click', () => edit((p) => { p.t.rot += +b.dataset.rot * (S.big ? 2 : 0.5) * G.DEG; })));
$$('[data-sc]').forEach((b) => b.addEventListener('click', () => edit((p) => {
  const f = 1 + +b.dataset.sc * (S.big ? 0.05 : 0.01), dir = $('#sc-dir').value;
  if (dir !== 'thk') p.t.sl = G.clamp(p.t.sl * f, 0.2, 5);
  if (dir !== 'len') p.t.st = G.clamp(p.t.st * f, 0.2, 5);
})));
$('#origin').addEventListener('click', (e) => { const v = e.target.closest('button')?.dataset.v; if (v) edit((p) => { p.origin = v; }); });
$('#part-vis').addEventListener('click', () => edit((p) => { p.visible = !p.visible; }));
$('#part-up').addEventListener('click', () => edit((p, sim) => { const i = sim.parts.indexOf(p); if (i < sim.parts.length - 1) [sim.parts[i], sim.parts[i + 1]] = [sim.parts[i + 1], sim.parts[i]]; }));
$('#part-down').addEventListener('click', () => edit((p, sim) => { const i = sim.parts.indexOf(p); if (i > 0) [sim.parts[i], sim.parts[i - 1]] = [sim.parts[i - 1], sim.parts[i]]; }));
$('#part-name').addEventListener('change', (e) => edit((p) => { p.name = e.target.value; }));
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
$('#btn-copy').addEventListener('click', async () => {
  const sim = S.sim, p = sim.selPart; if (!p) return;
  sim.begin();
  let r = sim.copyPart(p, false);
  if (r?.conflict) {
    const name = pairName(p.name);
    const a = await choose({
      title: `「${partLabel(name)}」は既にあります`,
      html: `<p>${esc(partLabel(p.name))}をコピーすると、${esc(partLabel(name))}のパーツができます。既にある${esc(partLabel(name))}のパーツをどうしますか。</p>`,
      choices: [{ value: 'replace', label: '置き換える', desc: `既にある${partLabel(name)}のパーツを削除し、コピーしたパーツにします。` }],
      cancel: 'やめる',
    });
    if (a !== 'replace') { sim.cancel(); return; }
    r = sim.copyPart(p, true);
  }
  if (!r) { sim.cancel(); return; }
  toast(`${partLabel(r.name)}のパーツを追加しました`);
  updateSimPanel(); S.dirty = true;
});

// ---------------- パネル（形の変更） ----------------
$('#t-sel').addEventListener('change', (e) => { S.tSel = e.target.value; S.lastBrush = null; S.kind = null; S.mode = null; updateSimPanel(); S.dirty = true; });
$('#t-brush').addEventListener('input', (e) => { S.brush = +e.target.value; S.dirty = true; });
$('#t-step').addEventListener('click', () => { S.tBig = !S.tBig; updateSimPanel(); });
function tEdit(f) { const sim = S.sim, t = sim.target(S.tSel); sim.begin(); f(t, sim); updateSimPanel(); S.dirty = true; }
$$('[data-tsc]').forEach((b) => b.addEventListener('click', () => tEdit((t, sim) => {
  sim.scaleTarget(t, +b.dataset.tsc * (S.tBig ? 0.06 : 0.02));
  S.kind = +b.dataset.tsc > 0 ? '削り' : 'パテ盛り';
})));
$$('[data-push]').forEach((b) => b.addEventListener('click', () => tEdit((t, sim) => {
  sim.eff(t);
  const [dx, dy] = b.dataset.push.split(',').map(Number), st = ((S.tBig ? 8 : 2) * DPR()) / S.view.s;
  const at = S.lastBrush || [t.cx, t.cy];
  G_.sum = 0;
  sim.brush(t, at, [dx * st, dy * st], brushRadius(t));
  noteKind(t, at, [dx, dy]);
  S.lastBrush = at;
})));
$$('[data-tr]').forEach((b) => b.addEventListener('click', () => tEdit((t, sim) => { sim.eff(t); sim.moveTarget(t, t.cx, t.cy, t.R * (+b.dataset.tr > 0 ? 1.1 : 1 / 1.1)); })));
$('#t-area').addEventListener('click', () => { S.mode = S.mode === 'area' ? null : 'area'; updateSimPanel(); S.dirty = true; });
$('#t-reset').addEventListener('click', () => tEdit((t, sim) => { sim.resetTarget(t); S.kind = null; }));
for (const id of ['#t-copy', '#t-copy2']) {
  $(id).addEventListener('click', (e) => tEdit((t, sim) => {
    const side = e.currentTarget.dataset.side;
    sim.copyTarget(t, side ? +side : 0);
    toast(side ? 'あごのラインの半分を、もう半分へ反転して当てました' : `${targetLabel(sim.tdef(sim.tdef(t.id).pair))}へコピーしました`);
  }));
}

// ---------------- 修正前の一時表示（押している間だけ） ----------------
const before = $('#btn-before');
const beforeOn = (e) => { e.preventDefault(); S.before = true; before.classList.add('pressing'); S.dirty = true; };
const beforeOff = () => { if (!S.before) return; S.before = false; before.classList.remove('pressing'); S.dirty = true; };
before.addEventListener('pointerdown', beforeOn);
['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => before.addEventListener(t, beforeOff));
before.addEventListener('contextmenu', (e) => e.preventDefault());

// ======================================================================
// 設定
// ======================================================================
function updateSettings() {
  $$('[data-assist]').forEach((el) => (el.checked = !!settings.assist[el.dataset.assist]));
  $('#s-frame').value = Math.round(settings.frame * 100);
  const zs = cam.ready ? zoomChoices() : [1, 1.5, 2, 3, 4];
  if (!zs.some((z) => Math.abs(z - settings.zoom) < 0.01)) zs.push(settings.zoom);
  $('#s-zoom').innerHTML = zs.sort((a, b) => a - b).map((z) => `<option value="${z}" ${Math.abs(z - settings.zoom) < 0.01 ? 'selected' : ''}>${z}×</option>`).join('');
  $('#s-zoom-note').textContent = !cam.ready ? '' : cam.hw ? 'カメラのズームを使います' : 'このブラウザはデジタルズームです（拡大するほど画質が下がります）';
  $('#s-delay').value = String(settings.delay);
  $('#s-edge-alpha').value = settings.edgeAlpha; $('#s-edge-alpha-v').textContent = `${settings.edgeAlpha}%`;
  $('#s-mirror-alpha').value = settings.mirrorAlpha; $('#s-mirror-alpha-v').textContent = `${settings.mirrorAlpha}%`;
  $('#s-mirror-mode').value = settings.mirrorMode;
  renderSwatches($('#s-colors'));
}
$$('[data-assist]').forEach((el) => el.addEventListener('change', () => { settings.assist[el.dataset.assist] = el.checked; save(); }));
$('#s-frame').addEventListener('input', (e) => { settings.frame = +e.target.value / 100; save(); });
$('#s-zoom').addEventListener('change', (e) => setZoom(+e.target.value));
$('#s-delay').addEventListener('change', (e) => { settings.delay = +e.target.value; save(); });
$('#s-edge-alpha').addEventListener('input', (e) => { settings.edgeAlpha = +e.target.value; save(); updateSettings(); });
$('#s-mirror-alpha').addEventListener('input', (e) => { settings.mirrorAlpha = +e.target.value; save(); updateSettings(); });
$('#s-mirror-mode').addEventListener('change', (e) => { settings.mirrorMode = e.target.value; save(); });

// ======================================================================
// このアプリについて・版と更新
// ======================================================================
const aboutDlg = $('#about-dialog');
$('#btn-about').addEventListener('click', () => aboutDlg.showModal());
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
