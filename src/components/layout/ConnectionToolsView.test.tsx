import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { ConnectionToolsView } from "./ConnectionToolsView";

beforeEach(() => {
  useI18n.setState({ lang: "en" });
  useConnections.setState({
    list: [{ id: "other", name: "Other server", driver: "postgres" }, { id: "chosen", name: "Chosen server", driver: "postgres" }],
    status: { other: "connected", chosen: "connected" },
    branches: {},
  });
});
afterEach(clearMocks);

it("honors the connection, schema and sequence selected in the tree", async () => {
  const calls: Array<{ command: string; args: unknown }> = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
    if (command === "list_databases") return ["public", "tenant"];
    if (command === "list_schema_objects") return { objects: [{ kind: "sequence", schema: "tenant", name: "exact_ids" }], truncated: false };
    if (command === "get_sequence_options") return { schema: "tenant", name: "exact_ids", data_type: "bigint", start: "9007199254740993000", increment: "1", min: "1", max: "9223372036854775807", cache: "1", cycle: false };
    throw new Error(`Unexpected command ${command}`);
  });
  render(<ConnectionToolsView kind="objects" initialConnectionId="chosen" initialSchema="tenant" objectKind="sequence" objectName="exact_ids" />);
  expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("exact_ids");
  expect(screen.getByRole("textbox", { name: "Schema" })).toHaveValue("tenant");
  expect(calls.find((call) => call.command === "get_sequence_options")?.args).toEqual({ id: "chosen", schema: "tenant", name: "exact_ids" });
  expect(calls.some((call) => call.command === "list_managed_objects")).toBe(false);
});
