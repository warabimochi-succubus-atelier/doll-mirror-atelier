# Doll Mirror Atelier

## 仕様書

- 仕様の正本はこのリポジトリの [SPECIFICATION.md](SPECIFICATION.md)。機能の追加・変更の前に必ず確認する。
- 実装で仕様を変える場合は、SPECIFICATION.md も同じ変更で更新する（改訂履歴に版を追加する）。
- 画面や操作が変わる場合は、[USER_MANUAL.md](USER_MANUAL.md) も同じ変更で更新する（アプリの「このアプリについて」から GitHub 上のこのファイルにリンクしている）。

## 構成

- ビルド不要の静的 PWA（HTML / CSS / JavaScript〔ES モジュール〕）。外部のライブラリは使わない。初期版（0.x。公開前）。
- タイトル・版の表示・「このアプリについて」・配色・Service Worker の更新の仕組みは、姉妹アプリ doll-pigment-atelier に揃えている。
- 起動: `python tools/dev-server.py` → http://localhost:8766/（キャッシュさせないヘッダーを付けて配信する）
- カメラの無い PC での確認: http://localhost:8766/index.html?demo（カメラの代わりに `tools/demo-head.svg` を映像として流す。開発ツールから `window.dma` で作業内容を見られる）
- ファイル構成と現在の制限は [README.md](README.md) を参照。
- 公開する変更では `js/version.js` の `APP_VERSION` を上げる（Service Worker のキャッシュ名に使う）。ファイルを追加・改名したら `sw.js` の `ASSETS` も直す。
- 「左」「右」はドール本人から見た左右。画面上では「左眉（画面右側）」のように画面上の位置を併記する。
