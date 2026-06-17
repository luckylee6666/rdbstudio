import { useEffect, useMemo, useState } from "react";
import { Plus, Search, FileCode, Trash2, Edit, Play } from "lucide-react";
import { api } from "@/lib/api";
import { useT } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { Snippet } from "@/types";

export function SnippetsPanel() {
  const t = useT();
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [search, setSearch] = useState("");
  const [editSnippet, setEditSnippet] = useState<Snippet | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [sql, setSql] = useState("");
  const [desc, setDesc] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.listSnippets();
      setSnippets(res);
    } catch (e) {
      console.error("load snippets", e);
    }
  };

  useEffect(() => {
    void load();
    const handleUpdate = () => {
      void load();
    };
    window.addEventListener("snippets-updated", handleUpdate);
    return () => window.removeEventListener("snippets-updated", handleUpdate);
  }, []);

  const filtered = useMemo(() => {
    const query = search.toLowerCase().trim();
    if (!query) return snippets;
    return snippets.filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        s.sql.toLowerCase().includes(query) ||
        s.description?.toLowerCase().includes(query)
    );
  }, [snippets, search]);

  const openNewModal = () => {
    setEditSnippet(null);
    setName("");
    setSql("");
    setDesc("");
    setError(null);
    setModalOpen(true);
  };

  const openEditModal = (s: Snippet) => {
    setEditSnippet(s);
    setName(s.name);
    setSql(s.sql);
    setDesc(s.description ?? "");
    setError(null);
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t("sidebar.snippets.name") + " is required");
      return;
    }
    if (!sql.trim()) {
      setError(t("sidebar.snippets.sql") + " is required");
      return;
    }
    try {
      const id = editSnippet ? editSnippet.id : "";
      await api.saveSnippet({
        id,
        name: name.trim(),
        sql: sql.trim(),
        description: desc.trim() || undefined,
      });
      setModalOpen(false);
      void load();
      window.dispatchEvent(new Event("snippets-updated"));
    } catch (e) {
      setError(String(e));
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await api.deleteSnippet(deleteId);
      setDeleteId(null);
      void load();
      window.dispatchEvent(new Event("snippets-updated"));
    } catch (e) {
      console.error("delete snippet", e);
    }
  };

  const handleInsert = (code: string) => {
    const activeTab = useWorkspace.getState().tabs.find(
      (t) => t.id === useWorkspace.getState().activeTabId
    );
    if (activeTab && activeTab.kind === "query") {
      window.dispatchEvent(new CustomEvent("insert-sql", { detail: code }));
    } else {
      useWorkspace.getState().openTab({
        id: `query:${crypto.randomUUID()}`,
        kind: "query",
        title: "Query",
        subtitle: "Untitled",
      });
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("insert-sql", { detail: code }));
      }, 150);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("sidebar.snippets")}
        </div>
        <button
          onClick={openNewModal}
          title={t("sidebar.snippets.new")}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="px-2 pb-2">
        <div className="relative flex items-center">
          <Search className="absolute left-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder={t("titlebar.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-full rounded-md border border-border/70 bg-surface/30 pl-8 pr-3 text-[12px] text-foreground placeholder-muted-foreground focus:border-brand/60 focus:bg-surface focus:outline-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {filtered.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-border/80 bg-surface-muted/30 p-5 text-center">
            <div className="mb-2 inline-grid h-9 w-9 place-items-center rounded-md bg-accent text-foreground">
              <FileCode className="h-4 w-4" />
            </div>
            <div className="text-[13px] font-medium">
              {t("sidebar.snippets.empty.title")}
            </div>
            <div className="mt-0.5 text-[11.5px] text-muted-foreground leading-normal">
              {t("sidebar.snippets.empty.desc")}
            </div>
          </div>
        ) : (
          filtered.map((s) => (
            <div
              key={s.id}
              className="group mb-1.5 flex flex-col rounded-md border border-border/40 bg-surface-elevated/40 p-2 hover:border-border hover:bg-surface-elevated"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="truncate text-[13px] font-medium text-foreground">
                  {s.name}
                </span>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleInsert(s.sql)}
                    title="Insert to Editor"
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Play className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => openEditModal(s)}
                    title="Edit"
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <Edit className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => setDeleteId(s.id)}
                    title="Delete"
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-danger"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              {s.description && (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {s.description}
                </p>
              )}
              <pre
                onClick={() => handleInsert(s.sql)}
                className="mt-1.5 max-h-12 cursor-pointer overflow-hidden rounded bg-surface/30 p-1 font-mono text-[11px] text-muted-foreground hover:bg-surface/60"
              >
                {s.sql}
              </pre>
            </div>
          ))
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editSnippet ? t("sidebar.snippets.edit") : t("sidebar.snippets.new")}
        width={480}
        footer={
          <>
            <Button onClick={() => setModalOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={handleSave}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          {error && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              {t("sidebar.snippets.name")} *
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 rounded-md border border-border/70 bg-surface px-3 text-[12.5px] text-foreground focus:border-brand/60 focus:outline-none"
              placeholder="e.g. Find users by email"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              {t("sidebar.snippets.desc")}
            </label>
            <input
              type="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="h-8 rounded-md border border-border/70 bg-surface px-3 text-[12.5px] text-foreground focus:border-brand/60 focus:outline-none"
              placeholder="Optional description"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              {t("sidebar.snippets.sql")} *
            </label>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              rows={6}
              spellCheck={false}
              className="w-full rounded-md border border-border/70 bg-surface p-3 font-mono text-[12px] text-foreground focus:border-brand/60 focus:outline-none resize-y"
              placeholder="SELECT * FROM users WHERE email = 'test@example.com';"
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteId !== null}
        title={t("conn.delete")}
        message="Are you sure you want to delete this snippet?"
        confirmLabel={t("conn.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={handleDelete}
        onClose={() => setDeleteId(null)}
      />
    </div>
  );
}
