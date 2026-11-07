import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ConditionEditor } from "./ConditionEditor";
import { compileQuery, emptyGroup, emptyQuery } from "@/lib/queryBuilder";
import { useI18n } from "@/store/i18n";

const source = { id: "u", name: "users", alias: "u", join: "INNER" as const, on: emptyGroup() };
const context = { sources: [source], columns: { u: [{ name: "id", data_type: "INTEGER", nullable: false, is_primary_key: true }] } };
function Harness() {
  const [group, setGroup] = useState(emptyGroup);
  let sql: string;
  try { sql = compileQuery({ ...emptyQuery(), sources: [source], where: group }, "sqlite"); } catch { sql = "incomplete"; }
  return <><ConditionEditor value={group} onChange={setGroup} context={context} label="WHERE" /><output>{sql}</output></>;
}
beforeEach(() => useI18n.setState({ lang: "en" }));

describe("visual condition editing", () => {
  it("changes operator arity and types without keeping hidden operands", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByLabelText("WHERE 1 · Operator"), { target: { value: "BETWEEN" } });
    for (const [i, value] of [[1, "10"], [2, "20"]]) {
      fireEvent.change(screen.getByLabelText(`WHERE 1 · Value ${i} · Value type`), { target: { value: "number" } });
      fireEvent.change(screen.getByLabelText(`WHERE 1 · Value ${i}`), { target: { value } });
    }
    expect(screen.getByRole("status")).toHaveTextContent('"u"."id" BETWEEN 10 AND 20');
    fireEvent.change(screen.getByLabelText("WHERE 1 · Operator"), { target: { value: "IS NULL" } });
    expect(screen.queryByLabelText("WHERE 1 · Value 1")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent('"u"."id" IS NULL');
    fireEvent.change(screen.getByLabelText("WHERE 1 · Operator"), { target: { value: "IN" } });
    fireEvent.click(screen.getByRole("button", { name: "Add value" }));
    fireEvent.change(screen.getByLabelText("WHERE 1 · Value 1"), { target: { value: "a,b" } });
    fireEvent.change(screen.getByLabelText("WHERE 1 · Value 2"), { target: { value: "c'd" } });
    expect(screen.getByRole("status")).toHaveTextContent("IN ('a,b', 'c''d')");
    fireEvent.click(screen.getByRole("button", { name: "WHERE 1 · Remove value 2" }));
    expect(screen.getByRole("status")).toHaveTextContent("IN ('a,b')");
  });

  it("gives deletion controls distinct names and edits nested logic", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.click(screen.getByRole("button", { name: "Add group" }));
    expect(screen.getByRole("button", { name: "WHERE · Remove condition 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "WHERE · Remove condition 2" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("incomplete");
    fireEvent.click(screen.getAllByRole("button", { name: "Add condition" })[1]);
    fireEvent.change(screen.getByLabelText("WHERE.2 · Combine conditions"), { target: { value: "OR" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Add condition" })[1]);
    expect(screen.getByRole("status")).toHaveTextContent('AND ("u"."id" = \'\' OR "u"."id" = \'\')');
    fireEvent.click(screen.getByRole("button", { name: "WHERE · Remove condition 1" }));
    expect(screen.getByRole("button", { name: "WHERE.1 · Remove condition 2" })).toBeInTheDocument();
  });
});
