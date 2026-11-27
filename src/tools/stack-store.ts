/**
 * `stack:up` が共有の保管庫 (`seaweedfs.crawler-storage`) を確かめるかを決める (t-e5bz)。
 *
 * 保管庫を使わないサービスだけを起こす (`pnpm run stack:up postgres`) ときまで、保管庫が起きていないと止まっていた。
 * **確かめを飛ばすのは、飛ばしてよいと言い切れるときだけ** —— 確かめは「黙って壊れる前提を名指して止める」ための物
 * (`scripts/stack.sh` の preflight) なので、引数を読み違えたときは、飛ばすより確かめるほうが害が小さい。
 *
 * 飛ばしてよいのは、サービスを 1 つ以上名指し、名指した物が全部 `docker-compose.yml` のサービスで、そのどれも
 * (`depends_on` で引き込む先も) 保管庫の名を持たないときだけ。知らない旗・知らない名が 1 つでもあれば確かめる。
 *
 * 保管庫を使うサービスの一覧は書き写さず、compose から読む。写すと、サービスを足した日に食い違う。YAML の
 * anchor と `<<:` (browserhive-2 が browserhive-1 を引き継ぐ) は `merge: true` で解く —— YAML 1.2 の既定では
 * `<<` は鍵のまま残り、引き継いだ `depends_on` を辿れない。
 */
import { parse } from "yaml";

/** 保管庫の名。compose でこの字を持つサービスが保管庫を使う */
export const STORE_HOST = "seaweedfs.crawler-storage";

/**
 * 次の 1 つを値に取る旗。値はサービスの名ではない。`-f`・`--file` (別の compose) は入れない —— 道具が読むのは
 * いつも根の `docker-compose.yml` なので、別の compose を名指されたら判じられない。知らない旗として確かめる
 */
const VALUE_FLAGS = new Set(["--profile", "--env-file", "-p", "--project-name"]);
/** 値を取らない旗として知っている物 (stack.sh の既定の `-d -b` も含む) */
const BARE_FLAGS = new Set(["-d", "--detach", "-b", "--build", "--no-deps", "--force-recreate"]);

export type StoreDecision = { check: true; reason: string } | { check: false; reason: string };

interface ComposeService {
  depends_on?: string[] | Record<string, unknown>;
  extends?: unknown;
  env_file?: unknown;
}

const dependsOn = (service: ComposeService | undefined): string[] => {
  const raw = service?.depends_on;
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : Object.keys(raw);
};

/**
 * `container-compose up` に渡す引数 (stack.sh の `"$@"`) と compose の中身から、保管庫を確かめるかを決める。
 */
export const decideStoreCheck = (args: readonly string[], composeSource: string): StoreDecision => {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      const [flag, inline] = arg.split("=", 2) as [string, string | undefined];
      if (VALUE_FLAGS.has(flag)) {
        if (inline === undefined) i++; // 次の 1 つは値
        continue;
      }
      if (BARE_FLAGS.has(arg)) continue;
      // 値を取るかが分からない。次をサービスの名と読み違えうるので、閉じる向きに倒す
      return { check: true, reason: `知らない旗 ${arg}` };
    }
    names.push(arg);
  }
  if (names.length === 0) return { check: true, reason: "サービスを名指していない (全部を起こす)" };

  const compose = parse(composeSource, { merge: true }) as {
    services?: Record<string, ComposeService>;
  } | null;
  const services = compose?.services ?? {};

  const seen = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    // 素の object を名で引くと、`__proto__` や `constructor` が compose に無いのに何かを返す
    if (!Object.hasOwn(services, name)) return { check: true, reason: `compose に無い名 ${name}` };
    const service = services[name] ?? {};
    // 見るのは塊の字と depends_on だけ。別の file から設定を引き込む鍵 (extends・env_file) が在れば、
    // その先に保管庫の宛先が在るかを言えないので確かめる
    if (service.extends !== undefined || service.env_file !== undefined) {
      return { check: true, reason: `${name} は別の file から設定を引き込む` };
    }
    if (JSON.stringify(service).includes(STORE_HOST)) {
      return { check: true, reason: `${name} が保管庫を使う` };
    }
    queue.push(...dependsOn(service));
  }
  return { check: false, reason: `${names.join(" ")} は保管庫を使わない` };
};
