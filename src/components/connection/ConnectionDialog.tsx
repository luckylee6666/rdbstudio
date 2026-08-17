import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { PromptDialog } from "@/components/ui/PromptDialog";
import { DriverBadge } from "./driverIcon";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { CONN_COLORS } from "@/lib/connColors";
import { useConnections } from "@/store/connections";
import type { ConnectionConfig, DriverKind, SshConfig } from "@/types";
import { Ban, CheckCircle2, FolderOpen, Loader2, XCircle } from "lucide-react";
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
      if (!cfg.name) update("name", picked.split(/[/\\]/).pop() ?? "SQLite");
    }
  };

  // Toggle the SSH tunnel on/off. Enabling seeds sensible defaults.
  const toggleSsh = (on: boolean) =>
    setCfg((c) => ({
      ...c,
      ssh: on
        ? c.ssh ?? {
            host: "",
            port: 22,
            username: "",
            auth: "password",
            key_path: "",
            password: "",
          }
        : null,
    }));

  const updateSsh = (patch: Partial<SshConfig>) =>
    setCfg((c) => ({
      ...c,
      ssh: {
        host: "",
        port: 22,
        username: "",
        auth: "password",
        ...(c.ssh ?? {}),
        ...patch,
      },
    }));

  const pickKey = async () => {
    const picked = await openDialog({
      filters: [{ name: "All", extensions: ["*"] }],
    });
    if (typeof picked === "string") updateSsh({ key_path: picked });
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
        <div className="flex w-full flex-col gap-2">
          {(testing || result) && (
            <div className="flex min-w-0 items-start gap-2 text-[12px]">
              {testing && (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
                  {t("common.testing")}
                </span>
              )}
              {result && (() => {
                const Icon = result.ok ? CheckCircle2 : XCircle;
                const tone = result.ok ? "text-success" : "text-danger";
                return (
                  <span className={`flex min-w-0 items-start gap-1.5 ${tone}`}>
                    <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-words" title={result.msg}>
                      {result.msg}
                    </span>
                  </span>
                );
              })()}
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button onClick={onTest} disabled={testing || saving}>
              {t("conn.dialog.test")}
            </Button>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={onSave} disabled={saving}>
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
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
                <Label hint={initial ? t("conn.dialog.password.hint.edit") : t("conn.dialog.password.hint")}>
                  {t("conn.dialog.password")}
                </Label>
                <Input
                  type="password"
                  value={cfg.password ?? ""}
                  onChange={(e) => update("password", e.target.value)}
                  placeholder={initial ? t("conn.dialog.password.placeholder.keep") : "••••••••"}
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
              <Label hint={initial ? t("conn.dialog.password.hint.edit") : t("conn.dialog.password.hint")}>
                {t("conn.dialog.password")}
              </Label>
              <Input
                type="password"
                value={cfg.password ?? ""}
                onChange={(e) => update("password", e.target.value)}
                placeholder={initial ? t("conn.dialog.password.placeholder.keep") : "••••••••"}
              />
            </div>
          </>
        )}

        {!isSqlite && (
          <div className="space-y-3 rounded-lg border border-border/70 bg-surface-muted/20 p-3">
            <div className="grid grid-cols-[120px_1fr] items-center gap-3">
              <Label>{t("conn.dialog.ssl")}</Label>
              <Select
                value={cfg.ssl_mode ?? "disable"}
                onChange={(e) => update("ssl_mode", e.target.value)}
              >
                <option value="disable">{t("conn.ssl.disable")}</option>
                <option value="require">{t("conn.ssl.require")}</option>
                <option value="verify-full">{t("conn.ssl.verify")}</option>
              </Select>
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand"
                checked={!!cfg.ssh}
                onChange={(e) => toggleSsh(e.target.checked)}
              />
              {t("conn.ssh.enable")}
            </label>

            {cfg.ssh && (
              <div className="space-y-3 border-t border-border/60 pt-3">
                <div className="grid grid-cols-[1fr_100px] gap-3">
                  <div>
                    <Label required>{t("conn.ssh.host")}</Label>
                    <Input
                      value={cfg.ssh.host}
                      onChange={(e) => updateSsh({ host: e.target.value })}
                      placeholder="bastion.example.com"
                    />
                  </div>
                  <div>
                    <Label required>{t("conn.ssh.port")}</Label>
                    <Input
                      type="number"
                      value={cfg.ssh.port ?? 22}
                      onChange={(e) =>
                        updateSsh({ port: e.target.value ? Number(e.target.value) : 22 })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label required>{t("conn.ssh.user")}</Label>
                    <Input
                      value={cfg.ssh.username}
                      onChange={(e) => updateSsh({ username: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label>{t("conn.ssh.auth")}</Label>
                    <Select
                      value={cfg.ssh.auth ?? "password"}
                      onChange={(e) => updateSsh({ auth: e.target.value })}
                    >
                      <option value="password">{t("conn.ssh.auth.password")}</option>
                      <option value="key">{t("conn.ssh.auth.key")}</option>
                    </Select>
                  </div>
                </div>
                {(cfg.ssh.auth ?? "password") === "key" ? (
                  <>
                    <div>
                      <Label>{t("conn.ssh.key")}</Label>
                      <div className="flex gap-2">
                        <Input
                          value={cfg.ssh.key_path ?? ""}
                          onChange={(e) => updateSsh({ key_path: e.target.value })}
                          placeholder="~/.ssh/id_ed25519"
                        />
                        <Button onClick={pickKey}>
                          <FolderOpen className="h-3.5 w-3.5" />
                          {t("common.browse")}
                        </Button>
                      </div>
                    </div>
                    <div>
                      <Label hint={initial ? t("conn.dialog.password.hint.edit") : undefined}>
                        {t("conn.ssh.passphrase")}
                      </Label>
                      <Input
                        type="password"
                        value={cfg.ssh.password ?? ""}
                        onChange={(e) => updateSsh({ password: e.target.value })}
                        placeholder={
                          initial
                            ? t("conn.dialog.password.placeholder.keep")
                            : t("conn.ssh.passphrase.opt")
                        }
                      />
                    </div>
                  </>
                ) : (
                  <div>
                    <Label hint={initial ? t("conn.dialog.password.hint.edit") : undefined}>
                      {t("conn.ssh.password")}
                    </Label>
                    <Input
                      type="password"
                      value={cfg.ssh.password ?? ""}
                      onChange={(e) => updateSsh({ password: e.target.value })}
                      placeholder={
                        initial ? t("conn.dialog.password.placeholder.keep") : "••••••••"
                      }
                    />
                  </div>
                )}
              </div>
            )}
          </div>
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

        <div className="grid grid-cols-2 items-start gap-3">
          <div>
            <Label>{t("conn.dialog.color")}</Label>
            <div className="flex items-center gap-1.5 pt-1">
              <button
                type="button"
                onClick={() => update("color", null)}
                title={t("conn.dialog.color.none")}
                className={cn(
                  "grid h-5 w-5 place-items-center rounded-full border border-border/80 text-muted-foreground hover:border-foreground/40",
                  !cfg.color && "ring-2 ring-brand/70 ring-offset-2 ring-offset-surface"
                )}
              >
                <Ban className="h-3 w-3" />
              </button>
              {Object.entries(CONN_COLORS).map(([token, hex]) => (
                <button
                  key={token}
                  type="button"
                  onClick={() => update("color", token)}
                  title={token}
                  className={cn(
                    "h-5 w-5 rounded-full border border-black/20 transition-transform hover:scale-110",
                    cfg.color === token &&
                      "ring-2 ring-brand/70 ring-offset-2 ring-offset-surface"
                  )}
                  style={{ background: hex }}
                />
              ))}
            </div>
          </div>
          <div>
            <Label hint={t("conn.dialog.read_only.hint")}>
              {t("conn.dialog.read_only")}
            </Label>
            <label className="flex h-8 cursor-pointer items-center gap-2 text-[12.5px]">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-brand"
                checked={!!cfg.read_only}
                onChange={(e) => update("read_only", e.target.checked)}
              />
              {t("conn.dialog.read_only.label")}
            </label>
          </div>
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
