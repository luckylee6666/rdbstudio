import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { ConnectionDialog } from "./ConnectionDialog";

describe("ConnectionDialog", () => {
  beforeEach(() => {
    useI18n.setState({ lang: "zh" });
    useConnections.setState({ list: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("groups connection safeguards without losing their interactions", () => {
    render(<ConnectionDialog open initial={null} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "新建连接" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveStyle({
      width: "620px",
      maxWidth: "calc(100vw - 2rem)",
    });

    const colorGroup = within(dialog).getByRole("group", {
      name: "环境标记",
    });
    const noColor = within(colorGroup).getByRole("button", { name: "无标记" });
    const blue = within(colorGroup).getByRole("button", { name: "blue" });
    expect(noColor).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(blue);
    expect(blue).toHaveAttribute("aria-pressed", "true");
    expect(noColor).toHaveAttribute("aria-pressed", "false");

    const readOnly = within(dialog).getByRole("checkbox", {
      name: /只读模式.*拦截所有写操作/,
    });
    fireEvent.click(readOnly);
    expect(readOnly).toBeChecked();
  });

  it("keeps the SSH fields available in the reorganized security section", () => {
    render(<ConnectionDialog open initial={null} onClose={vi.fn()} />);

    const dialog = screen.getByRole("dialog", { name: "新建连接" });
    const sshToggle = within(dialog).getByRole("checkbox", {
      name: "通过 SSH 隧道连接",
    });
    expect(within(dialog).queryByText("SSH 主机")).not.toBeInTheDocument();

    fireEvent.click(sshToggle);

    expect(sshToggle).toBeChecked();
    expect(within(dialog).getByText("SSH 主机")).toBeInTheDocument();
    expect(within(dialog).getByText("认证方式")).toBeInTheDocument();
  });

  it("provides a localized accessible close action", () => {
    const onClose = vi.fn();
    render(<ConnectionDialog open initial={null} onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: "新建连接" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "关闭: 新建连接" })
    );

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses explicit plaintext for new connections but preserves legacy automatic TLS", () => {
    const { unmount } = render(
      <ConnectionDialog open initial={null} onClose={vi.fn()} />
    );
    expect(screen.getByDisplayValue("禁用（明文）")).toHaveValue("disable");
    unmount();

    render(
      <ConnectionDialog
        open
        initial={{
          id: "legacy",
          name: "Legacy",
          driver: "postgres",
          host: "localhost",
          port: 5432,
          username: "user",
          ssl_mode: null,
        }}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue("自动（兼容旧配置）")).toHaveValue("");
  });

  it("offers CA-only verification for SQL databases but not Redis", () => {
    const { unmount } = render(
      <ConnectionDialog
        open
        initial={{
          id: "pg",
          name: "Postgres",
          driver: "postgres",
          host: "localhost",
          port: 5432,
          username: "user",
          ssl_mode: "verify-ca",
        }}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByDisplayValue("校验 CA 证书")).toHaveValue("verify-ca");
    unmount();

    render(
      <ConnectionDialog
        open
        initial={{
          id: "redis",
          name: "Redis",
          driver: "redis",
          host: "localhost",
          port: 6379,
          ssl_mode: "disable",
        }}
        onClose={vi.fn()}
      />
    );
    expect(screen.queryByRole("option", { name: "校验 CA 证书" })).not.toBeInTheDocument();
  });

  it("uses one consistent field grid for every network database driver", () => {
    render(<ConnectionDialog open initial={null} onClose={vi.fn()} />);

    const driver = screen.getByDisplayValue("PostgreSQL");
    const expectStandardNetworkGrid = () => {
      const network = screen.getByTestId("connection-network-fields");
      expect(network).toHaveClass(
        "sm:grid-cols-[minmax(0,1fr)_120px]"
      );
      expect(within(network).getByText("主机")).toBeInTheDocument();
      expect(within(network).getByText("端口")).toBeInTheDocument();

      const auth = screen.getByTestId("connection-auth-fields");
      expect(auth).toHaveClass("sm:grid-cols-2");
      return auth;
    };

    let auth = expectStandardNetworkGrid();
    expect(within(auth).getByText("数据库")).toBeInTheDocument();
    expect(within(auth).getByText("用户名")).toBeInTheDocument();

    fireEvent.change(driver, { target: { value: "mysql" } });
    auth = expectStandardNetworkGrid();
    expect(within(auth).getByText("数据库")).toBeInTheDocument();
    expect(within(auth).getByText("用户名")).toBeInTheDocument();

    fireEvent.change(driver, { target: { value: "redis" } });
    auth = expectStandardNetworkGrid();
    expect(within(auth).getByText("DB 编号")).toBeInTheDocument();
    expect(within(auth).getByText("用户")).toBeInTheDocument();
    expect(
      within(auth).getByText(/Redis 6\+ ACL 用户名/)
    ).toBeInTheDocument();
    expect(within(auth).queryByText("密码")).not.toBeInTheDocument();

    fireEvent.change(driver, { target: { value: "sqlite" } });
    expect(
      screen.queryByTestId("connection-network-fields")
    ).not.toBeInTheDocument();
    expect(screen.getByText("数据库文件")).toBeInTheDocument();
  });

  it("invalidates an unfinished connection test when the dialog closes", async () => {
    let resolveTest!: (version: string) => void;
    vi.spyOn(api, "testConnection").mockReturnValue(
      new Promise<string>((resolve) => {
        resolveTest = resolve;
      })
    );
    const initial = {
      id: "redis-slow",
      name: "Slow Redis",
      driver: "redis" as const,
      host: "203.0.113.1",
      port: 6379,
      database: "0",
      username: "",
      ssl_mode: "disable",
    };
    const onClose = vi.fn();
    const { rerender } = render(
      <ConnectionDialog open initial={initial} onClose={onClose} />
    );

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText(/测试中/)).toBeInTheDocument();

    rerender(
      <ConnectionDialog open={false} initial={initial} onClose={onClose} />
    );
    rerender(<ConnectionDialog open initial={initial} onClose={onClose} />);

    expect(screen.queryByText(/测试中/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled();

    await act(async () => resolveTest("Redis 7.2.0"));
    await waitFor(() => {
      expect(screen.queryByText("Redis 7.2.0")).not.toBeInTheDocument();
    });
  });
});
