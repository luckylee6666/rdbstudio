import { useEffect, useState } from "react";
import { Bot, Check, Clock3, Copy, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import type { ConnectionConfig, McpAuthorization } from "@/types";
import { api } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { toast } from "@/store/toasts";
import { useI18n, useT } from "@/store/i18n";

interface Props {
  open: boolean;
  config: ConnectionConfig;
  onClose: () => void;
}

export function McpAccessDialog({ open, config, onClose }: Props) {
  const t = useT();
  const lang = useI18n((state) => state.lang);
  const [authorization, setAuthorization] = useState<McpAuthorization | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<"config" | "prompt" | null>(null);

  useEffect(() => {
    if (!open) {
      setAuthorization(null);
      setCopied(null);
    }
  }, [open]);

  const authorize = async () => {
    setLoading(true);
    try {
      setAuthorization(await api.createMcpAuthorization(config.id, 60));
    } catch (error) {
      toast.error(t("mcp.authorize.failed"), String(error));
    } finally {
      setLoading(false);
    }
  };

  const copy = async (kind: "config" | "prompt") => {
    if (!authorization) return;
    const text =
      kind === "config"
        ? authorization.config_json
        : buildAiInstructions(authorization, lang);
    if (!(await copyText(text))) {
      toast.error(t("mcp.copy.failed"));
      return;
    }
    setCopied(kind);
    window.setTimeout(() => setCopied((current) => (current === kind ? null : current)), 1800);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={loading}
      closeLabel={t("common.close")}
      title={t("mcp.dialog.title")}
      width={560}
      footer={
        <>
          <Button onClick={onClose} disabled={loading}>
            {t("common.close")}
          </Button>
          {!authorization && (
            <Button variant="primary" onClick={() => void authorize()} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
              {loading ? t("mcp.authorizing") : t("mcp.authorize")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-brand/20 bg-brand/5 p-3.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
            <Bot className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">{config.name}</div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              {t("mcp.dialog.description")}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <InfoCard icon={ShieldCheck} title={t("mcp.read_only")} body={t("mcp.read_only.hint")} />
          <InfoCard icon={Clock3} title={t("mcp.temporary")} body={t("mcp.temporary.hint")} />
        </div>

        {!authorization ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center">
            <KeyRound className="mx-auto h-5 w-5 text-muted-foreground" />
            <div className="mt-2 text-[13px] font-medium">{t("mcp.ready.title")}</div>
            <p className="mx-auto mt-1 max-w-[420px] text-[11.5px] leading-relaxed text-muted-foreground">
              {t("mcp.ready.hint")}
            </p>
          </div>
        ) : (
          <div className="space-y-3 rounded-lg border border-success/30 bg-success/5 p-3.5">
            <div className="flex items-start gap-2.5">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-success">{t("mcp.authorized")}</div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {t("mcp.expires", {
                    time: new Date(authorization.expires_at).toLocaleString(),
                  })}
                </div>
              </div>
            </div>

            <div className="rounded-md border border-border/70 bg-surface/70 px-3 py-2 font-mono text-[10.5px] text-muted-foreground">
              <div className="truncate">{authorization.server_url}</div>
              <div>{t("mcp.token.hidden")}</div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void copy("prompt")} variant="primary">
                {copied === "prompt" ? <Check className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}
                {copied === "prompt" ? t("common.copied") : t("mcp.copy.prompt")}
              </Button>
              <Button onClick={() => void copy("config")}>
                {copied === "config" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {copied === "config" ? t("common.copied") : t("mcp.copy.config")}
              </Button>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {t("mcp.secret.warning")}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function InfoCard({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof ShieldCheck;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface/40 p-3">
      <div className="flex items-center gap-2 text-[12.5px] font-medium">
        <Icon className="h-3.5 w-3.5 text-brand" />
        {title}
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

export function buildAiInstructions(
  authorization: McpAuthorization,
  lang: "en" | "zh"
): string {
  if (lang === "en") {
    return `Connect to my database through the local rdbstudio MCP server below. If this MCP server is not configured in the current AI client yet, add the configuration first, then use its tools for this conversation. The authorization is read-only, is limited to the connection “${authorization.connection_name}”, and expires at ${authorization.expires_at}. Never ask me for the database host, password, or SSH credentials; rdbstudio keeps those locally.\n\n${authorization.config_json}`;
  }
  return `请通过下面的本地 rdbstudio MCP 服务连接我的数据库。如果当前 AI 客户端还没有配置这个 MCP，请先添加下面的配置，再在本次对话中调用它的工具。该授权仅允许只读访问连接“${authorization.connection_name}”，有效期至 ${authorization.expires_at}。不要向我索取数据库地址、密码或 SSH 凭据，这些信息由 rdbstudio 保存在本机。\n\n${authorization.config_json}`;
}
