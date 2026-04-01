# Camera OCR Tool

## 実装方針

このツールは、紙や画面の文字をその場で撮影し、必要な範囲だけ切り出して OCR を実行し、ラベル付きで保存するための小さなワークフローとして実装する。

最初から全部を一気に作らず、以下の順で小さく積み上げる。

1. アプリの土台を作る
   - Flask Blueprint
   - 画面レイアウト
   - SQLite 保存
2. カメラ撮影とトリミングを作る
   - `getUserMedia()` でカメラ起動
   - 撮影したフレームを canvas に固定
   - ドラッグ選択で切り出し
3. OCR パイプラインをつなぐ
   - フロントから切り出し画像を送信
   - サーバー側で `tesseract` CLI を呼ぶ
   - 日本語 OCR は `jpn`、必要なら `eng+jpn`
4. 保存体験を整える
   - ラベル、抽出テキスト、画像を保存
   - 一覧表示
   - 後で DB を PostgreSQL などに差し替えやすい形に保つ

## 現時点の判断

- 画像のトリミングはブラウザ側で行う。
- OCR はサーバー側アダプタに寄せる。
- 画像本体は当面 SQLite の BLOB に保存する。
- `tesseract` が未導入でも UI と保存は進められるようにし、OCR 実行時に明示的なエラーを返す。

## ファイル構成

- `camera_ocr/lab_app.py`
  - Blueprint
  - DB 初期化
  - OCR API
  - 保存 API
- `camera_ocr/templates/camera_ocr/index.html`
  - 画面骨格
- `camera_ocr/static/app.js`
  - カメラ、撮影、範囲選択、OCR 呼び出し、保存
- `camera_ocr/static/style.css`
  - 画面スタイル
- `camera_ocr/README.md`
  - 実装方針メモ

## 次の実装単位

1. カメラ起動、撮影、トリミング
2. OCR 実行 API
3. ラベル付き保存
4. 保存済みデータ一覧
