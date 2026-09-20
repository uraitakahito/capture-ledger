#!/usr/bin/env bash
#
# 開発スタックの起動と停止。**これが唯一の起動方法。**
#
# ## なぜ包むのか
#
# 署名を使うには 2 つのことが同時に要る:
#
#   1. `wacz-signer` と `tsa` が起きていること      → --profile signing
#   2. BrowserHive が署名の宛先を知っていること  → --env-file signing.env
#
# `container-compose` に `COMPOSE_PROFILES` は無いので、この 2 つを 1 つの設定から
# 導くには薄い層が要る。生の `container-compose up` を叩くと片方だけを渡せてしまい、
# **「宛先は在るが相手が居ない」状態が作れる** —— 実際にそうなっていて、署名を
# 有効にした取り込みが全部 `ENOTFOUND wacz-signer.capture-ledger` で落ちた。
#
# 出どころは `.env` の `CAPTURE_LEDGER_CAPTURE_SIGNING` **1 つだけ**。同じ変数を capture-ledger 自身も
# 読む (`config/capture-formats.ts`) ので、「署名を頼む側」と「署名を用意する側」が
# 食い違えない。
#
# ## 使い方
#
#   ./scripts/stack.sh up            # 起動 (-d -b は既定で付く)
#   ./scripts/stack.sh down          # 停止
#   ./scripts/stack.sh up --profile capture-fixtures --profile search
#
# 余分な引数はそのまま container-compose へ渡る。`fixtures` と `search` を包まないのは、
# どちらも黙っては壊れないから —— fixtures は実行時に種として選ぶもので、search は
# URL が空なら capture-ledger が口ごと出さない。
#
# `up` は起動の前に、道具・DNS ドメイン・submodule を確かめ、足りなければ名前を挙げて
# 止まる (下の preflight と submodule-versions.sh)。
set -euo pipefail

cd "$(dirname "$0")/.."

SUBCOMMAND="${1:-up}"
shift || true

# ## store はこのスタックに居ない
#
# 成果物の store は crawler で 1 つ (`seaweedfs.crawler-storage`)。起こすのは
# `.upstream/seaweedfs/scripts/stack.sh` で、この compose には service が無い。
#
# **写しを profile で持つ道は採らなかった。** container-compose は `environment:` の
# `${VAR}` を展開しないので、宛先を切り替える手段が env ファイルしか無く、しかも
# `depends_on` に書いた profile のサービスは profile 抜きでも起き上がる (実測。
# browserhive-1 が seaweedfs を引きずり出した)。この repo に store の要る試験は無いので、
# 1 つの宛先だけを持つ。他と混ざらない store で試したいときは、共有 store を空にする
# (`pnpm run store:wipe`)。

# `.env` から 1 行だけ読む。`source` しないのは、`.env` の他の値 (パスワードなど) を
# この shell に持ち込まないため。
signing_enabled() {
  [ -f .env ] || return 1
  grep -qE '^[[:space:]]*CAPTURE_LEDGER_CAPTURE_SIGNING[[:space:]]*=[[:space:]]*1[[:space:]]*$' .env
}

# 起動の前に、黙って壊れる前提を名指しして止める。以前は setup.sh が 1 度だけ見ていたが、
# 起動のたびに見るほうが確か —— 後から DNS ドメインを消しても、次の up で捕まる。
#
#   - 道具: container が無いまま DNS の検査に進むと、「DNS ドメインが無い」と
#     取り違えて報告してしまう。
#   - DNS ドメイン: docker-compose.yml の project 名が、そのまま DNS ドメインになる。
#     登録されていないと container-compose は、起動後に `container exec` で **各コンテナの
#     中の** /etc/hosts へ相手の行を追記する方式に落ちる (ホスト側の /etc/hosts は触らない)。
#     その追記は非 root のコンテナ (browserhive=uid 1000、chromium=uid 999) では書き込めずに
#     失敗するが、container-compose は exec の終了状態を見ず stderr も捨てるので **何も
#     言わない**。しかも root のコンテナ (postgres、seaweedfs、replay) では成功するため、
#     「一部のサービスだけ名前が引けない」という追いにくい症状になる。
#   - submodule: 空なら submodule-versions.sh が「初期化されていません」で止める。
#   - 共有 store: 起きているか。**403 は「立っている」** ——
#     S3 は署名の無い要求を拒むのが正常なので、`curl -f` で見ると立っている store を
#     「落ちている」と判定する。見るのは status で、接続できないときだけ curl は 000 を返す。
#
# down には掛けない。DNS ドメインが無くても、止めることはできるべきだから。
preflight() {
  local cmd domains
  for cmd in container container-compose; do
    if ! command -v "${cmd}" >/dev/null 2>&1; then
      echo "エラー: \`${cmd}\` が PATH に見つかりません。" >&2
      echo "Apple Container と container-compose を (Homebrew で) 入れてから、もう一度起動してください。" >&2
      exit 1
    fi
  done

  # 一覧を変数に取ってから探す。`set -o pipefail` の下で `container … | grep -q` と
  # 繋ぐと、grep が先に終わったときの SIGPIPE で左側が 141 を返し、「在るのに無い」と
  # 判定しうる (以前の setup.sh は pipefail を持たなかったので、その形で済んでいた)。
  domains="$(container system dns ls 2>/dev/null || true)"
  if ! grep -qx "capture-ledger" <<<"${domains}"; then
    echo "エラー: DNS ドメイン 'capture-ledger' が登録されていません (quickstart の 1)。" >&2
    echo "" >&2
    echo "    sudo container system dns create capture-ledger" >&2
    echo "" >&2
    echo "上のコマンドを一度だけ実行してから (sudo が要ります)、もう一度起動してください。" >&2
    exit 1
  fi

  # 共有 store が起きているか。**403 は「立っている」**。
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8333/ || true)"
  if [ "${status}" = "000" ]; then
    echo "エラー: 共有の store (seaweedfs.crawler-storage) が起きていません。" >&2
    echo "" >&2
    echo "    sh .upstream/seaweedfs/scripts/stack.sh up" >&2
    echo "" >&2
    echo "起こしてから、もう一度実行してください。" >&2
    exit 1
  fi
}

if [ "${SUBCOMMAND}" = "up" ]; then
  preflight
fi

# **空配列の展開は `set -u` に当たる。** macOS の bash は 3.2 で、そこでは
# `"${arr[@]}"` が「未定義の変数」として落ちる (実測)。`${arr[@]+...}` の形にすると
# 空のときは何も展開されず、素通りする。
profile_args=()
env_args=()

echo "store: 共有 (seaweedfs.crawler-storage:8333)"

if signing_enabled; then
  profile_args=(--profile signing)
  env_args=(--env-file signing.env)
  echo "署名: 有効 (.env の CAPTURE_LEDGER_CAPTURE_SIGNING=1)"
  echo "  → --profile signing   wacz-signer と tsa を起こす"
  echo "  → --env-file signing.env   BrowserHive に署名の宛先を渡す"
else
  echo "署名: 無効"
  echo "  wacz-signer と tsa は起こさない。BrowserHive は署名の宛先を持たない ——"
  echo "  署名を要求した取り込みは 'no signing service is configured' で失敗する。"
  echo "  有効にするには .env に CAPTURE_LEDGER_CAPTURE_SIGNING=1 を書く。"
fi
echo

case "${SUBCOMMAND}" in
  up)
    # submodule の版を build 引数として渡す。渡さないと image は "unknown" を名乗り、
    # **その値が archive に焼き込まれる**。詳しくは scripts/submodule-versions.sh。
    # shellcheck source=scripts/submodule-versions.sh
    . "$(dirname "$0")/submodule-versions.sh"
    export_submodule_versions

    # `-d -b` を既定にするのは、docs がずっとそう案内してきたから。
    exec container-compose ${profile_args[@]+"${profile_args[@]}"} up -d -b ${env_args[@]+"${env_args[@]}"} "$@"
    ;;
  down)
    # down にも profile を渡す。渡さないと、profile の中のサービスが
    # 「このスタックのもの」と見なされず止め残る。
    exec container-compose ${profile_args[@]+"${profile_args[@]}"} down ${env_args[@]+"${env_args[@]}"} "$@"
    ;;
  *)
    echo "使い方: $0 [up|down] [container-compose への追加の引数...]" >&2
    exit 2
    ;;
esac
