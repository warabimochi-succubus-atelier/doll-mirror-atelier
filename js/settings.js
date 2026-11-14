// アプリの設定（端末内の localStorage に保持し、アプリを閉じても残す。作業内容とは別）
// 仕様書「作業内容の保持」の「アプリの設定」を参照

const KEY = 'dma-settings';

export const DEFAULTS = {
  // 顔位置設定（ヘッドと端末の設置に対応する値）
  angle: 0,        // 中心線の角度（度。時計回りが正）
  zoom: 2,         // ズーム倍率
  // カメラ画面の補助の ON / OFF
  assist: { level: true, frame: true, light: true, sharp: true, center: true, edge: false },
  frame: 0.6,      // フレームガイドの楕円の高さ（映像の高さに対する比率）
  delay: 1,        // 撮影時の待ち時間（秒）
  edgeAlpha: 40,   // 前回の撮影画像の輪郭表示の透明度（%。0：不透明、100：完全に透明）
  mirrorAlpha: 0,  // ミラーの透明度（%）
  mirrorMode: 'img', // ミラーの表示方法：'img' 画像 / 'edge' 輪郭のみ
  lineColor: '#5cf2ff', // 輪郭の線の色
  // 案内の表示済み
  firstRunDone: false,
  camIntroDone: false,
};

export const LINE_COLORS = [
  ['#5cf2ff', '水色'], ['#ff5ca8', 'ピンク'], ['#fff200', '黄'], ['#3dff6e', '緑'], ['#ffffff', '白'], ['#222222', '黒'],
];

function load() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    // 古い版の目の高さの線・目頭マークの設定は使わない
    delete v.eyeY; delete v.spacing; delete v.guideZoom;
    return { ...structuredClone(DEFAULTS), ...v, assist: { ...DEFAULTS.assist, ...(v.assist || {}) } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const settings = load();
const listeners = new Set();

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* 保存できない環境（プライベートブラウズ等）ではこの起動中だけ使う */ }
  listeners.forEach((f) => f());
}
export function set(key, value) { settings[key] = value; save(); }
export function onChange(f) { listeners.add(f); }
