import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionConfig, McpAuthorization } from "@/types";
import { useI18n } from "@/store/i18n";
import { McpAccessDialog, buildAiInstructions } from "./McpAccessDialog";

const config: ConnectionConfig = {
  id: "prod-db",
  name: "Production reporting",
  driver: "postgres",
  host: "secret.internal",
  port: 5432,
  username: "admin",
};

const authorization: McpAuthorization = {
  server_url: "http://127.0.0.1:43123/mcp",
  token: "temporary-token",
  connection_id: config.id,
  connection_name: config.name,
  expires_at: "2026-08-21T13:00:00Z",
  config_json: `{
  "mcpServers": {
    "rdbstudio": {
      "type": "http",
      "url": "http://127.0.0.1:43123/mcp",
      "headers": { "Authorization": "Bearer temporary-token" }
    }
  }
}`,
};

describe("McpAccessDialog", () => {
  beforeEach(() => {
    clearMocks();
    useI18n.setState({ lang: "zh" });
  });

  afterEach(() => clearMocks());

  it("creates a one-hour authorization scoped to the selected connection", async () => {
    const calls: Array<Record<string, unknown>> = [];
    mockIPC((command, payload) => {
      if (command === "create_mcp_authorization") {
        calls.push(payload as Record<string, unknown>);
        return authorization;
      }
      return undefined;
    });

    render(<McpAccessDialog open config={config} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "创建授权" }));

    await waitFor(() => expect(calls).toEqual([{ id: "prod-db", ttlMinutes: 60 }]));
    expect(await screen.findByText("授权已就绪")).toBeInTheDocument();
    expect(screen.getByText(authorization.server_url)).toBeInTheDocument();
    expect(screen.queryByText(config.host!)).not.toBeInTheDocument();
  });

  it("builds pasteable instructions without database credentials", () => {
    const text = buildAiInstructions(authorization, "zh");
    expect(text).toContain("rdbstudio MCP");
    expect(text).toContain("Production reporting");
    expect(text).toContain("Bearer temporary-token");
    expect(text).not.toContain("secret.internal");
    expect(text).not.toContain("admin");
  });
});
