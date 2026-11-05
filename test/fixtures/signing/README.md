# 署名の fixture

合本の署名を検める所（`src/replay-bundle/verify-signed-data.ts`）の試験が読む物。**どれも本物**で、手で書いた
`signedData` は 1 つも無い —— 置き換えの文字列で試すと、いつも true を返す検め手でも全部の試験が通る。

## 出所

ほとんどは BrowserHive から写した物。capture-ledger の `.upstream/browserhive`（v25.1.0・1ce3713）の
2 か所から、中身を変えずに写した（`cmp` で同じ）。CI の `check` の job は submodule を取らないので、試験は
`.upstream/` を読めない。だから写して置く。

| ファイル                                | 元                       | 何か                                                                                   |
| --------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `signed-data.json`                      | `test/fixtures/signing/` | wacz-signer が dev の CA で作った `signedData`。下の `HASH` に対する物。通る形         |
| `other-ca.pem`                          | `test/fixtures/signing/` | 関係の無い根。どれもこれには繋がらない                                                 |
| `other-time-signature.txt`              | `test/fixtures/signing/` | 本物の時刻印で、**別の**署名に押した物                                                 |
| `expired-tsa-ca.crt`                    | `test/fixtures/signing/` | 有効期間の閉じた時刻印の局の根                                                         |
| `expired-time-signature.txt`            | `test/fixtures/signing/` | その局が、まだ有効だった間に押した時刻印                                               |
| `expired-signer-ca.crt`                 | `test/fixtures/signing/` | 2020 年に閉じた署名の根                                                                |
| `expired-signer-signed-data.json`       | `test/fixtures/signing/` | 葉も発行者も、時刻印の時点で失効していた物                                             |
| `expired-issuer-signed-data.json`       | `test/fixtures/signing/` | 葉は有効、発行者 (＝錨) が失効していた物                                               |
| `expired-intermediate-root.crt`         | `test/fixtures/signing/` | 上の中間を発行した、有効な根                                                           |
| `expired-intermediate-signed-data.json` | `test/fixtures/signing/` | 葉も根も有効で、**中間だけ**が失効していた物                                           |
| `insecure-dev-ca.crt`                   | `dev-stack/signing-ca/`  | dev の署名の根（台帳の錨 `CAPTURE_LEDGER_SIGNER_TRUST_ANCHOR` の dev の値と同じ中身）  |
| `insecure-dev-tsa-ca.crt`               | `dev-stack/signing-ca/`  | dev の時刻印の局の根（`CAPTURE_LEDGER_SIGNER_TIMESTAMP_ANCHOR` の dev の値と同じ中身） |

`signed-data.json` が覆う hash:

```
sha256:0be7b2fea93622c434c8f205494e2d0b451acae3803dc87420b6ef51e151239c
```

作り方と、なぜこの組なのかは元の README（BrowserHive の test/fixtures/signing/README.md）に在る。

## 試験の中で作る CA

合本を丸ごと検める試験（`test/replay-bundle-verify.test.ts` など）は、ここの物を使わない。試験が組んだ
`replay.json` の hash に署名する必要があり、決まった hash に署名した物は使い回せないから。

`test/signing-ca.ts` が、試験のたびに使い捨ての CA と時刻印の局を openssl で作り、wacz-signer と同じ形
（ECDSA P-256 で hash の文字列に署名し、その base64 の文字列に RFC 3161 の時刻印を押す）の `signedData` を作る。
鍵は一時のフォルダにだけ在る。

自作の時刻印の局（時刻印の中に自分の根を持ち、`wacz-signer verify` だけなら通る物）も、同じく試験の中で作る。
局の時刻印の `genTime` は「いま」で、ここの `signed-data.json` の葉（2026-10-30 に失効）は、その時点では
鎖の段で先に落ちる —— 時刻印の段だけを落とすには、葉がいま有効でなければならない。

## 秘密ではない

dev の CA の秘密鍵は BrowserHive の `dev-stack/signing-ca/` に在り（ここには写していない）、どのファイル名にも
`insecure-dev-` が付く。どの信頼の置き場にも入らず、それが署名した物を信じる者は居ない。
