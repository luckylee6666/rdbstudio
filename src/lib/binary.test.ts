import { describe, expect, it } from "vitest";
import { base64ByteLength } from "./binary";

describe("base64 byte lengths", () => {
  it.each(["", "AA==", "AP8=", "AP+A", "AQIDBA=="])("counts %s without decoding its bytes", (encoded) => {
    expect(base64ByteLength(encoded)).toBe(atob(encoded).length);
    const wrapped = ` \t${encoded.split("").join("\r\n")}\n`;
    expect(base64ByteLength(wrapped)).toBe(atob(encoded).length);
  });

  it("handles whitespace-only and malformed padding without a negative size", () => {
    expect(base64ByteLength(" \n\t")).toBe(0);
    expect(base64ByteLength("=")).toBe(0);
    expect(base64ByteLength("==\n")).toBe(0);
  });
});
