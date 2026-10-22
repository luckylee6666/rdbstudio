import { useEffect, useState } from "react";
import { AlertTriangle, Eye, Loader2, Save, View } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { api, type QueryResult } from "@/lib/api";
import { useT } from "@/store/i18n";

interface Props {
  open: boolean;
  connectionId: string;
  schema?: string;
  initialView?: string | null;
  onClose: () => void;
  onSaved?: (name: string) => void;
}

export function ViewEditorDialog({
  open,
  connectionId,
  schema,
  initialView,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState("");
  const [selectSql, setSelectSql] = useState("SELECT 1 AS id;");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPreview(null);
    if (initialView) {
      setName(initialView);
      setLoading(true);
      void api
        .getViewDefinition(connectionId, initialView, schema)
        .then((def) => setSelectSql(def))
        .catch((e) => setError(String(e)))
        .finally(() => setLoading(false));
    } else {
      setName("");
      setSelectSql("SELECT * FROM ");
    }
  }, [open, connectionId, schema, initialView]);

  const runPreview = async () => {
    const clean = selectSql.trim().replace(/;+\s*$/, "");
    if (!clean) {
      setError(t("view_editor.err.sql_required"));
      return;
    }
    setPreviewing(true);
    setError(null);
    try {
      const res = await api.executeQuery(
        connectionId,
        `SELECT * FROM (\n${clean}\n) AS _rdb_view_preview LIMIT 20`,
        undefined,
        undefined,
        { recordHistory: false }
      );
      setPreview(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setPreviewing(false);
    }
  };

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t("view_editor.err.name_required"));
      return;
    }
    if (!selectSql.trim()) {
      setError(t("view_editor.err.sql_required"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.saveViewDefinition(
        connectionId,
        trimmedName,
        selectSql,
        schema,
        initialView ?? undefined
      );
      onSaved?.(trimmedName);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={saving}
      title={
        initialView
          ? t("view_editor.title.edit", { name: initialView })
          : t("view_editor.title.new")
      }
      width={720}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-[12px]">
            {error && (
              <span className="flex items-center gap-1.5 text-danger">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[360px] truncate">{error}</span>
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={() => void runPreview()}
            disabled={loading || saving || previewing}
          >
            {previewing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {t("view_editor.btn.preview")}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={loading || saving}
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <div>
            <Label required>{t("view_editor.name")}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="v_active_users"
            />
          </div>
          {schema && (
            <div className="flex h-8 items-center gap-1.5 rounded-md border border-border/70 bg-surface-muted px-2.5 text-[12px] text-muted-foreground">
              <View className="h-3.5 w-3.5 text-emerald-500" />
              <span>{schema}</span>
            </div>
          )}
        </div>

        <div>
          <Label required>{t("view_editor.query")}</Label>
          {loading ? (
            <div className="flex h-40 items-center justify-center gap-2 rounded-lg border border-border/70 bg-surface text-[12px] text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("common.loading")}
            </div>
          ) : (
            <textarea
              value={selectSql}
              onChange={(e) => setSelectSql(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder="SELECT id, name FROM users WHERE active = 1"
              className="w-full rounded-lg border border-border/80 bg-surface p-3 font-mono text-[12.5px] leading-relaxed text-foreground outline-none focus:border-brand"
            />
          )}
          <p className="mt-1 text-[11.5px] text-muted-foreground">
            {t("view_editor.hint")}
          </p>
        </div>

        {preview && (
          <div className="space-y-1.5">
            <div className="text-[11.5px] font-medium text-muted-foreground">
              {t("view_editor.preview_rows", {
                n: preview.rows.length,
                ms: preview.elapsed_ms,
              })}
            </div>
            <div className="max-h-44 overflow-auto rounded-lg border border-border/70">
              <table className="w-full text-left font-mono text-[11.5px]">
                <thead className="bg-surface-muted text-muted-foreground">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c.name} className="px-2.5 py-1 font-medium">
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {preview.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((cell, j) => (
                        <td
                          key={j}
                          className="max-w-[180px] truncate px-2.5 py-1"
                        >
                          {cell === null ? (
                            <span className="italic text-muted-foreground">
                              NULL
                            </span>
                          ) : typeof cell === "object" ? (
                            JSON.stringify(cell)
                          ) : (
                            String(cell)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
