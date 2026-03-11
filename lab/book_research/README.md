# book_research

NDL Search SRU を使って、タイトルにキーワードを含む書籍の出版件数を年ごとに可視化する Flask アプリです。

## 起動

```bash
cd /Users/ashizawasoichiro/Desktop/flask-diary/lab/book_research
python3 app.py
```

デフォルトでは `http://127.0.0.1:5060` で起動します。

## 設計メモ

- 検索は `title="..." AND mediatype="books"` の CQL を基本 1 回発行
- 年次集計は SRU レスポンス `extraResponseData` の `ISSUED_DATE` ファセットを使用
- ファセットが 50 年で頭打ちになる場合だけ `from/until` で年レンジを分割して追加取得
- 全件取得しての自前集計はしない
- 同一キーワードは 30 分だけメモリキャッシュ
