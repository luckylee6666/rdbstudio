import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { ConnectionDialog } from "./ConnectionDialog";

describe("ConnectionDialog", () => {
  beforeEach(() => {
    useI18n.setState({ lang: "zh" });
    useConnections.setState({ list: [] });
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
});
