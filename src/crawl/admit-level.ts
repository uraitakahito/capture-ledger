/**
 * クロールで取り込めたページを台帳に載せる。**失敗の報告も一度は当たってみる。**
 *
 * ## なぜ要るのか
 *
 * クロールの経路は **`archives` に 1 行も書いていなかった**。当時 `admitArchive` を
 * 呼んでいたのは畳んだ CLI 経路 (client/run.ts) と `archive/reconcile.ts` だけで、
 * クロールは `crawl_pages` と `capture_submissions` にしか跡を残さない。実測でも、
 * 10 ページ取り込んだクロールに対して台帳の該当行は 0 件だった。**この file が
 * 3 つ目の呼び出し元**になる。
 *
 * 結果として、クロールしたページは **`reconcile` を走らせるまで存在しない**
 * ことになっていた —— picker にも出ず、索引にも載らない。取り込んだ本人が
 * 台帳を書けるのに、掃除役の巡回を待っていた。
 *
 * ## 報告からは登録できない
 *
 * 段の報告が運ぶのは `taskId` と状態と manifest の置き場所だけで、`admitArchive` が要る
 * `CaptureResultReport` (成果物の在り処、`waczComplete`、署名、取り込み時刻) は
 * 入っていない。だから **S3 の manifest を、報告された鍵で読み直す**。鍵はこちらで
 * 組まない —— 書いた本人が応答で答えた場所を、flow がそのまま運んでくる。
 *
 * 同じ handler が `.links.json` を S3 から読んでいるので、経路は増えない。
 *
 * ## 失敗の報告も渡してよい

 * 渡すのは「`taskId` を持つ全件」で、報告上の状態は問わない。報告は flow が
 * BrowserHive の答えをどう受け取ったかで、正本は BrowserHive 自身が成果物の隣に
 * 書く manifest —— 食い違えば manifest を採る。`failed` と報告されたページに
 * 成功の manifest が在れば、**取り込み自体は成功していて成果物は S3 に在る**。
 *
 * **切られた取り込みだけは拾えない。** flow の deadline が尽きると BrowserHive は
 * (v9.1.0 以降) ページを壊し、`cancelled` の manifest を書く —— 成果物が無いので
 * `admitArchive` が弾く。それで正しい: 拾う先が無い。
 *
 * 拾えたかどうかは `admittedUrls` が答える。呼ぶ側はそれを見て `crawl_pages` の
 * 状態を上げる —— そこまでやらないと、台帳には在るのにクロールの記録では
 * 失敗している、という食い違いが残る。
 *
 * ## 無いものは飛ばす
 *
 * manifest が見つからない `taskId` は黙って飛ばす。BrowserHive が書き終える前に
 * 段が閉じることはありうるし、そのときは `reconcile` が後で拾う ——
 * 畳んだ CLI 経路が "Could not collect this capture; reconcile will retry" と
 * 言っていたのと同じ立場。
 * **ここで投げると、段の報告ごと 500 になって進行が止まる。** 台帳が遅れることより
 * クロールが止まることのほうが重い。
 */
import type { Kysely } from "kysely";
import type { S3Client } from "@aws-sdk/client-s3";
import { readManifest } from "../archive/manifest.js";
import { getJsonObject } from "../archive/s3.js";
import { admitArchive } from "../archive/admit.js";
import type { Database } from "../db/database.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger({ module: "crawl-admit-level" });

/** 段の報告のうち、台帳に載せうるもの。 */
export interface CapturedPage {
  taskId: string;
  url: string;
  /**
   * 報告が運んだ manifest の鍵 (bucket を除く)。書けなかった、または台帳に読めない場所
   * だった取り込みには無い (`archive/manifest.ts` の `manifestOutcome`)。
   */
  manifestKey: string | null;
}

export interface AdmitLevelOptions {
  db: Kysely<Database>;
  s3: S3Client;
  bucket: string;
  crawlId: string;
  orgId: string;
  requestedBy: string;
}

export interface AdmitLevelResult {
  /** 台帳に入った件数。 */
  registered: number;
  /**
   * **実際に成功していたと分かった URL。** 報告が `failed` でも、manifest が
   * 成功を語っていればここに入る。呼ぶ側はこれを見て記録を直す。
   */
  admittedUrls: string[];
}

/**
 * 渡されたページを順に台帳へ。
 *
 * `admitArchive` は `(bucket, object_key)` の unique で冪等なので、同じ段が
 * 二度報告されても増えない。**逐次で回す** —— 段あたり高々ホスト数ぶんで、
 * 並列にする理由が無い。
 */
export const admitLevel = async (
  pages: CapturedPage[],
  options: AdmitLevelOptions,
): Promise<AdmitLevelResult> => {
  let registered = 0;
  const admittedUrls: string[] = [];
  for (const page of pages) {
    // **鍵は報告が運んだもの。** 書けなかった取り込みには、読みに行く先が無い。
    if (page.manifestKey === null) continue;
    const key = page.manifestKey;
    try {
      const raw = await getJsonObject(options.s3, options.bucket, key);
      if (raw === undefined) {
        log.debug({ taskId: page.taskId, key }, "no manifest yet; leaving it to reconcile");
        continue;
      }
      const result = await admitArchive(
        options.db,
        readManifest(raw),
        options.orgId,
        options.requestedBy,
      );
      if (result.archiveId !== undefined) {
        registered += 1;
        admittedUrls.push(page.url);
      }
    } catch (err) {
      // 1 件の失敗で段を落とさない。上の docstring のとおり、遅れて拾えるものは遅れてよい。
      log.warn(
        { err, taskId: page.taskId, key },
        "could not register this page; reconcile will retry",
      );
    }
  }
  log.info({ crawlId: options.crawlId, reported: pages.length, registered }, "level registered");
  return { registered, admittedUrls };
};
