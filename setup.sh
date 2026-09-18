#!/bin/bash
#
# setup.sh —— capture-ledger のローカル開発環境を用意する。
#
# ここでやること:
#   1. Apple Container の道具が入っているかを見る。
#   2. `capture-ledger` の DNS ドメインが登録されていなければ、続けずに止まる。
#   3. submodule を初期化する。
#   4. .env.example を写して .env を作る。
#

set -e

cd "$(dirname "$0")"

# `--help` は、上のヘッダコメントをそのまま出力にする。ヘルプ本文を別に持つと、
# コメントと出力の 2 つが独立にずれていくので、出どころを 1 つにしている。
#
#   sed -n '3,10p'      このファイルの 3–10 行目、つまりヘッダの塊だけを取る
#   sed 's/^# \{0,1\}//' 各行の先頭の `# ` を剥がす (空行は `#` だけなので 1 文字も可)
#
# **行の範囲は直書きなので、ヘッダを増減させたらここも直すこと。** 直し忘れると
# 出力が途中で切れるか、`set -e` などの次の行まではみ出す —— どちらも
# 「--help を叩いた人にしか見えない」壊れ方で、テストは緑のまま。
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "エラー: 知らない引数です: $1" >&2
  echo "使い方は '$0 --help' で見られます。" >&2
  exit 1
fi

# --- 道具立て -------------------------------------------------------------
for cmd in container container-compose git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "エラー: \`$cmd\` が要りますが、PATH に見つかりません。" >&2
    echo "Apple Container と container-compose を (Homebrew で) 入れてから、もう一度実行してください。" >&2
    exit 1
  fi
done

# --- DNS ドメイン ---------------------------------------------------------
# docker-compose.yml の project 名が、そのまま DNS ドメインになる。登録されて
# いないと container-compose は、起動後に `container exec` で **各コンテナの中の**
# /etc/hosts へ相手の行を追記する方式に落ちる (ホスト側の /etc/hosts は触らない)。
#
# その追記は非 root のコンテナ (browserhive=uid 1000、chromium=uid 999) では
# 書き込めずに失敗するが、container-compose は exec の終了状態を見ず stderr も
# 捨てるので **何も言わない**。しかも root のコンテナ (postgres、seaweedfs、
# replay) では成功するため、「一部のサービスだけ名前が引けない」という追いにくい
# 症状になる。だからここで大きな音を立てて止める。
if ! container system dns ls 2>/dev/null | grep -qx "capture-ledger"; then
  echo "エラー: DNS ドメイン 'capture-ledger' が登録されていません。" >&2
  echo "" >&2
  echo "    sudo container system dns create capture-ledger" >&2
  echo "" >&2
  echo "上のコマンドを一度だけ実行してから (sudo が要ります)、このスクリプトをもう一度実行してください。" >&2
  exit 1
fi

# --- 上流の submodule -----------------------------------------------------
echo "上流の submodule を初期化しています..."
git submodule update --init --recursive
git submodule status --recursive | sed 's/^/  /'

# --- .env を書く ----------------------------------------------------------
# 一覧はここに持たず、.env.example を写す。**独自の一覧を持てば必ずずれる** ——
# ずれた側は「必須の変数が最初から欠けた .env」になり、docs のとおりに進めた人が
# 起動時に落ちる。
#
# 雛形の側は scripts/check-env.mjs が src/ と scripts/ の実際の読み取りと
# 突き合わせているので、変数が増えればここも自動的に追随する。
#
# CAPTURE_LEDGER_DEV_* は認証ではない。誰が投げたかを記録に残すための足場で、
# 検証は一切されない —— .env を書き換えれば誰にでも成りすませる。本物の
# identity provider が決まるまでの繋ぎなので、そのつもりで扱うこと。
cp .env.example .env
echo ".env を作りました (.env.example を写しました)"

# 最後の案内は、quickstart (docs-site の ja/quickstart.md) の手順の入口だけを書く。
# 手順そのものを写すと腐る —— 以前ここに書いていた待ち合わせの grpcurl は、RPC が
# GetServerStatus に改名された後も GetStatus を叩き続けて **永遠に待つ** 形になり、
# 案内の `pnpm run capture` は CLI ごと消えていた。確かめ方と細部は docs が持つ。
cat <<'EOF'

準備ができました。

  pnpm run stack:up                             # スタックをビルドして起動する (初回は数分)

起動したかの確かめ方は、quickstart の「3. スタックを起動する」にあります。
dev コンテナはありません。ここから先はホストで作業し、スタックには名前で届きます:

  pnpm install
  pnpm run db:migrate && pnpm run db:seed

API は OpenFGA の ID を 2 つ要ります。ID は model をデプロイして初めて決まるので、
fga:deploy が印字する 2 行を .env の CAPTURE_LEDGER_FGA_STORE_ID と
CAPTURE_LEDGER_FGA_MODEL_ID に書き写してから、API を起動してください:

  pnpm run fga:migrate && pnpm run fga:deploy   # store id と model id を印字する
  pnpm run api                                  # その後 http://127.0.0.1:7070/ を開く

クロールの起こし方を含む続きは quickstart にあります:

  https://uraitakahito.github.io/capture-ledger/ja/quickstart/
EOF
