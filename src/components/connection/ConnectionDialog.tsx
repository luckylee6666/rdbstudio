import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { PromptDialog } from "@/components/ui/PromptDialog";
import { DriverBadge } from "./driverIcon";
import { api } from "@/lib/api";
import { useConnections } from "@/store/connections";
import type { ConnectionConfig, DriverKind } from "@/types";
import { CheckCircle2, FolderOpen, Loader2, XCircle } from "lucide-react";
import { useT } from "@/store/i18n";

// Sentinel value used by the group <Select> to mean "open the create-group
// prompt". Picked to never collide with a real user-typed group name.
const NEW_GROUP_SENTINEL = "__rdb_new_group__";

const DRIVERS: { value: DriverKind; label: string }[] = [
  { value: "sqlite", label: "SQLite" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "mysql", label: "MySQL" },
  { value: "redis", label: "Redis" },
];

const EMPTY: ConnectionConfig = {
  id: "",
  name: "",
  driver: "postgres",
  host: "localhost",
  port: 5432,
  database: "",
  username: "",
  password: "",
  file_path: "",
};

export function ConnectionDialog({
  open,
  initial,
  onClose,
}: {
  open: boolean;
  initial?: ConnectionConfig | null;
  onClose: () => void;
}) {
  const [cfg, setCfg] = useState<ConnectionConfig>(EMPTY);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(
    null
  );
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  const save = useConnections((s) => s.save);
  const allConnections = useConnections((s) => s.list);
  const t = useT();

  // Build the set of group options. Include the current connection's group
  // even if it's the only one using that name, so editing doesn't silently
  // drop the value when the list is otherwise empty.
  const groupOptions = (() => {
    const seen = new Set<string>();
    for (const c of allConnections) {
      const g = (c.group ?? "").trim();
      if (g) seen.add(g);
    }
    const cur = (cfg.group ?? "").trim();
    if (cur) seen.add(cur);
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  })();

  useEffect(() => {
    if (!open) return;
    setResult(null);
    if (initial) {
      setCfg({ ...EMPTY, ...initial, password: "" });
    } else {
      setCfg(EMPTY);
    }
  }, [open, initial]);

  const update = <K extends keyof ConnectionConfig>(
    k: K,
    v: ConnectionConfig[K]
  ) => setCfg((c) => ({ ...c, [k]: v }));

  const onDriverChange = (d: DriverKind) => {
    setCfg((c) => ({
      ...c,
      driver: d,
      port:
        d === "sqlite"
          ? null
          : d === "postgres"
          ? 5432
          : d === "mysql"
          ? 3306
          : d === "redis"
          ? 6379
          : c.port,
      // For Redis, the `database` field is the numeric DB index (default 0).
      database:
        d === "redis"
          ? c.database && /^\d+$/.test(c.database)
            ? c.database
            : "0"
          : c.database,
    }));
  };

  const pickFile = async () => {
    const picked = await openDialog({
      filters: [
        { name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (typeof picked === "string") {
      update("file_path", picked);
      if (!cfg.name) update("name", picked.split("/").pop() ?? "SQLite");
    }
  };

  const onTest = async () => {
    setTesting(true);
    setResult(null);
    try {
      const v = await api.testConnection(cfg);
      setResult({ ok: true, msg: v });
    } catch (e) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await save(cfg);
      onClose();
    } catch (e) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const isSqlite = cfg.driver === "sqlite";
  const isRedis = cfg.driver === "redis";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? t("conn.dialog.edit") : t("conn.dialog.new")}
      width={560}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-[12px]">
            {testing && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("common.testing")}
              </span>
            )}
            {result &&
              (result.ok ? (
                <span className="flex items-center gap-1.5 text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span className="max-w-[320px] truncate">{result.msg}</span>
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-danger">
                  <XCircle className="h-3.5 w-3.5" />
                  <span className="max-w-[320px] truncate">{result.msg}</span>
                </span>
              ))}
          </div>
          <Button onClick={onTest} disabled={testing || saving}>
            {t("conn.dialog.test")}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <DriverBadge driver={cfg.driver} size="md" />
          <div className="flex-1">
            <Label>{t("conn.dialog.name")}</Label>
            <Input
              value={cfg.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder={t("conn.dialog.name.placeholder")}
            />
          </div>
          <div className="w-[140px]">
            <Label>{t("conn.dialog.driver")}</Label>
            <Select
              value={cfg.driver}
              onChange={(e) => onDriverChange(e.target.value as DriverKind)}
            >
              {DRIVERS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {isSqlite ? (
          <div>
            <Label required>{t("conn.dialog.file")}</Label>
            <div className="flex gap-2">
              <Input
                value={cfg.file_path ?? ""}
                onChange={(e) => update("file_path", e.target.value)}
                placeholder={t("conn.dialog.file.placeholder")}
              />
              <Button onClick={pickFile}>
                <FolderOpen className="h-3.5 w-3.5" />
                {t("common.browse")}
              </Button>
            </div>
          </div>
        ) : isRedis ? (
          <>
            <div className="grid grid-cols-[1fr_120px_120px] gap-3">
              <div>
                <Label required>{t("conn.dialog.host")}</Label>
                <Input
                  value={cfg.host ?? ""}
                  onChange={(e) => update("host", e.target.value)}
                />
              </div>
              <div>
                <Label required>{t("conn.dialog.port")}</Label>
                <Input
                  type="number"
                  value={cfg.port ?? ""}
                  onChange={(e) =>
                    update("port", e.target.value ? Number(e.target.value) : null)
                  }
                />
              </div>
              <div>
                <Label>{t("conn.dialog.redis.db_index")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={15}
                  value={cfg.database ?? "0"}
                  onChange={(e) => update("database", e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label hint={t("conn.dialog.redis.acl_user_hint")}>
                  {t("conn.dialog.redis.acl_user")}
                </Label>
                <Input
                  value={cfg.username ?? ""}
                  onChange={(e) => update("username", e.target.value)}
                  placeholder="default"
                />
              </div>
              <div>
                <Label hint={t("conn.dialog.password.hint")}>
                  {t("conn.dialog.password")}
                </Label>
                <Input
                  type="password"
                  value={cfg.password ?? ""}
                  onChange={(e) => update("password", e.target.value)}
                  placeholder="••••••••"
                />
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-[1fr_120px] gap-3">
              <div>
                <Label required>{t("conn.dialog.host")}</Label>
                <Input
                  value={cfg.host ?? ""}
                  onChange={(e) => update("host", e.target.value)}
                />
              </div>
              <div>
                <Label required>{t("conn.dialog.port")}</Label>
                <Input
                  type="number"
                  value={cfg.port ?? ""}
                  onChange={(e) =>
                    update("port", e.target.value ? Number(e.target.value) : null)
                  }
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("conn.dialog.database")}</Label>
                <Input
                  value={cfg.database ?? ""}
                  onChange={(e) => update("database", e.target.value)}
                  placeholder={cfg.driver === "postgres" ? "postgres" : ""}
                />
              </div>
              <div>
                <Label required>{t("conn.dialog.username")}</Label>
                <Input
                  value={cfg.username ?? ""}
                  onChange={(e) => update("username", e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label hint={t("conn.dialog.password.hint")}>
                {t("conn.dialog.password")}
              </Label>
              <Input
                type="password"
                value={cfg.password ?? ""}
                onChange={(e) => update("password", e.target.value)}
                placeholder="••••••••"
              />
            </div>
          </>
        )}

        <div>
          <Label>{t("conn.dialog.group")}</Label>
          <Select
            value={cfg.group ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              if (v === NEW_GROUP_SENTINEL) {
                setNewGroupOpen(true);
                return;
              }
              update("group", v || null);
            }}
          >
            <option value="">{t("conn.ungrouped")}</option>
            {groupOptions.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
            <option value={NEW_GROUP_SENTINEL}>
              + {t("conn.new_group")}
            </option>
          </Select>
        </div>
      </div>

      <PromptDialog
        open={newGroupOpen}
        title={t("conn.new_group")}
        label={t("conn.new_group.prompt")}
        placeholder="Prod / Staging / …"
        submitLabel={t("common.save")}
        cancelLabel={t("common.cancel")}
        onSubmit={(name) => {
          const trimmed = name.trim();
          if (trimmed) update("group", trimmed);
        }}
        onClose={() => setNewGroupOpen(false)}
      />
    </Modal>
  );
}
