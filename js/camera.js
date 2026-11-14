// カメラ映像：背面カメラの取得・ズーム・1コマの撮影・画面の消灯防止
// 仕様書「入力（カメラ映像）」「ズーム」を参照

import { clamp } from './geom.js';

const DIGITAL_MAX = 4;    // デジタルズームの上限（これ以上は画質が下がりすぎる）
const WORK_MAX = 4096;    // 撮影画像の長辺の上限（端末の Canvas 上限を超えないため）
const DEMO = new URLSearchParams(location.search).has('demo');
// 4K を求め、端末が出せる最大に近い解像度にする（多くの端末で最大 4K 程度）
const SIZE = { width: { ideal: 3840 }, height: { ideal: 2160 } };
// 複数のレンズをまとめたカメラ（iPhone の「背面デュアルカメラ」「背面トリプルカメラ」等）の名前
const MULTI_LENS = /dual|triple|デュアル|トリプル/i;
// 背面の、レンズ1つのカメラのうち、標準（広角）でないものの名前
const OTHER_LENS = /ultra|tele|超広角|望遠|front|前面/i;

export const cam = {
  video: null,
  stream: null,
  track: null,
  /** カメラのズーム制御に対応している場合の範囲 { min, max }。対応していなければ null（デジタルズーム） */
  hw: null,
  zoom: 1,
  /** 使っているカメラの名前（設定画面に表示する。端末が名前を返さない場合は空） */
  label: '',
  /** 'idle' | 'starting' | 'live' | 'denied' | 'nocam' | 'error' */
  state: 'idle',
  error: '',
  wakeLock: null,
  onState: () => {},

  init(video) { this.video = video; },

  async start() {
    if (this.state === 'starting' || this.state === 'live') return;
    if (DEMO) { await this.startDemo(); return; }
    if (!navigator.mediaDevices?.getUserMedia) { this.setState('nocam', 'このブラウザはカメラに対応していません'); return; }
    this.setState('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, ...SIZE } });
      await this.useSingleLens();
    } catch (e) {
      const name = e?.name || '';
      if (name === 'NotAllowedError' || name === 'SecurityError') this.setState('denied');
      else if (name === 'NotFoundError' || name === 'OverconstrainedError') this.setState('nocam', 'カメラが見つかりません');
      else this.setState('error', String(e?.message || e));
      return;
    }
    this.track = this.stream.getVideoTracks()[0];
    this.label = this.track.label || '';
    const caps = this.track.getCapabilities?.() || {};
    this.hw = caps.zoom && caps.zoom.max > caps.zoom.min ? { min: caps.zoom.min, max: caps.zoom.max } : null;
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* 自動再生が止められた場合も、映像が来れば表示する */ }
    await new Promise((r) => (this.video.readyState >= 2 ? r() : this.video.addEventListener('loadeddata', r, { once: true })));
    await this.setZoom(this.zoom);
    this.setState('live');
    this.keepAwake();
  },

  /**
   * 複数のレンズをまとめたカメラが選ばれた場合は、レンズ1つの標準（広角）の背面カメラに替える。
   * まとめたカメラは、ピントを合わせ直すとき（振動・手をかざす等で近くの物を見たとき）にレンズを自動で切り替える。
   * レンズごとに位置がずれているため、そのたびに映像が上下にずれ、見下ろすような画角になって戻る。
   * ヘッドとスタンドを固定して中心線に合わせる使い方では、映像が動かないことを優先する
   */
  async useSingleLens() {
    const cur = this.stream.getVideoTracks()[0];
    if (!MULTI_LENS.test(cur?.label || '')) return;
    let id = '';
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      const back = list.filter((d) => d.kind === 'videoinput' && /back|rear|背面/i.test(d.label) && !MULTI_LENS.test(d.label) && !OTHER_LENS.test(d.label));
      id = back[0]?.deviceId || '';
    } catch { return; }
    if (!id || id === cur.getSettings?.().deviceId) return;
    let s;
    try { s = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: id }, ...SIZE } }); } catch { return; /* 替えられなければ、まとめたカメラのまま使う */ }
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = s;
  },

  /** 開発用：カメラの代わりに、図のヘッド（tools/demo-head.svg）を映像として流す（index.html?demo） */
  async startDemo() {
    this.setState('starting');
    const img = new Image();
    img.src = 'tools/demo-head.svg';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 1080; c.height = 1920;
    const x = c.getContext('2d');
    let n = 0;
    const draw = () => { x.drawImage(img, 0, 0, c.width, c.height); x.fillStyle = `rgba(0,0,0,${0.002 * (n++ % 2)})`; x.fillRect(0, 0, 4, 4); };
    draw();
    this.demoTimer = setInterval(draw, 1000 / 15);
    this.stream = c.captureStream(15);
    this.track = this.stream.getVideoTracks()[0];
    this.label = 'デモ映像';
    this.hw = null;
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* 何もしない */ }
    await new Promise((r) => (this.video.readyState >= 2 ? r() : this.video.addEventListener('loadeddata', r, { once: true })));
    await this.setZoom(this.zoom);
    this.setState('live');
  },

  stop() {
    clearInterval(this.demoTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null;
    if (this.video) this.video.srcObject = null;
    this.releaseWake();
    if (this.state === 'live' || this.state === 'starting') this.setState('idle');
  },

  setState(s, msg = '') { this.state = s; this.error = msg; this.onState(s); },

  get ready() { return this.state === 'live' && this.video.videoWidth > 0; },

  /** ズーム倍率の範囲（ボタンの表示用） */
  zoomRange() { return this.hw ? { min: this.hw.min, max: this.hw.max } : { min: 1, max: DIGITAL_MAX }; },

  async setZoom(z) {
    const r = this.zoomRange();
    this.zoom = clamp(z, r.min, r.max);
    if (this.hw && this.track) {
      try { await this.track.applyConstraints({ advanced: [{ zoom: this.zoom }] }); } catch { /* 対応していなければデジタルズームに切り替える */ this.hw = null; }
    }
  },

  /**
   * 使う映像の範囲（映像の画素）。カメラのズーム制御を使う場合は全体、
   * デジタルズームでは映像の中央を基準に左右・上下対称に切り出す（中心線が映像の中央からずれないように）
   */
  crop() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const z = this.hw ? 1 : this.zoom;
    const sw = vw / z, sh = vh / z;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  },

  /** 表示中の映像の1コマを静止画として撮影する（長辺 4096px 以下） */
  grab() {
    const c = this.crop();
    const s = Math.min(1, WORK_MAX / Math.max(c.sw, c.sh));
    const w = Math.round(c.sw * s), h = Math.round(c.sh * s);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(this.video, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
    return cv;
  },

  // ---------------- 画面の消灯防止（Screen Wake Lock API） ----------------
  get wakeSupported() { return 'wakeLock' in navigator; },
  async keepAwake() {
    if (!this.wakeSupported || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => { this.wakeLock = null; });
    } catch { /* 電池残量が少ない場合などは許可されない */ }
  },
  releaseWake() { this.wakeLock?.release().catch(() => {}); this.wakeLock = null; },
};
