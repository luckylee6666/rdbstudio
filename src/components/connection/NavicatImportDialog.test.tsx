import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig, NavicatImportPreview } from "@/types";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { NavicatImportDialog } from "./NavicatImportDialog";

const existing: ConnectionConfig = {
  id: "existing",
  name: "Local MySQL",
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  username: "root",
  ssl_mode: "disable",
};

const preview: NavicatImportPreview = {
  source_count: 2,
  connections: [
    { ...existing, id: "" },
    {
      id: "",
      name: "Reporting",
      driver: "postgres",
      host: "db.local",
      port: 5432,
      username: "reporter",
      ssl_mode: "require",
    },
  ],
  unsupported_types: [],
  password_count: 1,
  ssh_password_count: 0,
  http_tunnel_count: 0,
  unsupported_ssl_count: 0,
};

describe("NavicatImportDialog", () => {
  beforeEach(() => {
    clearMocks();
    useI18n.setState({ lang: "zh" });
    useConnections.setState({ list: [existing] });
  });

  it("marks duplicates, imports selected candidates, and never forwards a password", async () => {
    const saved: ConnectionConfig[] = [];
    mockIPC((command, payload) => {
      if (command !== "save_connection") return undefined;
      const config = (payload as { config: ConnectionConfig }).config;
      saved.push(config);
      return { ...config, id: `new-${saved.length}` };
    });
    const onClose = vi.fn();

    render(
      <NavicatImportDialog
        open
        preview={preview}
        fileName="connections.ncx"
        onClose={onClose}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "导入 Navicat 连接" });
    expect(within(dialog).getByText("已存在")).toBeInTheDocument();
    expect(within(dialog).getByText("已选择 1 / 2 个")).toBeInTheDocument();
    expect(within(dialog).getByText(/检测到 1 个加密密码字段/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "导入 .ncx" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Reporting");
    expect(saved[0].password).toBeNull();
  });
});
