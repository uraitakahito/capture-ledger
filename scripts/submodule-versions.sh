#!/usr/bin/env bash
#
# submodule の版を、compose の build 引数として渡せる形で export する。
# **単独では走らせない —— source して使う。**
#
# ## なぜ要るのか
#
# `docker-compose.yml` は submodule から image を建てるが、build context には `.git`
# が無い。だから中の `generate-version.mjs` は git に訊けず、環境変数から読む。
# 渡さないと `GIT_TAG` が空になり、版は `"unknown"` に落ちる。
#
# それは `GetServerStatus` に出るだけでは済まない。**archive に焼き込まれる** ——
# `datapackage.json` の `software` と `browserhive:capture.build`、WARC の `warcinfo`。
# しかも `datapackage.json` 全体のハッシュが署名の対象なので、**署名済みのバイト列の
# 中で確定する**。実際、この仕組みが無かった間に撮った WACZ は
# `software: browserhive/unknown` を名乗っていた (実物を開いて確認)。
#
# ## なぜ source なのか
#
# 起こし方が 1 つではないから。`scripts/stack.sh` と `scripts/prod-smoke.sh` の
# 両方が compose を叩く。**同じ答えを 2 か所で計算しない** —— 片方だけ直すと、
# もう片方から建てた image が黙って `unknown` を名乗る。
#
# ## タグの上に無ければ落とす
#
# `--exact-match` を付けているのは、外れたときに `describe` が**到達可能なタグ**しか
# 見ないから。タグの上に無い commit に `describe` を当てると、その commit から辿れる
# 最も近いタグが返り、それは最新の版とは限らない。
# 2026-10 まで browserhive は develop で開発し、タグは main の merge commit に在ったので、
# develop の commit を指した submodule では何メジャーも古い値が返った (上流でそれを踏み、
# `generate-version.mjs` を書き直した)。
#
# capture-ledger は「submodule はタグに固定する」を既に規約にしている —— CI の site job が
# `browserhivePin()` 経由でそれに依存している。ここで守らせるのはその規約の延長。
#
# 一時的に外したいときは、変数を明示すれば計算ごと飛ぶ:
#
#   BROWSERHIVE_TAG=v8.12.0-wip pnpm run stack:up

# 版を渡せるのはこの 3 つだけ。wacz-signer / tsa / chromium-server-docker の Dockerfile は
# 版の ARG を持たない (上流の compose も渡していない)。
_versions_for() {
  local prefix="$1" path="$2"
  local tag_var="${prefix}_TAG" rev_var="${prefix}_REV"

  # 明示された値は尊重する。逃げ道であり、上書きの意図を消さないため。
  if [ -n "${!tag_var:-}" ]; then
    export "${tag_var}"
    [ -n "${!rev_var:-}" ] && export "${rev_var}"
    echo "  ${path}: ${!tag_var} (明示された値)"
    return 0
  fi

  if [ ! -d "${path}/.git" ] && [ ! -f "${path}/.git" ]; then
    echo "エラー: ${path} が初期化されていません。" >&2
    echo "  git submodule update --init --recursive" >&2
    return 1
  fi

  local tag
  if ! tag="$(git -C "${path}" describe --tags --exact-match 2>/dev/null)"; then
    local drifted
    drifted="$(git -C "${path}" describe --tags 2>/dev/null || echo '(タグ無し)')"
    echo "エラー: ${path} がタグの上に在りません (${drifted})。" >&2
    echo "  タグに固定するか、${tag_var} を明示してください。" >&2
    echo "  タグから外れた状態の describe は、到達不能なタグを見落として" >&2
    echo "  何メジャーも古い版を返すことがあります —— その値は archive に残ります。" >&2
    return 1
  fi

  # 先頭の `v` は落とさない。受け側の generate-version.mjs が落とす。
  export "${tag_var}=${tag}"
  export "${rev_var}=$(git -C "${path}" rev-parse --short HEAD)"
  echo "  ${path}: ${tag} (${!rev_var})"
}

export_submodule_versions() {
  echo "submodule の版:"
  _versions_for BROWSERHIVE .upstream/browserhive || return 1
  _versions_for CAPTURE_FIXTURES .upstream/capture-fixtures || return 1
  _versions_for REPLAY .upstream/replay || return 1
  echo
}
