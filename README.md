# 推し渋滞 Public Beta

VTuberの配信予定をまとめて追える「推し渋滞」の公開β版です。

## 構成

- `public/index.html` : サイト本体
- `public/privacy.html` : プライバシーポリシー
- `public/_headers` : セキュリティ関連ヘッダー
- `functions/api/holodex.js` : Holodex API中継用 Cloudflare Pages Function
- `package.json` : ローカル確認用

## GitHub → Cloudflare Pages で公開

### 1. GitHub

このフォルダの**中身をそのままリポジトリ直下**へ置きます。
推奨リポジトリ名: `oshi-juutai`

GitHubへAPIキーは絶対に保存しないでください。

### 2. Cloudflare Pages

Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git から、GitHubの `oshi-juutai` リポジトリを選びます。

設定値:

- Production branch: `main`
- Framework preset: `None`
- Build command: `exit 0`
- Build output directory: `public`
- Root directory: 空欄（リポジトリルート）

`functions` フォルダはリポジトリルートに置いたままにしてください。`public/functions` には移動しません。

### 3. Holodex APIキーをCloudflareのSecretへ保存

Cloudflare Pagesのプロジェクトを開き、
Settings → Variables and Secrets → Add

- Name: `HOLODEX_API_KEY`
- Value: Holodexで取得したAPI KEY
- `Encrypt` を有効にしてSecretとして保存

保存後、Productionを再デプロイします。

このSecretはPages Function内の `context.env.HOLODEX_API_KEY` からだけ参照され、サイト利用者へは送信されません。

## 公開後

Cloudflareから `https://<project>.pages.dev` のURLが発行されます。
以後は `main` ブランチへpushするだけで自動デプロイされます。

## 保存データ

公開β版ではログイン・DBは使用していません。
以下は各利用者のブラウザ LocalStorage に保存されます。

- 登録した推し
- 最推し / 推し / 気になる
- 見る / あとで / スキップ

## API負荷対策

- LIVE / Upcoming: 90秒キャッシュ
- VTuber検索: 1時間キャッシュ
- チャンネル情報: 24時間キャッシュ
- 1ユーザー最大20チャンネル

## ローカル確認

```bash
npm install
npm run dev
```

本物のAPIをローカルで使う場合は `.dev.vars` を作成します。

```text
HOLODEX_API_KEY=ここにAPIキー
```

`.dev.vars` は `.gitignore` に含まれているためGitHubへは送信されません。
