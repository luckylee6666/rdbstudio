import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ParameterBatchEditor } from "./ParameterBatchEditor";
import { QueryParametersDialog } from "./QueryParametersDialog";
import type { ParameterBatchDraft } from "@/lib/parameterBatch";
import { useI18n } from "@/store/i18n";

const initial: ParameterBatchDraft = { rows: [{ value: "original" }], types: { value: "text" }, atomic: true };
function Editor() {
  const [draft, setDraft] = useState(initial);
  return <ParameterBatchEditor draft={draft} onChange={setDraft} />;
}
function importText(text: string, format: string) {
  fireEvent.click(screen.getByText("Import or paste values"));
  fireEvent.change(screen.getByLabelText("Import format"), { target: { value: format } });
  fireEvent.change(screen.getByLabelText("Batch values to import"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Replace rows with import" }));
}
describe("ParameterBatchEditor", () => {
  beforeEach(() => useI18n.setState({ lang: "en" }));
  it("adds prototype-like names from future modes without inheriting object properties as types", async () => {
    render(<QueryParametersDialog names={["value"]} previous={[]} defaults={[]} connectionName="test"
      previousBatch={initial} onClose={vi.fn()} onRun={vi.fn()} onBatchRun={vi.fn()}
      onPrepareBatch={async () => ["value", "__proto__", "constructor"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    await screen.findByLabelText("Set 1 · __proto__");
    expect(screen.getByLabelText("__proto__ · Type")).toHaveValue("text");
    expect(screen.getByLabelText("constructor · Type")).toHaveValue("text");
    expect(screen.getByLabelText("Set 1 · __proto__")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Run 1 sets" })).toBeEnabled();
  });
  it("imports CSV NULL separately from empty text, and preserves rows after an invalid import", () => {
    render(<Editor />);
    importText('value\n\\N\n""\n"\\N"', "csv");
    expect(screen.getByLabelText("Set 1 · value · NULL")).toBeChecked();
    expect(screen.getByLabelText("Set 1 · value")).toBeDisabled();
    expect(screen.getByLabelText("Set 2 · value · NULL")).not.toBeChecked();
    expect(screen.getByLabelText("Set 2 · value")).toHaveValue("");
    expect(screen.getByLabelText("Set 3 · value")).toHaveValue("\\N");
    fireEvent.change(screen.getByLabelText("Batch values to import"), { target: { value: "wrong\nchanged" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace rows with import" }));
    expect(screen.getByRole("status")).toHaveTextContent("Columns must exactly match");
    expect(screen.getByLabelText("Set 3 · value")).toHaveValue("\\N");
  });
  it("paginates large imports and edits/removes the correct absolute row", () => {
    render(<Editor />);
    importText(JSON.stringify(Array.from({ length: 11 }, (_, i) => ({ value: `row-${i + 1}` }))), "json");
    expect(screen.queryByLabelText("Set 11 · value")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next rows" }));
    expect(screen.getByLabelText("Set 11 · value")).toHaveValue("row-11");
    fireEvent.change(screen.getByLabelText("Set 11 · value"), { target: { value: "updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Previous rows" }));
    expect(screen.getByLabelText("Set 1 · value")).toHaveValue("row-1");
    fireEvent.click(screen.getByRole("button", { name: "Next rows" }));
    expect(screen.getByLabelText("Set 11 · value")).toHaveValue("updated");
    fireEvent.click(screen.getByRole("button", { name: "Remove set 11" }));
    expect(screen.getByLabelText("Set 1 · value")).toHaveValue("row-1");
    expect(screen.getByRole("button", { name: "Next rows" })).toBeDisabled();
  });
  it("does not let a delayed file read replace newer pasted content", async () => {
    render(<Editor />);
    fireEvent.click(screen.getByText("Import or paste values"));
    let complete!: (text: string) => void;
    const file = { name: "old.json", size: 5, text: () => new Promise<string>(resolve => { complete = resolve; }) };
    fireEvent.change(screen.getByLabelText("Choose file"), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Batch values to import"), { target: { value: "value\nnewer" } });
    await act(async () => complete('[{"value":"old"}]'));
    expect(screen.getByLabelText("Batch values to import")).toHaveValue("value\nnewer");
    expect(screen.getByLabelText("Import format")).toHaveValue("csv");
  });
  it("validates off-page values and disables executing an invalid batch", async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ value: String(i) }));
    rows[10].value = "not an integer";
    render(<QueryParametersDialog names={["value"]} previous={[]} defaults={[]} connectionName="test"
      previousBatch={{ ...initial, rows, types: { value: "integer" } }} onClose={vi.fn()} onRun={vi.fn()} onBatchRun={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    await screen.findByLabelText("Set 1 · value");
    expect(screen.getByRole("alert")).toHaveTextContent("Set 11 · value");
    expect(screen.getByRole("button", { name: "Run 11 sets" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next rows" }));
    fireEvent.change(screen.getByLabelText("Set 11 · value"), { target: { value: "9223372036854775807" } });
    expect(screen.getByRole("button", { name: "Run 11 sets" })).toBeEnabled();
  });
});
