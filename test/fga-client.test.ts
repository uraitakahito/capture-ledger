import { describe, it, expect } from "vitest";
import { FgaUnreachableError, isAlreadyInDesiredState, isUnreachable } from "../src/fga/client.js";

/**
 * OpenFGA v1.10.2 で実測した形。この判定を誤ると、どちらの向きにも高くつく:
 * 厳しすぎれば決して成功しない行で outbox が詰まり、緩すぎれば tuple が入って
 * いない行を配送済みにする —— そして欠けた tuple は、誰かが不当に拒まれるという
 * 形でしか表に出ない。
 */
const fgaError = (code: string, message: string): unknown => ({
  name: "FgaApiValidationError",
  responseData: { code },
  message: `FGA API Validation Error: post write : ${message}`,
});

describe("isAlreadyInDesiredState", () => {
  it("accepts writing a tuple that already exists", () => {
    expect(
      isAlreadyInDesiredState(
        fgaError(
          "write_failed_due_to_invalid_input",
          "Error cannot write a tuple which already exists: user: 'organization:acme', relation: 'parent', object: 'capture_job:x'",
        ),
      ),
    ).toBe(true);
  });

  it("accepts deleting a tuple that is not there", () => {
    expect(
      isAlreadyInDesiredState(
        fgaError(
          "write_failed_due_to_invalid_input",
          "Error cannot delete a tuple which does not exist: user: 'organization:acme', relation: 'parent', object: 'capture_job:x'",
        ),
      ),
    ).toBe(true);
  });

  // 未知の relation はモデルの誤り。飲み込むと、その行を配送済みにして tuple を
  // 完全に失う。
  it("rejects a validation error from a bad relation", () => {
    expect(
      isAlreadyInDesiredState(
        fgaError("validation_error", "Error Invalid tuple 'capture_job:x#nope@organization:x'"),
      ),
    ).toBe(false);
  });

  // code は同じで原因が違う —— それを分けているのは message のほう。
  it("rejects another invalid-input failure that is not about existence", () => {
    expect(
      isAlreadyInDesiredState(
        fgaError("write_failed_due_to_invalid_input", "Error something else entirely"),
      ),
    ).toBe(false);
  });

  it("rejects transport and unknown errors", () => {
    expect(isAlreadyInDesiredState(new Error("socket hang up"))).toBe(false);
    expect(isAlreadyInDesiredState(undefined)).toBe(false);
    expect(isAlreadyInDesiredState(null)).toBe(false);
    expect(isAlreadyInDesiredState("boom")).toBe(false);
  });
});

/**
 * 届かなかったのか、OpenFGA が答えた誤りなのか。SDK の `FgaError` は元の誤りを持たないので、
 * 見分けは文だけでする —— その文が、どちらの向きにも取り違えないことを見る。
 */
describe("isUnreachable", () => {
  it("localhost の 2 つとも断られた誤りを、届かなかったと見る（実際に出た文）", () => {
    expect(
      isUnreachable(
        new Error("FGA Error: connect ECONNREFUSED ::1:8090; connect ECONNREFUSED 127.0.0.1:8090"),
      ),
    ).toBe(true);
  });

  it("名前が引けない・時間切れも、届かなかったと見る", () => {
    expect(
      isUnreachable(new Error("FGA Error: getaddrinfo ENOTFOUND openfga.capture-ledger")),
    ).toBe(true);
    expect(isUnreachable(new Error("FGA Error: connect ETIMEDOUT 10.0.0.1:8090"))).toBe(true);
  });

  it("OpenFGA が答えた誤りは、届かなかったと見ない", () => {
    expect(
      isUnreachable(
        new Error(
          "FGA API Validation Error: post write : Error cannot write a tuple which already exists",
        ),
      ),
    ).toBe(false);
    expect(isUnreachable(new Error("FGA API Internal Error: post write : boom"))).toBe(false);
  });

  it("Error でないものは見ない", () => {
    expect(isUnreachable("connect ECONNREFUSED 127.0.0.1:8090")).toBe(false);
  });
});

describe("FgaUnreachableError", () => {
  it("宛先と直し方を名指しし、元の文も添える", () => {
    const { message } = new FgaUnreachableError(
      "http://localhost:8090",
      "FGA Error: connect ECONNREFUSED 127.0.0.1:8090",
    );
    expect(message).toContain("OpenFGA (http://localhost:8090) に届きません");
    expect(message).toContain("pnpm run stack:up");
    expect(message).toContain("ECONNREFUSED 127.0.0.1:8090");
  });
});
