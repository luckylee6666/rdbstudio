import { describe, expect, it } from "vitest";
import { parseGridCellInput } from "./TableDataGrid";

describe("parseGridCellInput", () => {
  const bigint = { data_type: "BIGINT UNSIGNED", nullable: false };

  it("keeps safe integer edits numeric", () => {
    expect(parseGridCellInput("42", bigint)).toBe(42);
    expect(parseGridCellInput("9007199254740991", bigint)).toBe(
      9_007_199_254_740_991
    );
  });

  it("preserves large integer edits as exact decimal strings", () => {
    expect(parseGridCellInput("9007199254740992", bigint)).toBe(
      "9007199254740992"
    );
    expect(parseGridCellInput("18446744073709551615", bigint)).toBe(
      "18446744073709551615"
    );
    expect(
      parseGridCellInput("-9223372036854775808", {
        data_type: "BIGINT",
        nullable: false,
      })
    ).toBe("-9223372036854775808");
  });

  it("retains existing null and non-numeric behavior", () => {
    expect(
      parseGridCellInput("", { data_type: "INT", nullable: true })
    ).toBeNull();
    expect(
      parseGridCellInput("007", { data_type: "VARCHAR", nullable: false })
    ).toBe("007");
  });
});
