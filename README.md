# ラズパイで作成したサイトのバックアップと構成忘れないようする置き場

-------実装している機能-------  
■ News機能  
  NewsAPIからフィルターをかけてインフラ系の記事を抜きだし。  
  GPTで要約記載しクリックすると用語解説/個人でできることが表示される。  
  毎日7:15分に3記事更新される。  
  備考：Googleなど影響力大の会社が動いたりすると、タイトルは若干異なるだけで全部同じ内容の記事になってしまう。  
    
■ 現場で使える記事自動生成機能  
  毎週土曜日にGPTが現場で使えるくらいのレベルの記事を自動生成する。  
  テーマは、Webページから入力できて、そのテーマに沿った記事が生成される。  
  テーマは削除/追加が可能。テーマが空だと土曜日になにも出力しない。  


# サイト用のREADME
# tshare-api (t-share backend)

Raspberry Pi 上で動く Node.js(Express) API + 自動生成スクリプト群。  
生成物（HTML）は Web サーバ側の公開ディレクトリ（例: `/var/www/html`）へ出力する。

- API常駐: tshare-api.service
- 定期実行:
  - tshare-digest.timer -> tshare-digest.service
  - tshare-genba-weekly.timer -> tshare-genba-weekly.service

---

## ディレクトリ構成（現状）

/opt/tshare-api/
- data/        : JSON等のデータ（キュー、生成結果など）
- routes/      : Express ルーティング
- scripts/     : 生成/更新スクリプト（systemd timer から実行）
- node_modules/: 依存（Git管理しない）
- docs/        : 運用ドキュメント（自分用）

scripts/（現状）
- build_genba_index.js
- common_genba.js
- genba_build_manifest.js
- genba_generate_weekly.js
- generate_digest.js

---

## まず動かす（最短）

### 1) 依存インストール
```bash
cd /opt/tshare-api
npm ci
```


## APIを常駐させる（推奨）
```bash
sudo systemctl enable --now tshare-api.service
sudo systemctl status tshare-api.service --no-pager
```

### 自動実行（systemd timers）
#### タイマ確認
```bash
systemctl list-timers --all | grep tshare
```

### 手動実行（動作確認）
#### digest（今すぐ1回回す）
```bash
sudo systemctl start tshare-digest.service
journalctl -u tshare-digest.service -n 200 --no-pager
```

#### genba週次生成（今すぐ1回回す）
```bash
sudo systemctl start tshare-genba-weekly.service
journalctl -u tshare-genba-weekly.service -n 200 --no-pager
```

### ログ
#### API
```bash
journalctl -u tshare-api.service -n 200 --no-pager
```
#### digest
```bash
journalctl -u tshare-digest.service -n 200 --no-pager
```
#### genba weekly
```bash
journalctl -u tshare-genba-weekly.service -n 200 --no-pager
```
