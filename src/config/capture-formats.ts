/**
 * この配備が取り込む形式。**env から決める。**
 *
 * 呼び出し元 (body) からは受けない。境界の取り決めが「外は *いつ* を決め、ledger が
 * *何を どう* 投げるかを決める」であり、形式は後者だから。
 *
 * 既定は `wacz` —— このパイプラインが作るのは再生できるアーカイブで、他の形式は
 * その付随物。1 つも選ばれていない設定は server が `INVALID_ARGUMENT` で弾くので、
 * 「形式なし」は既定になり得ない。
 *
 * ## なぜ api/runs.ts から出したのか
 *
 * クロールの経路も同じ設定を要るようになったため。**投げるのは Windmill の flow だが、
 * 何をどう投げるかを決めるのは依然として ledger** で、flow へは dispatch の payload で
 * 渡す。ここに置いておけば、綴りの検査が経路によらず 1 か所で済む。
 */

/** BrowserHive が受け取る 6 つ。**全部を明示して送る** —— 未設定と false は別物。 */
export const KNOWN_FORMATS = ["png", "webp", "html", "links", "mhtml", "wacz"] as const;

export type CaptureFormat = (typeof KNOWN_FORMATS)[number];
export type CaptureFormats = Record<CaptureFormat, boolean>;

export interface CaptureSettings {
  formats: CaptureFormats;
  signing: boolean;
}

const isKnownFormat = (value: string): value is CaptureFormat =>
  (KNOWN_FORMATS as readonly string[]).includes(value);

/**
 * `CAPTURE_LEDGER_CAPTURE_FORMATS` を読む。**起動時に呼ぶこと。**
 *
 * 綴りの誤りをここで落とすためにある。実行のたびに解釈すると、`waxz` のような
 * 打ち間違いは夜中の定期実行が失敗して初めて見つかる —— しかも server が返すのは
 * 「形式が 1 つも無い」で、env の値には一言も触れない。
 */
export const parseCaptureFormats = (raw: string, signing: boolean): CaptureSettings => {
  const names = raw
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== "");

  const unknown = names.filter((name) => !isKnownFormat(name));
  if (unknown.length > 0) {
    throw new Error(
      `CAPTURE_LEDGER_CAPTURE_FORMATS has unknown formats: ${unknown.join(", ")} ` +
        `(known: ${KNOWN_FORMATS.join(", ")})`,
    );
  }
  if (names.length === 0) {
    throw new Error(
      "CAPTURE_LEDGER_CAPTURE_FORMATS is empty: at least one capture format is required",
    );
  }
  // CLI では `parseClientOptions` が同じことを言う。HTTP 経路はそこを通らないので、
  // ここが唯一この検査の在る場所。
  if (signing && !names.includes("wacz")) {
    throw new Error(
      "CAPTURE_LEDGER_CAPTURE_SIGNING requires wacz in CAPTURE_LEDGER_CAPTURE_FORMATS",
    );
  }

  const chosen = new Set(names);
  const formats = Object.fromEntries(
    // **`links` は設定に関わらず、どの深さでも頼む。** 無いとリンクを数えられず、「数えなかった」が
    // 「リンクが 1 本も無かった」に見える。読み込み済みの DOM を読むだけなので、相手への要求は増えない。
    KNOWN_FORMATS.map((name) => [name, name === "links" || chosen.has(name)]),
  ) as CaptureFormats;
  return { formats, signing };
};
