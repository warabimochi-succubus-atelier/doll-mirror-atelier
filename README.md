# Doll Mirror Atelier

固定したドールヘッドをスマートフォンのカメラで映し続け、その場で左右差やバランスを確認し、実際に修正する前に結果をシミュレーションするドールメイク用の PWA です。

**「メイク調整前に、試してみる。」**

- 仕様：[SPECIFICATION.md](SPECIFICATION.md)
- 使い方：[USER_MANUAL.md](USER_MANUAL.md)
- 画面のモック：[mock/index.html](mock/index.html)

## 主な機能

- カメラ映像の常時表示と、設置・調整の補助（水準器・フレームガイド・照明の左右差・ピンぼけ・中心線・前回の撮影画像の輪郭）
- 顔位置設定（映像の中央に固定した中心線と目盛り付きの横線に、ヘッドを合わせる）
- ライブ映像の左右反転表示（全体のバランスを、いつもと違う見え方で確かめる）
- ミラー（撮影画像の片側を中心線で反転し、ライブ映像の反対側に重ねる）
- 仮置き（パーツ移動）：メイクを囲んで、移動・回転・拡大縮小・左右コピー
- 削り・パテ盛りは、実際に削る・盛りながらミラーで確認する（アプリ上で輪郭を変形するシミュレーションはしない）

カメラの映像と撮影画像は端末の外へ送らず、保存もしません。

## 動かし方（開発）

ビルドは不要です（HTML / CSS / JavaScript のみ）。

```bash
python tools/dev-server.py
```

http://localhost:8766/ を開きます。カメラの無い PC では http://localhost:8766/index.html?demo を開くと、カメラの代わりに図のヘッドを映像として使えます。

カメラは https か localhost でしか使えません。スマートフォンの実機で試すときは、GitHub Pages などの https で公開した版を使ってください。

## ファイル構成

| ファイル | 内容 |
|---|---|
| `index.html` | 画面 |
| `css/style.css` | 見た目 |
| `js/version.js` | アプリの版（Service Worker のキャッシュ名にも使う） |
| `js/app.js` | 画面の切り替えと操作 |
| `js/camera.js` | カメラ映像・ズーム・撮影・画面の消灯防止 |
| `js/sim.js` | 仮置き（パーツ移動）の内容と描画、取り消し |
| `js/imaging.js` | 画像の処理（輪郭の抽出・鮮明さ・照明の判定・メイク成分の抽出） |
| `js/geom.js` | 座標計算（行列・中心線・多角形） |
| `js/settings.js` | アプリの設定（localStorage） |
| `js/ui.js` | ダイアログ・案内 |
| `sw.js`、`manifest.webmanifest` | PWA（オフライン動作・ホーム画面への追加） |
| `icons/` | アプリアイコン（`python tools/make-icons.py` で原画から書き出す） |
| `tools/dev-server.py` | 開発用のサーバー |
| `tools/demo-head.svg` | 開発用の映像（`?demo`） |
| `mock/index.html` | 画面のモック |
| `.nojekyll` | GitHub Pages の Jekyll 変換を止め、ファイルをそのまま配信する（中身は空） |
| `LICENSE` | MIT License |
| `NOTICE.md` | ロゴ・アイコンの権利について |

## 現在の制限

- ピンぼけ・ブレ、照明の左右差の判定の基準値は目安です。実機での試作で見直します（仕様書「先行して試作・検証する項目」）。
- 水準器は端末のモーションセンサーの値から求めた目安です。
- メイク成分の抽出は、囲んだ範囲の周囲の色を肌色とみなして行う簡易な方式です。

## ライセンス

[MIT License](LICENSE) のもとで公開しています。ただし、ロゴとアイコンは対象外です。詳しくは [NOTICE.md](NOTICE.md) を参照してください。
