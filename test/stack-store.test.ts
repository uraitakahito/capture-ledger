/**
 * `stack:up` が共有の保管庫を確かめるかの判断 (`src/tools/stack-store.ts`・t-e5bz)。
 *
 * 本物の `docker-compose.yml` を読む —— 保管庫を使うサービスの一覧は compose にしか無いので、試験も同じ物を見る。
 * anchor と `<<:` を辿る所・`depends_on` を辿る所は、作り物の compose で見る (今の compose には、保管庫を使う
 * サービスを `depends_on` で引き込む物が無い)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decideStoreCheck } from "../src/tools/stack-store.js";

const COMPOSE = readFileSync(join(import.meta.dirname, "..", "docker-compose.yml"), "utf8");
const decide = (args: string[], compose = COMPOSE) => decideStoreCheck(args, compose);

describe("本物の docker-compose.yml", () => {
  it("postgres だけなら飛ばす", () => {
    expect(decide(["postgres"]).check).toBe(false);
  });

  it("browserhive-1 は保管庫を使うので確かめる", () => {
    expect(decide(["browserhive-1"])).toEqual({
      check: true,
      reason: "browserhive-1 が保管庫を使う",
    });
  });

  it("browserhive-2 は anchor (<<: *browserhive) で引き継いだ設定で保管庫を使うので確かめる", () => {
    expect(decide(["browserhive-2"]).check).toBe(true);
  });

  it("replayweb-player と capture-player も確かめる", () => {
    expect(decide(["replayweb-player"]).check).toBe(true);
    expect(decide(["capture-player"]).check).toBe(true);
  });

  it("名指さない (全部を起こす) なら確かめる", () => {
    expect(decide([]).check).toBe(true);
    expect(decide(["-d", "-b"]).check).toBe(true);
  });

  it("値を取る旗の値はサービスの名と読まない (--profile search opensearch)", () => {
    expect(decide(["--profile", "search", "opensearch"]).check).toBe(false);
    expect(decide(["--profile=search", "opensearch"]).check).toBe(false);
  });

  it("profile とサービスが同じ名でも、値と名を分けて読む (--profile capture-fixtures capture-fixtures)", () => {
    expect(decide(["--profile", "capture-fixtures", "capture-fixtures"]).check).toBe(false);
  });

  it("知らない旗が来たら確かめる (値を取るかが分からない)", () => {
    expect(decide(["--timeout", "10", "postgres"])).toEqual({
      check: true,
      reason: "知らない旗 --timeout",
    });
  });

  it("compose に無い名が 1 つでもあれば確かめる", () => {
    expect(decide(["postgres", "no-such-service"]).check).toBe(true);
  });

  it("object の持つ名 (__proto__・constructor) も compose に無い名として確かめる", () => {
    expect(decide(["__proto__"])).toEqual({ check: true, reason: "compose に無い名 __proto__" });
    expect(decide(["constructor"])).toEqual({
      check: true,
      reason: "compose に無い名 constructor",
    });
  });

  it("別の compose (-f・--file) を名指したら確かめる (読むのは根の docker-compose.yml だけ)", () => {
    expect(decide(["-f", "other.yml", "postgres"]).check).toBe(true);
    expect(decide(["--file=other.yml", "postgres"]).check).toBe(true);
  });

  it("保管庫を使わない物と使う物を一緒に名指せば確かめる", () => {
    expect(decide(["postgres", "browserhive-1"]).check).toBe(true);
  });
});

describe("作り物の compose", () => {
  const compose = `
services:
  store-user:
    environment:
      S3: http://seaweedfs.crawler-storage:8333
  base: &base
    image: x
    depends_on:
      - store-user
  plain:
    image: y
  pulls-store:
    image: z
    depends_on:
      store-user:
        condition: service_started
  inherits:
    <<: *base
  from-file:
    image: w
    env_file: other.env
  extended:
    extends:
      file: other.yml
      service: x
`;

  it("depends_on で保管庫を使うサービスを引き込むなら確かめる (配列の形も object の形も)", () => {
    expect(decide(["base"], compose).check).toBe(true);
    expect(decide(["pulls-store"], compose).check).toBe(true);
  });

  it("<<: で引き継いだ depends_on も辿る", () => {
    expect(decide(["inherits"], compose).check).toBe(true);
  });

  it("別の file から設定を引き込む (env_file・extends) なら確かめる", () => {
    expect(decide(["from-file"], compose).check).toBe(true);
    expect(decide(["extended"], compose).check).toBe(true);
  });

  it("どれも保管庫に届かなければ飛ばす", () => {
    expect(decide(["plain"], compose)).toEqual({
      check: false,
      reason: "plain は保管庫を使わない",
    });
  });
});
