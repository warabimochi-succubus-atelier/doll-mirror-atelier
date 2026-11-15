# Doll Mirror Atelier (ドールメイク用 左右差確認・修正シミュレーションツール)

## Overview (English)

**Open the app: [https://warabimochi-succubus-atelier.github.io/doll-mirror-atelier/](https://warabimochi-succubus-atelier.github.io/doll-mirror-atelier/)**

**Doll Mirror Atelier** is a web app (PWA) for doll makeup artists. Keep a doll head in front of your phone's camera, check the left–right balance while you paint, and try a fix on screen before you change the real makeup. It runs in the browser on phones, and you can install it to your home screen.

- **Live camera, not a photo editor**: the app shows the camera feed all the time and works with the head as it is now. It is not an image editor and it does not paint makeup for you.
- **Line up the head**: a fixed center line with scaled horizontal lines helps you place the head the same way every time. The outline of the last captured image shows you how to put the head back after you take it off the stand.
- **Mirror**: flip one half of the live image (or a captured image) along the center line and lay it over the other half, to check left–right differences or to use one side as a guide for painting the other.
- **Try before you fix**: on a captured image, cut out a piece of makeup (an eyebrow, a blush) and move, rotate, resize or copy it to the other side, to see where it should go before you repaint it.
- **Private**: the camera image and captured images never leave your device and are not saved. Only the settings are kept in the browser.

### Basic workflow

1. Fix the head and the phone on stands, at least 30 cm apart, and zoom in (about 2×).
2. In **Face position** (顔位置設定), line up the head with the center line and capture it.
3. In **Mirror** (ミラー), flip one side over the other and check the balance while you paint.
4. In **Try-out** (仮置き), move pieces of makeup on the captured image before you repaint them, then check the result in Mirror.

The user interface is in Japanese. See [USER_MANUAL.md](USER_MANUAL.md) for the full manual and [SPECIFICATION.md](SPECIFICATION.md) for the specification (both in Japanese).

---

## 概要

**アプリを開く：[https://warabimochi-succubus-atelier.github.io/doll-mirror-atelier/](https://warabimochi-succubus-atelier.github.io/doll-mirror-atelier/)**（スマホでは、ブラウザの「ホーム画面に追加」でアプリとして使えます）

固定したドールヘッドをスマートフォンのカメラで映し続け、その場で左右差やバランスを確認し、実際に修正する前に結果をシミュレーションするドールメイク用の Web アプリ（PWA）です。**「メイク調整前に、試してみる。」** 画像編集ソフトではなく、メイクを描くツールでもありません。カメラの映像と撮影画像は端末の外へ送らず、保存もしません。詳しい仕様は [SPECIFICATION.md](SPECIFICATION.md)、使い方は [USER_MANUAL.md](USER_MANUAL.md) を参照してください。

### 基本の流れ

1. ヘッドと端末をスタンドに固定し（30cm 以上離す）、ズームでヘッドを大きく映す（目安は 2 倍）
2. **顔位置設定** で、ヘッドを中心線と目盛り付きの横線に合わせ、「撮影して完了」で撮影する
3. **ミラー** で、片側を中心線で反転して反対側に重ね、左右差を確かめながらメイクする
4. **仮置き** で、撮影画像の上のメイクを囲んで動かし、描き直す前に置き場所を試す。結果はミラーで確かめる

削り・パテ盛りはアプリ上ではシミュレーションしません。実際に削る・盛りながら、ミラーで確かめます。

ビルド不要の静的 PWA（HTML / CSS / JavaScript）です。現在の版は `js/version.js` の `APP_VERSION` です。公開するまでは 0.x で、公開するときに 1.0.0 にします。

---

## 起動

```bash
python tools/dev-server.py
```

ブラウザで http://localhost:8766/ を開きます。カメラの無い PC では http://localhost:8766/index.html?demo を開くと、カメラの代わりに図のヘッド（`tools/demo-head.svg`）を映像として使えます。ポート番号は `python tools/dev-server.py 8000` のように変えられます。

`tools/dev-server.py` は `python -m http.server` と同じようにファイルを配信し、すべての応答に `Cache-Control: no-cache` を付けます。`python -m http.server` はキャッシュの指示を送らないため、ブラウザがファイルをキャッシュから読み、変更が反映されないことがあります。

カメラは https か `localhost` でしか使えません。スマートフォンの実機で試すときは、GitHub Pages で公開した版を使ってください。

## 公開

GitHub Pages で公開します。

- 公開 URL：https://warabimochi-succubus-atelier.github.io/doll-mirror-atelier/
- 設定：リポジトリの Settings → Pages で、Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にする
- ビルドは不要です。main に push すると公開されます。
- 公開する変更では `js/version.js` の `APP_VERSION` を上げてください（例：`0.4.39` → `0.4.40`）。Service Worker のキャッシュ名はこの版から作るので、利用者の端末に新しい版が入り、画面に「新しい版があります」と表示されます。ファイルを追加・改名したときは、`sw.js` の `ASSETS` も直してください。

## 画面

| 画面 | 内容 |
| --- | --- |
| カメラ（ホーム） | 背面カメラの映像を常に表示する。ズームの調整、フレームガイド、中心線の表示、左右反転表示（押している間だけ）。設置ガイド・顔位置設定・ミラー・仮置き・設定への入口 |
| 顔位置設定 | 映像の中央に固定した中心線と目盛り付きの横線、前回の撮影画像の輪郭（元の位置）、設置・撮影の補助（水準器、照明の左右差、ピンぼけ・ブレ）を表示し、ヘッドを合わせる。中心線の角度の微調整。「撮影して完了」で撮影する |
| ミラー | ライブ映像・撮影画像・仮置きの結果の片側を中心線で反転し、反対側に重ねる。重ねる側、透明度、表示方法（画像／輪郭のみ）、位置の微調整、今の映像を撮影 |
| 仮置き | 撮影画像の上でメイクを囲んで切り取り、移動・回転・拡大縮小・左右コピーする。元のメイクを残す／薄くする／消す、取り消し・やり直し、修正前の一時表示 |
| 設定 | カメラ画面の補助の ON / OFF、フレームガイドの楕円の大きさ、撮影時の待ち時間、映像のコマ数、設置ガイド、このアプリについて |

## 現在の制限と実装メモ

- ピンぼけ・ブレ、照明の左右差の判定の基準値は目安です。実機での試作で見直します（仕様書「先行して試作・検証する項目」）。
- 水準器は端末のモーションセンサーの値から求めた目安です。
- メイク成分の抽出は、囲んだ範囲の周囲の色を肌色とみなして行う簡易な方式です。
- 撮影画像と仮置きは、アプリを開いている間だけメモリに持ちます。保存・書き出しの機能はありません。設定は localStorage に保存します（`js/settings.js`）。

## ファイル構成

```text
SPECIFICATION.md      仕様書（正本）
USER_MANUAL.md        ユーザーマニュアル
index.html            画面
css/style.css         スタイル
js/version.js         アプリの版（画面の表示と Service Worker のキャッシュ名に使う）
js/app.js             画面の切り替えと操作
js/camera.js          カメラ映像・ズーム・撮影・画面の消灯防止
js/sim.js             仮置き（パーツ移動）の内容と描画、取り消し
js/imaging.js         画像の処理（輪郭の抽出・鮮明さ・照明の判定・メイク成分の抽出）
js/geom.js            座標計算（行列・中心線・多角形）
js/settings.js        アプリの設定（localStorage）
js/ui.js              ダイアログ・案内
icons/                アプリアイコン（PWA 用 any / maskable、iOS 用、ファビコン。python tools/make-icons.py で原画から書き出す）
icons/source/         アイコンの元画像
images/author-logo.webp  作者ロゴ（「このアプリについて」ダイアログ）
manifest.webmanifest  PWA マニフェスト
sw.js                 Service Worker（オフライン用。新しい版が届いたら画面に知らせる）
.nojekyll             GitHub Pages の Jekyll 変換を止め、ファイルをそのまま配信する（中身は空）
tools/dev-server.py   開発用のサーバー（キャッシュさせずに配信する）
tools/demo-head.svg   開発用の映像（?demo）
tools/make-icons.py   アイコンの書き出し
LICENSE               MIT License
NOTICE.md             ロゴ・アイコンの権利について
```

## ライセンス

[MIT License](LICENSE) のもとで公開しています。ただし、ロゴとアイコンは対象外です。詳しくは [NOTICE.md](NOTICE.md) を参照してください。
