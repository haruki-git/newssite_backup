# セキュリティチェックメモ（t-share）

## GitHubに載せない（重要）
- `/opt/api_key/.env` の中身（APIキー等）
- `/etc/apache2/auth/tshare-admin.htpasswd`（Basic認証のパスワードファイル本体）

---

## セキュリティチェック項目
- [x] HTTPSがちゃんとしているかの確認
- [x] HSTS を入れる（まずは短め→問題なければ延ばす）
- [x] 主要セキュリティヘッダを追加（OWASP推奨の系統）
- [x] 管理系API保護（パスワード保護を採用）
- [x] サーバ情報の出しすぎを抑える（Serverヘッダの指紋を減らす）
- [ ] すぐに“点数化”して確認したいなら

---

## チェック項目の実施

### 1) HTTPSがちゃんとしているかの確認

#### 1-1) リダイレクト確認（HTTP → HTTPS）
```
curl -I http://t-share.duckdns.org/index.html
```

- `HTTP/1.1 301`（または302） と `Location: https://...` が出ればOK（Locationヘッダで飛ばしてる）

#### 1-2) 証明書とHSTS確認（“強いHTTPS”になってるか）
```
curl -I https://t-share.duckdns.org/index.html
```

- `Strict-Transport-Security:` が出ていればOK（ブラウザが「今後はHTTPを使わない」モードになってより安全）

---

### 2) HSTS を入れる（まずは短め→問題なければ延ばす）

HSTS は強い反面、長期間にすると「証明書が切れた/壊れた」とき復旧が面倒になるので、最初は短め推奨。  
preload を狙うなら `max-age>=31536000` と `includeSubDomains` が必要、など要件もあります。  
Apache なら `mod_headers` で付けられます。

例（まずは 1日 = 86400秒）：
```
sudo a2enmod headers
sudo tee /etc/apache2/conf-available/security-headers.conf >/dev/null <<'EOF'
<IfModule mod_headers.c>
  Header always set Strict-Transport-Security "max-age=86400"
</IfModule>
EOF
sudo a2enconf security-headers
sudo systemctl reload apache2
```

確認：
```
curl -I https://t-share.duckdns.org/index.html | grep -i strict-transport-security
```

---

### 3) 主要セキュリティヘッダを追加（OWASP推奨の系統）

OWASPは、XSS・クリックジャッキング等の軽減にレスポンスヘッダを推奨しています。  
おすすめ：この内容に “置き換え”（一番ミスが少ない）

```
sudo tee /etc/apache2/conf-available/security-headers.conf >/dev/null <<'EOF'
<IfModule mod_headers.c>
  Header always set Strict-Transport-Security "max-age=86400"
  Header always set X-Content-Type-Options "nosniff"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set X-Frame-Options "SAMEORIGIN"
</IfModule>
EOF
sudo systemctl reload apache2
```

反映確認（1行でコピペしやすく）：
```
curl -I https://t-share.duckdns.org/index.html | egrep -i 'strict-transport-security|x-content-type-options|referrer-policy|x-frame-options'
```

---

### 4) 管理系API保護（パスワード保護）

①IP制限か ②Basic認証（または両方）を掛けるのが一番ラクで強いです。  
Apache 2.4 のアクセス制御は `Require ip`、Basic認証は `AuthType Basic / AuthUserFile / Require valid-user` を使います。

#### 手順0：まず「守るURL」を特定（1分）
```
ls -1 /opt/tshare-api/routes
grep -RE --exclude-dir=node_modules "router\.(get|post|delete|put|patch)" -n /opt/tshare-api/routes | head
```

#### 1) “最終URL” を確定する
(A) ルート定義を全部見る
```
grep -RE --exclude-dir=node_modules "router\.(get|post|delete|put|patch)" -n /opt/tshare-api/routes
```

(B) router がどこに mount されてるか（app.use）を探す
```
grep -R "app\.use" -n /opt/tshare-api | head -n 50
```

#### 2) いちばん楽で堅い：POST/DELETEは「場所に関係なく」常にパスワード必須
```
# 1) 認証モジュール有効化（Debian系）
sudo a2enmod auth_basic authn_file

# 2) Basic認証ユーザ作成（admin を作る）
sudo mkdir -p /etc/apache2/auth
sudo htpasswd -c /etc/apache2/auth/tshare-admin.htpasswd admin
# ↑ パスワードを2回聞かれる

# 3) 「POST/DELETE等だけ」認証必須にする設定を作成（vhost編集不要）
sudo tee /etc/apache2/conf-available/tshare-admin-api.conf >/dev/null <<'EOF'
<LocationMatch "^/api/genba/themes(/|$)">
  <LimitExcept GET HEAD OPTIONS>
    AuthType Basic
    AuthName "tshare admin"
    AuthUserFile /etc/apache2/auth/tshare-admin.htpasswd
    Require valid-user
  </LimitExcept>
</LocationMatch>
EOF

# 4) confを有効化して反映
sudo a2enconf tshare-admin-api
sudo systemctl reload apache2

# 5) 動作確認（未認証のPOSTは 401 になるのが正解）
curl -i -X POST https://t-share.duckdns.org/api/genba/themes

# 6) 認証して叩く（401じゃなくなればOK。中身次第で400/200等になる）
curl -i -u admin -X POST https://t-share.duckdns.org/api/genba/themes

# 7) ユーザ名の追加 or つくり直し（どちらか）
# 7-1) ユーザーを追加する場合
sudo htpasswd /etc/apache2/auth/tshare-admin.htpasswd ユーザー名
sudo systemctl reload apache2

# 7-2) 既存ユーザーを消してからつくり直しする場合（-c で作り直し）
sudo htpasswd -c /etc/apache2/auth/tshare-admin.htpasswd ユーザー名
sudo systemctl reload apache2
```

---

### 5) サーバ情報の出しすぎを抑える（未実施）
Apacheには `ServerTokens` / `ServerSignature` でサーバ識別情報の出し方を制御できます。
やること（例：confを追加して有効化）

```
sudo tee /etc/apache2/conf-available/tshare-hardening.conf >/dev/null <<'EOF'
ServerTokens Prod
ServerSignature Off
TraceEnable Off
EOF

sudo a2enconf tshare-hardening
sudo systemctl reload apache2
```

---

### 6) “点数化”で見落とし確認（超おすすめ）
Mozilla の HTTP Observatory にURLを入れると、HSTS/CSPなどの不足が一覧で出ます。
