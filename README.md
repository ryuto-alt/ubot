# Ubot

汎用 Discord ボット（discord.js v14 / ESM）。コマンドやイベントはファイルを置くだけで増える。

## セットアップ

```bash
npm install
```

`.env` に `DISCORD_TOKEN` / `CLIENT_ID`（/ 任意で `GUILD_ID`）を設定する（`.env.example` 参照）。

## 実行

```bash
npm run deploy   # スラッシュコマンドを Discord に登録（追加・変更時に毎回）
npm start        # ボット起動
```

## 機能の追加

- **スラッシュコマンド**: `src/commands/` に `{ data, execute }` を export した `.js` を置く → `npm run deploy` → 自動でロードされる。
- **イベント**: `src/events/` に `{ name, once?, execute }` を export した `.js` を置く → 自動で登録される。

例は `src/commands/ping.js` を参照。

## 動画配信（Go Live）

```bash
npm run douga   # 操作パネル http://localhost:8787 が開く
```

VC を選んで「VCに入る」→ URL（か検索語）を入れて「再生 / 追加」。パネルのプレイヤーで
シーク・5秒スキップ・次の動画を操作すると、そのまま Go Live 側に反映される。

- Discord の Bot は Go Live できないので、配信は `.env` の `STREAM_TOKEN`（サブ垢のユーザートークン）で行う
- `yt-dlp` と `ffmpeg`（libzmq 有効なビルド）が必要
- Raspberry Pi 4 では 720p エンコードが等倍ギリ（実測 1.08x）なので PC で動かす。非力なら `STREAM_HEIGHT=480`

## gptsol（LLMチャットハーネス）

メンション / リプライ / DM で会話する層。実体は `src/harness/`（OpenAI Responses API）。

```
分類 + モデレーション → 発散(philosophy/archive) → 本応答 + ツール → 拒否の再評価
→ 批評 → 改稿 → 反復回避台帳
```

### 壊してはいけない不変条件

品質のための約束:

- ユーザー入力は verbatim で渡す。分類器は label を返すだけで書き換えない
- 再評価も改稿も最大1回。言い換え再送で突破を狙わない
- プロバイダ側の安全機構は無効化も回避もしない
- 追加レイヤは全部 fail-soft（落ちたら素通りして会話は続ける）

コストのための約束（**破ると同じ品質のまま課金が数倍になる**）:

- `instructions` は毎ターン**完全一致**に保つ（`ANSWER_FIRST + persona + modeNote` だけ）。
  自動プロンプトキャッシュは先頭からの完全一致プレフィックスにしか効かないので、
  可変の文言を前に混ぜると persona と craft note が永久に未キャッシュになる。
  可変分は `buildTurnNote()` にまとめて `input` 末尾の developer メッセージへ置く
- 履歴は1件ずつ捨てない（`src/harness/history.js`）。毎ターン先頭がズレるとキャッシュが毎回壊れる
- 分類は必ず軽量モデル + `effort: 'low'`（既定は本応答と同じモデルなので渡し忘れ注意）
- 品質レイヤは消さない。ストリームで下書きを先に出し、批評/改稿を送信後に回して体感から外す

### 計測

```bash
npm test          # 配線の回帰。evals/test-cost.js が上の不変条件を守る
npm run report    # logs/harness.jsonl を集計（cached% / ttfb / 段ごとトークン）
npm run smoke     # 実APIで3ターン。2ターン目以降 cached が80%未満ならプレフィックスを壊している
```

実測（2026-09-01）: キャッシュ命中 **0% → 92〜93%**、体感レイテンシ中央値 **21.4秒 → 2〜3秒**。
normal 1ターンの入力は約10,100トークンで、うち persona と `web_search` のツール定義(約4,460トークン)が
固定費。キャッシュが効くかどうかで課金が一桁変わる。

## 本番

ラズパイの systemd `ubot.service`（`/home/unoryuto/ubot`）。デプロイ手順はメモリ `ubot-second-bot` を参照。
