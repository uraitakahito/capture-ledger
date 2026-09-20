## 認可の検査は、呼び出し元の申告で満たせてはならない (2026-09-09)

`can_submit: admin or member` と書いた。所属 (`member`) は保存せず、呼び出し元の
トークンから contextual tuple として毎回届く —— つまり「member だと言った者に
member か訊く」形になり、**検査は常に true を返した**。

単体試験は緑のままだった。`fga.check` を「false を返せ」と言われて false を返す
stub に差し替えていたので、赤を作っていたのは stub であって認可の式ではない。
往復で初めて出た: 何の関係も無い組織を名乗った subject に 202 が返った。

**規則**: 権限の検査を書いたら、「この判断材料は誰が作ったか」を必ず問う。
呼び出し元が作った材料だけで満たせる式は、検査ではない。

- **誰であるか** (身元・所属) は IdP の権威 → 保存しない (contextual)
- **何をしてよいか** (権限) は OpenFGA の権威 → 保存する

`routes.ts` の `can_view` が同じ形で安全なのは、object が特定の archive で、
そこから組織への経路が**保存されている**から。object を呼び出し元に選ばせる検査
では、この守りが無い。

**反証の作り方**: 権限の試験を fga の stub で書いたなら、それは経路の試験。
認可そのものは `fga/model.fga.yaml` の assertion で見ること —— そこは本物の
モデルを評価するので、式を緩めると赤くなる。今回追加したのは
「所属しているだけでは取り込みを起こせない」の 1 本。

## 偽物で作った制約は、本物の制約の証拠にならない (2026-09-09)

`runs` の部分 unique index (走行中を高々 1 行) を、偽の DB が 23505 を投げる形で
試験した。**index を消しても、この試験は緑のまま通る** —— 制約を持っているのが
偽物のほうだから (falsification-needs-a-distinguishing-case の④)。

capture-ledger に DB 試験の土台は無い。なので本物の Postgres に対して直接確かめ、
index を落として 2 本目が通ってしまうことまで見た。PR の本文にその出力を貼った。

**規則**: 「DB が守る」と書いた不変条件は、DB に対して確かめる。偽物で書いた
試験は「違反が正しい応答に翻訳されるか」しか見ていない。両方要る。

## fastify の additionalProperties は「拒否」ではない (2026-09-09)

fastify の ajv は既定で `removeAdditional` が立っており、`additionalProperties:
false` は **黙って削る** 意味になる。知らない鍵を送った呼び出し元は 400 ではなく
202 を受け取り、渡したつもりの設定が無視されたことに気づけない。

拒むなら `ajv: { customOptions: { removeAdditional: false } }` を Fastify の
生成時に渡す。既存の route は `additionalProperties` を書いていないので影響しない
(`removeAdditional` は `additionalProperties: false` の schema にしか効かない)。

## 打った repo の外を書き換えない (2026-09-21)

「貼る手間を消す」ために、capture-scheduler の `windmill:bootstrap` が
capture-ledger の `.env` に 4 行書き足す案を出した。**ユーザーの指摘**:
「コマンドを実行したリポジトリ以外の別のリポジトリに書き込むのは予想に反する動作」。

手間の数だけを見ると、書きに行くほうが 1 手少ない。だが**打った人が予想できる
範囲**は repo の境界で切れている。向こうの repo を clone し直しても、git status を
見ても、書かれた側からは「誰がいつ書いたか」が追えない。

直した形: **書くのは自分の repo だけ。跨ぐときは読むだけ。**

- capture-scheduler は `.dev/capture-ledger.env` に置く (自分の中)
- capture-ledger の `pnpm run connect` が**取りに行く** (手順は 1 つ増える)
- 受け取る名前は、自分の `.env.example` が宣言しているものだけ。知らない名前は
  写さずに名指しする —— 相手のファイルをそのまま環境に流し込むと、向こうの都合で
  こちらの設定が変わる

**規則**: 道具が書き込む先は、その道具を打った repo の中に限る。手順が 1 つ増えても、
**驚きが無いほうを選ぶ**。跨ぐ必要がある値は、置く側と取りに行く側に分ける。
