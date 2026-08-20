import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryEditorView } from "./QueryEditorView";
import { useWorkspace } from "@/store/workspace";
import type { WorkspaceTab } from "@/types";

vi.mock("@/components/editor/CodeMirror", () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="SQL editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

describe("QueryEditorView buffer persistence", () => {
  const tab: WorkspaceTab = {
    id: "query:buffer-test",
    kind: "query",
    title: "Query",
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  });

  it("flushes the latest SQL when switching tabs inside the debounce window", () => {
    const { unmount } = render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: "SELECT 'kept';" },
    });

    unmount();

    expect(localStorage.getItem(`rdb:buf:${tab.id}`)).toBe("SELECT 'kept';");
  });

  it("does not recreate storage for a deliberately closed tab", () => {
    const { unmount } = render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: "SELECT 'closed';" },
    });
    act(() => useWorkspace.setState({ tabs: [], activeTabId: null }));

    unmount();

    expect(localStorage.getItem(`rdb:buf:${tab.id}`)).toBeNull();
  });
});
