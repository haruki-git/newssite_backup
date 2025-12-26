//　コード解説
// Node.js の Express で「最小のWebサーバ（API）」を立てて、動作確認用のヘルスチェックAPIを1本だけ用意する
// import express from "express";
// Express（Webフレームワーク）を読み込む。

// const app = express();
// サーバ本体（アプリ）を作る。

// app.get("/api/health", (_, res) => res.json({ ok: true }));
// GET /api/health にアクセスされたら、JSONで {"ok": true} を返す。
// ※ _ は「リクエスト引数は使わないよ」という意味で名前を捨ててるだけ。

// app.listen(3000, "127.0.0.1", () => console.log("min listening"));
// **127.0.0.1（自分のPC内だけ）**の 3000番ポートで待ち受け開始。起動したらログ出す。
// 動かすと、ブラウザやcurlで

// http://127.0.0.1:3000/api/health

// にアクセスすると {"ok":true} が返ってくる。
// 用途としては「サーバ起動してる？」「API生きてる？」の確認（ヘルスチェック）にめっちゃよく使うやつ。

import express from "express";
const app = express();
app.get("/api/health", (_, res) => res.json({ ok: true }));
app.listen(3000, "127.0.0.1", () => console.log("min listening"));
