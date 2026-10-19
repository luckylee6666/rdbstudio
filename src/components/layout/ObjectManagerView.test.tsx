import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectManagerView } from "./ObjectManagerView";
import { useI18n } from "@/store/i18n";
import { useConnections } from "@/store/connections";

vi.mock("@/components/editor/CodeMirror", () => ({
  CodeMirrorEditor: ({ value, onChange }: { value: string; onChange: (text: string) => void }) =>
    <textarea aria-label="Definition" value={value} onChange={(event) => onChange(event.target.value)} />,
}));

describe("Object manager object identity", () => {
  beforeEach(() => useI18n.setState({ lang: "en" }));
  afterEach(clearMocks);

  it("preserves the selected PostgreSQL overload through refresh and replacement", async () => {
    const first = { kind: "function", schema: "public", name: "lookup", identity: "v integer", definition: "CREATE FUNCTION lookup(v integer) RETURNS integer LANGUAGE SQL AS 'SELECT v'", drop_sql: 'DROP FUNCTION "public"."lookup"(v integer)' };
    const second = { ...first, identity: "v text", definition: "CREATE FUNCTION lookup(v text) RETURNS text LANGUAGE SQL AS 'SELECT v'", drop_sql: 'DROP FUNCTION "public"."lookup"(v text)' };
    const replacements: Record<string, unknown>[] = [];
    mockIPC((cmd, args) => {
      if (cmd === "list_managed_objects") return { objects: [first, second], users: [], supported: ["function"] };
      if (cmd === "replace_managed_object_definition") replacements.push(args as Record<string, unknown>);
      return undefined;
    });
    render(<ObjectManagerView connectionId="pg" driver="postgres" schema="public" />);
    fireEvent.click(await screen.findByRole("button", { name: "lookup(v text)" }));
    expect(screen.getByRole("textbox", { name: "Definition" })).toHaveValue(second.definition);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    fireEvent.change(screen.getByRole("textbox", { name: "Definition" }), { target: { value: second.definition + ";" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    const dialog = screen.getByRole("dialog");
    const confirm = Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === "Replace");
    expect(confirm).toBeTruthy();
    fireEvent.click(confirm!);
    await waitFor(() => expect(replacements).toHaveLength(1));
    expect(replacements[0]).toMatchObject({ original: second.definition, dropSql: second.drop_sql, definition: second.definition + ";" });
  });
});

describe("table-scoped object manager", () => {
  beforeEach(() => useI18n.setState({ lang: "en" }));
  afterEach(clearMocks);

  it("requests and displays only this table's triggers without exposing users", async () => {
    const requests: Record<string, unknown>[] = [];
    const catalog = {
      objects: [
        { kind: "trigger", schema: "public", name: "alpha_trigger", table: "alpha", definition: "CREATE TRIGGER alpha_trigger", drop_sql: "DROP TRIGGER alpha_trigger" },
        { kind: "trigger", schema: "public", name: "beta_trigger", table: "beta", definition: "CREATE TRIGGER beta_trigger", drop_sql: "DROP TRIGGER beta_trigger" },
        { kind: "function", schema: "public", name: "private_function", definition: "CREATE FUNCTION private_function", drop_sql: "DROP FUNCTION private_function" },
      ],
      users: [{ name: "private_user", grants: [] }],
      supported: ["trigger", "function", "user"],
    };
    mockIPC((command, payload) => {
      if (command === "list_managed_objects") {
        requests.push(payload as Record<string, unknown>);
        return catalog;
      }
      return undefined;
    });

    render(<ObjectManagerView connectionId="pg" driver="postgres" schema="public" table="alpha" />);

    expect(await screen.findByRole("button", { name: /alpha_trigger/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /beta_trigger/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "private_function" })).toBeNull();
    expect(screen.queryByText("private_user")).toBeNull();
    expect(requests[0]).toMatchObject({ id: "pg", schema: "public", table: "alpha" });
  });
});

describe("Object manager privilege scopes", () => {
  beforeEach(() => {
    useI18n.setState({lang: "en"});
    useConnections.setState({list:[{id:"pg",name:"PG",driver:"postgres",database:"postgres"}]});
  });
  afterEach(clearMocks);
  it("uses database and schema privileges with the correct target", async () => {
    const grants: Record<string,unknown>[]=[];
    mockIPC((command,payload) => {
      if(command==="list_managed_objects") return {objects:[],users:[{name:"reader",grants:[]}],supported:["user","permission","trigger"]};
      if(command==="apply_managed_grants") grants.push(payload as Record<string,unknown>);
      return undefined;
    });
    render(<ObjectManagerView connectionId="pg" schema="public" driver="postgres" />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Users & privileges/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /Users & privileges/ }));
    await screen.findByRole("option", { name: "reader" });
    fireEvent.change(screen.getByRole("combobox", { name: "Select a user" }), { target: { value: "reader\u0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Database" }));
    expect(screen.getByRole("button", { name: "CONNECT" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "SELECT" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(grants[0]).toMatchObject({ database: "postgres", scope: "database", object: null, privileges: ["CONNECT"] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Grant" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Schema" }));
    expect(screen.getByRole("button", { name: "USAGE" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Grant" }));
    await waitFor(() => expect(grants[1]).toMatchObject({ database: "public", scope: "schema", object: null, privileges: ["USAGE"] }));
  });
});
