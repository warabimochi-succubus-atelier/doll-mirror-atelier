// 画像の処理：輪郭（エッジ）の抽出、鮮明さ・照明の左右差の判定、メイク成分の抽出
// 処理はすべて端末内で行う

import { axis, sideOf, alongOf, bbox, clamp } from './geom.js';

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
const ctx2d = (c, opt) => c.getContext('2d', opt);

/** 縮小した画像を作る（判定・輪郭の抽出は縮小した画像で行い、処理を軽くする） */
function shrink(src, maxSide, sx = 0, sy = 0, sw = src.width, sh = src.height) {
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const c = canvas(sw * s, sh * s);
  ctx2d(c, { willReadFrequently: true }).drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
function gray(img) {
  const d = img.data, g = new Float32Array(img.width * img.height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}

// ---------------- 輪郭（エッジ） ----------------

/**
 * 画像の輪郭を白い線（透明な背景）の画像にする。前回の撮影画像の輪郭表示と、ミラーの「輪郭のみ」で共通に使う
 * @returns {HTMLCanvasElement} 長辺 1280px 以下の画像（表示時に元の大きさへ引き伸ばす）
 */
export function edgeMask(src) {
  const c = shrink(src, 1280);
  const w = c.width, h = c.height, cx = ctx2d(c, { willReadFrequently: true });
  const img = cx.getImageData(0, 0, w, h);
  let g = gray(img);
  // 細かい模様（肌のきめ・ノイズ）を拾わないよう、軽くぼかしてから求める
  g = blur3(g, w, h);
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1] + g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1];
      const gy = -g[i - w - 1] - 2 * g[i - w] - g[i - w + 1] + g[i + w - 1] + 2 * g[i + w] + g[i + w + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  // しきい値は画像ごとに決める（強い方から約 9% の画素を線にする）
  const hist = new Uint32Array(256);
  for (let i = 0; i < mag.length; i++) hist[Math.min(255, mag[i] >> 2)]++;
  let acc = 0, t = 255;
  const target = mag.length * 0.09;
  for (; t > 0; t--) { acc += hist[t]; if (acc >= target) break; }
  const lo = Math.max(24, t * 4), hi = lo * 1.8;
  const d = img.data;
  for (let i = 0, j = 0; j < mag.length; i += 4, j++) {
    const a = clamp((mag[j] - lo) / (hi - lo), 0, 1);
    d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = a * 255;
  }
  cx.putImageData(img, 0, 0);
  return c;
}
function blur3(g, w, h) {
  const o = new Float32Array(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) { s += g[yy * w + xx]; n++; }
      }
      o[y * w + x] = s / n;
    }
  }
  return o;
}
/** 輪郭の白い線に色を付ける */
export function tintEdges(mask, color, cache) {
  if (cache && cache.mask === mask && cache.color === color) return cache.canvas;
  const c = cache?.canvas && cache.canvas.width === mask.width && cache.canvas.height === mask.height ? cache.canvas : canvas(mask.width, mask.height);
  const x = ctx2d(c);
  x.globalCompositeOperation = 'copy'; x.drawImage(mask, 0, 0);
  x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'source-over';
  if (cache) Object.assign(cache, { mask, color, canvas: c });
  return c;
}

// ---------------- 鮮明さ（ピンぼけ・ブレ）・照明の左右差 ----------------

// 鮮明さの基準。これを下回るとピンぼけ・ブレとして知らせる（目安。実機での試作で見直す）
export const SHARP_MIN = 14;

/**
 * 映像の鮮明さを数値にする（ラプラシアンの分散。値が大きいほど鮮明）
 * @param src 映像または画像、rect 判定する範囲（src の画素）
 */
export function sharpness(src, rect) {
  const c = shrink(src, 360, rect.x, rect.y, rect.w, rect.h);
  const w = c.width, h = c.height;
  const g = gray(ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, w, h));
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      s += l; s2 += l * l; n++;
    }
  }
  if (!n) return 0;
  const m = s / n;
  return s2 / n - m * m;
}

/**
 * 照明の左右差：フレームガイドの楕円の中で、上の部分（額。中心から縦の半径の 0.35 倍より上）の左半分と右半分の明るさを比べる
 * @returns {number} 画面右側の明るさ ÷ 画面左側の明るさ − 1（正：画面右側が明るい）。判定できなければ 0
 */
export function lightBalance(src, w, h, g) {
  const c = shrink(src, 160, 0, 0, w, h);
  const cw = c.width, ch = c.height;
  const d = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, cw, ch).data;
  const ax = axis(cw, ch, g.angle);
  const ry = (g.frame * ch) / 2, rx = ry * FRAME_ASPECT;
  const top = -ry * 0.35;
  let l = 0, ln = 0, r = 0, rn = 0;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = [x + 0.5, y + 0.5];
      const a = alongOf(ax, p), sd = sideOf(ax, p);
      if (a >= top) continue; // 額より下（眉・目・チーク）は含めない
      if ((sd / rx) ** 2 + (a / ry) ** 2 > 1) continue;
      if (Math.abs(sd) < rx * 0.08) continue; // 中心線の近くは除く
      const i = (y * cw + x) * 4;
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (sd > 0) { r += v; rn++; } else { l += v; ln++; }
    }
  }
  if (ln < 20 || rn < 20) return 0;
  return r / rn / (l / ln) - 1;
}
/** フレームガイドの楕円の横÷縦 */
export const FRAME_ASPECT = 0.78;
/** 照明の左右差をこの割合より大きいときに知らせる */
export const LIGHT_DIFF = 0.12;

// ---------------- メイク成分の抽出（仮置きレイヤー） ----------------

/**
 * 囲んだ範囲から、周囲の肌色との差でメイク成分を取り出す
 * @param src 対象の画像（撮影画像）
 * @param poly 囲んだ範囲（src の画素）
 * @param feather 境界のぼかし幅（画素）
 * @param strength 抽出の強さ（0〜1）
 * @returns {{x, y, w, h, layer, fade, erase}}
 *   layer：乗算で重ねるレイヤー（肌色の部分は白＝重ねても変わらない）
 *   fade / erase：元の位置を「薄くする」「消す」ときに上に描く画像（周囲の肌色で補う）
 */
export function extract(src, poly, feather, strength) {
  const bb = bbox(poly);
  const pad = Math.ceil(feather * 2 + Math.max(8, 0.22 * Math.max(bb.w, bb.h)));
  const x0 = clamp(Math.floor(bb.x - pad), 0, src.width - 1), y0 = clamp(Math.floor(bb.y - pad), 0, src.height - 1);
  const x1 = clamp(Math.ceil(bb.x + bb.w + pad), x0 + 1, src.width), y1 = clamp(Math.ceil(bb.y + bb.h + pad), y0 + 1, src.height);
  const w = x1 - x0, h = y1 - y0;
  const img = ctx2d(src, { willReadFrequently: true }).getImageData(x0, y0, w, h);
  const px = img.data;

  // 囲んだ範囲の形（ぼかす前）
  const mc = canvas(w, h), mx = ctx2d(mc, { willReadFrequently: true });
  mx.fillStyle = '#fff'; mx.beginPath();
  poly.forEach(([x, y], i) => (i ? mx.lineTo(x - x0, y - y0) : mx.moveTo(x - x0, y - y0)));
  mx.closePath(); mx.fill();
  const md = mx.getImageData(0, 0, w, h).data;
  const hard = new Float32Array(w * h);
  for (let i = 0; i < hard.length; i++) hard[i] = md[i * 4 + 3] / 255;

  // 肌色：囲んだ範囲の外側（周囲）の色の中央値
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < hard.length; i++) {
    if (hard[i] > 0) continue;
    hr[px[i * 4]]++; hg[px[i * 4 + 1]]++; hb[px[i * 4 + 2]]++; n++;
  }
  const med = (hst) => { let a = 0; for (let v = 0; v < 256; v++) { a += hst[v]; if (a >= n / 2) return v; } return 255; };
  const skin = n > 10 ? [med(hr), med(hg), med(hb)] : [230, 210, 200];

  // 境界のぼかし（3回の箱型ぼかしでガウスぼかしに近づける）
  let soft = hard;
  const r = Math.round(feather / 2);
  if (r > 0) for (let k = 0; k < 3; k++) soft = boxBlur(soft, w, h, r);

  // 肌色との差が大きい画素ほどメイク成分とみなす（抽出の強さを上げると、薄い色も拾う）
  const t0 = 42 - 36 * strength, t1 = t0 + 28;
  const L = new ImageData(w, h), F = new ImageData(w, h), E = new ImageData(w, h);
  const ld = L.data, fd = F.data, ed = E.data;
  for (let i = 0; i < soft.length; i++) {
    const j = i * 4, a = soft[i];
    const r0 = px[j], g0 = px[j + 1], b0 = px[j + 2];
    const dr = skin[0] - r0, dg = skin[1] - g0, db = skin[2] - b0;
    const diff = Math.sqrt(dr * dr + dg * dg + db * db) * (dr + dg + db > -30 ? 1 : 0.5);
    const k = clamp((diff - t0) / (t1 - t0), 0, 1);
    for (let c = 0; c < 3; c++) {
      const ratio = Math.min(1, (px[j + c] + 1) / (skin[c] + 1));
      const eff = 1 - k * (1 - ratio);          // 1：肌色のまま、小さいほどメイクが濃い
      ld[j + c] = 255 * eff;
      ed[j + c] = Math.min(255, px[j + c] / Math.max(eff, 0.02));
      fd[j + c] = Math.min(255, px[j + c] / Math.max(1 - 0.55 * k * (1 - ratio), 0.02));
    }
    ld[j + 3] = fd[j + 3] = ed[j + 3] = a * 255;
  }
  const put = (d) => { const c = canvas(w, h); ctx2d(c).putImageData(d, 0, 0); return c; };
  return { x: x0, y: y0, w, h, layer: put(L), fade: put(F), erase: put(E), skin };
}
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / d;
      s += src[y * w + clamp(x + r + 1, 0, w - 1)] - src[y * w + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / d;
      s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}
