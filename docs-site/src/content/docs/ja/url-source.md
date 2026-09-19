---
title: URL ソース
description: capture-ledger が読む capture_targets テーブルと、その運用方法。
---

capture-ledger の入力は Postgres のテーブル 1 つだけです。**capture-ledger 自身は INSERT しません** —
`capture_targets` への投入は呼び出し側の責務で、手動 `INSERT` でも、外部パイプラインでも、
同梱の seed でもかまいません。

## クエリ

`fromTargets` で起こしたクロールが読むのは、これだけです。

```sql
SELECT url FROM capture_targets WHERE enabled AND org_id = $1 ORDER BY id ASC [LIMIT $2]
```

`ORDER BY id ASC` なので**登録順に種になり**、`fromTargets.limit` は先頭 n 件を
取ります。つまり動作確認では常に同じ URL が対象になります。`org_id` で絞るのが
テナントの境目です —— クロールは組織を 1 つしか持たないので、別の組織の行を
種にすると帰属が言えなくなります。

## スキーマ

```ts file="src/db/migrations/001-create-capture-targets.ts#capture-targets-columns"

```

| カラム                      | 補足                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `BIGSERIAL` 主キー。投入順で、ローダの `ORDER BY` がそれを保つ。                                                                                                            |
| `url`                       | `CHECK (url <> '' AND url = btrim(url))` と `CHECK (url ~* '^https?://')` —— 空文字・前後の空白・http(s) でない値をデータベースが拒否するので、呼ぶ側で検査する必要がない。 |
| `url_hash`                  | 生成列 `digest(url, 'sha256')` (pgcrypto) を stored 保存。ユニークインデックスの土台で、直接読むことはない。                                                                |
| `labels`                    | `TEXT[]`。**もう誰も読みません** —— 下記を参照。                                                                                                                            |
| `enabled`                   | ホットパスは `WHERE enabled` で、部分インデックス `capture_targets_enabled_id_idx` が覆う。無効行はコストにならない。                                                       |
| `org_id`                    | どの組織の対象か。**既定値は無い** —— `INSERT` では必ず書く（書かなければ `NOT NULL` で落ちる）。`fromTargets` はこれで絞る。                                               |
| `created_at` / `updated_at` | `now()` 既定。自動更新トリガは今のところ無い。                                                                                                                              |

`capture_targets_org_url_hash_key` は `(org_id, url_hash)` のユニーク索引です。
1 つの組織の中では、同じ URL を二重に登録できません。
別々の組織なら、同じ URL をそれぞれの対象にできます。

## labels の使い方

:::caution[labels はもう運ばれません]
列は残っていますし seed も埋めますし、台帳にも `labels` 列があります —— ですが
**クロールの経路が読むのは `url` だけ**で、投げるときの labels は空です。つまり今の
labels は BrowserHive にも成果物のファイル名にも届きません。対象の行に付けた注記で
あって、下流に出てくるものだとは考えないでください。
:::

かつては自由形式で成果物のファイル名に入り、**外部キーを持たせる場所**として自然でした。
「自由形式」は文字どおりで、ファイル名の構造とぶつかる文字（`_` `.` `/` 空白）は
BrowserHive が逃がすため、非 ASCII も含めてそのまま往復し、制限は「成果物の名前全体が
255 UTF-8 バイトに収まること」だけでした。同梱のサンプルは今も証券コードと社名を
並べています。

```ts
{ url: "https://www.ana.co.jp/group/", labels: ["9202", "ANAHoldings"] }
```

## URL を追加する

```sql
INSERT INTO capture_targets (url, org_id, labels) VALUES
  ('https://example.com/', 'acme', ARRAY['example']),
  ('https://example.org/', 'acme', ARRAY['example', 'org'])
ON CONFLICT (org_id, url_hash) DO NOTHING;
```

`org_id` は必ず書きます。既定値が無いので、書かなければ `NOT NULL` で断られます。
クロールは、呼んだ人の組織の行だけを種にします。

履歴を残したまま対象から外したいときは、行を削除せず `enabled = false` にします。

## マイグレーション

マイグレーションは `src/db/migrations/<NNN>-<説明>.ts` に置き、`up(db)` /
`down(db)` を export します。ランナーは Kysely の `Migrator` +
`FileMigrationProvider` の薄いラッパで、適用済み ID を `kysely_migration`
テーブルで管理します (同時実行は `kysely_migration_lock` が守ります)。最新の状態で
`pnpm run db:migrate` を再実行しても何も起きません。

```sh
pnpm run db:migrate       # 適用
pnpm run db:migrate:down  # 直前の 1 つを巻き戻す
```

追加するときは:

1. 次の連番を取る (例 `002-add-priority.ts`)。
2. スキーマビルダで `up` / `down` を実装する。ビルダで書けないもの (拡張、生成列、
   他カラムを参照する `CHECK`) は ``sql`…`.execute(db)`` を使う。
3. ローカルで往復させる:
   `pnpm run db:migrate && pnpm run db:migrate:down && pnpm run db:migrate`。
   CI も同じ往復を実行します。
4. マイグレーションと、それに依存するコードは同じ PR でコミットする。

seed も `src/db/seeds/` に同じ形で置きますが、記録は `kysely_seed` と別なので、
マイグレーションとは独立に適用・巻き戻しできます。
