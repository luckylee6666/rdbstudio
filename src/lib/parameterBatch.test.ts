import { describe, expect, it } from "vitest";
import { parameterBatchIssue, parameterSets, parseParameterRows } from "./parameterBatch";

describe("batch parameter input", () => {
  it("preserves quoted delimiters, multiline text, empty text, NULL and literal NULL markers", () => {
    const rows = parseParameterRows('\uFEFFid,note\r\n9223372036854775807,"hello,\r\n""world"""\r\n2,\\N\r\n3,"\\N"\r\n4,\r\n', "csv", ["note", "id"]);
    expect(rows).toEqual([
      { id: "9223372036854775807", note: 'hello,\r\n"world"' },
      { id: "2", note: null }, { id: "3", note: "\\N" }, { id: "4", note: "" },
    ]);
    expect(parameterSets(rows, { id: "integer", note: "text" })[0][0].value).toBe("9223372036854775807");
  });
  it("supports TSV and JSON without converting numeric text", () => {
    expect(parseParameterRows('id\tnote\n1\t"a\tb"', "tsv", ["id", "note"])).toEqual([{ id: "1", note: "a\tb" }]);
    expect(parseParameterRows('[{"id":"9223372036854775807","note":null}]', "json", ["id", "note"])).toEqual([{ id: "9223372036854775807", note: null }]);
    expect(() => parseParameterRows('[{"id":9223372036854775807}]', "json", ["id"])).toThrow("strings");
  });
  it("rejects malformed quoting, mismatched headers, missing cells and unbounded rows", () => {
    for (const text of ['id,id\n1,2', 'id,extra\n1,2', 'id,note\n1', 'id,note\n1,"open', 'id,note\n1,"closed"tail']) {
      expect(() => parseParameterRows(text, "csv", ["id", "note"])).toThrow();
    }
    expect(() => parseParameterRows('id\n' + '1\n'.repeat(101), "csv", ["id"])).toThrow("rows");
    expect(() => parseParameterRows('[{"id":"1","extra":"2"}]', "json", ["id"])).toThrow("header");
    expect(() => parseParameterRows('id\n' + 'x'.repeat(8 * 1024 * 1024), "csv", ["id"])).toThrow("size");
  });
  it("reports the exact invalid set and validates types without coercion", () => {
    expect(parameterBatchIssue([{ id: "1" }, { id: "9223372036854775808" }], { id: "integer" })).toEqual({ code: "value.integer", row: 2, name: "id" });
    expect(parameterBatchIssue([{ id: null }], { id: "integer" })).toBeNull();
    expect(parameterBatchIssue([{ id: "" }], { id: "integer" })?.code).toBe("value.integer");
    expect(parameterBatchIssue([{ id: "" }], { id: "text" })).toBeNull();
  });
  it("treats prototype-looking parameter names as ordinary own properties", () => {
    const row = parseParameterRows('[{"__proto__":"value","constructor":null}]', "json", ["__proto__", "constructor"])[0];
    expect(Object.hasOwn(row, "__proto__")).toBe(true);
    expect(parameterSets([row], Object.fromEntries([["__proto__", "text"], ["constructor", "text"]]))).toEqual([[{ name: "__proto__", kind: "text", value: "value" }, { name: "constructor", kind: "text", value: null }]]);
  });
});
