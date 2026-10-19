import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, Gauge, Network, Pause, Play, Radio, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { ToolCard } from "@/components/tools/ToolKit";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { redisTools, type RedisClusterSnapshot, type RedisPubSubMessage } from "@/lib/redisTools";
import { useT } from "@/store/i18n";
import { useRedisToolsT } from "./redisToolsI18n";

/** Parse `INFO` output ("# Section" headers, "key:value" lines). */
export function parseRedisInfo(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function RedisToolsView({ connectionId, onBack }: { connectionId: string; onBack?: () => void }) {
  const tr = useRedisToolsT();
  return (
    <div className={cn("mx-auto grid max-w-6xl gap-4 xl:grid-cols-2", onBack && "p-4")}>
      {onBack && (
        <div className="xl:col-span-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeft className="h-3.5 w-3.5" />
            {tr("back")}
          </Button>
        </div>
      )}
      <ServerOverview connectionId={connectionId} />
      <PubSubCard connectionId={connectionId} />
      <ClusterCard connectionId={connectionId} />
    </div>
  );
}

function ServerOverview({ connectionId }: { connectionId: string }) {
  const t = useT();
  const [info, setInfo] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.executeQuery(connectionId, "INFO", undefined, undefined, { recordHistory: false });
      const text = String(result.rows[0]?.[0] ?? "");
      setInfo(parseRedisInfo(text));
      setError(null);
    } catch (e) {
      setError(String(e));
      setLive(false);
    } finally {
      setLoading(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [live, load]);

  const hits = Number(info?.keyspace_hits ?? 0);
  const misses = Number(info?.keyspace_misses ?? 0);
  const hitRate = hits + misses > 0 ? `${((hits / (hits + misses)) * 100).toFixed(1)}%` : "—";
  const keyspace = info
    ? Object.entries(info).filter(([k]) => /^db\d+$/.test(k))
    : [];

  return (
    <ToolCard
      className="xl:col-span-2"
      title={
        <span className="flex items-center gap-2">
          <Gauge className="h-3.5 w-3.5" />
          {t("redis.tools.server")}
        </span>
      }
      aside={
        <div className="flex items-center gap-1.5">
          {live && (
            <span className="flex items-center gap-1.5 text-[11px] text-success">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
              {t("redis.tools.live")}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => setLive((v) => !v)}>
            {live ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {live ? t("redis.tools.pause") : t("redis.tools.auto_refresh")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          </Button>
        </div>
      }
    >
      {error ? (
        <p role="alert" className="text-[12px] text-danger">{error}</p>
      ) : !info ? (
        <p className="text-[12px] text-muted-foreground">{t("common.loading")}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Metric label={t("redis.tools.version")} value={info.redis_version ?? "—"} sub={info.redis_mode} />
            <Metric label={t("redis.tools.uptime")} value={formatUptime(Number(info.uptime_in_seconds ?? 0))} />
            <Metric label={t("redis.tools.clients")} value={info.connected_clients ?? "—"} sub={info.blocked_clients ? `${t("redis.tools.blocked")} ${info.blocked_clients}` : undefined} />
            <Metric label={t("redis.tools.memory")} value={info.used_memory_human ?? "—"} sub={info.used_memory_peak_human ? `${t("redis.tools.peak")} ${info.used_memory_peak_human}` : undefined} />
            <Metric label={t("redis.tools.ops")} value={info.instantaneous_ops_per_sec ?? "—"} accent />
            <Metric label={t("redis.tools.commands")} value={Number(info.total_commands_processed ?? 0).toLocaleString()} />
            <Metric label={t("redis.tools.hit_rate")} value={hitRate} sub={`${hits.toLocaleString()} / ${misses.toLocaleString()}`} />
            <Metric label={t("redis.tools.evicted")} value={info.evicted_keys ?? "0"} sub={info.maxmemory_policy} />
          </div>
          {keyspace.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-lg border border-border/60">
              {keyspace.map(([db, stats]) => (
                <div key={db} className="flex items-center gap-3 border-b border-border/40 px-3 py-1.5 font-mono text-[11.5px] last:border-b-0">
                  <span className="w-12 text-brand">{db}</span>
                  <span className="text-muted-foreground">{stats.replace(/,/g, " · ")}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </ToolCard>
  );
}

function Metric({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <div className="truncate text-[10.5px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-0.5 truncate font-mono text-[15px] font-semibold tabular-nums", accent && "text-brand")}>{value}</div>
      {sub && <div className="truncate text-[10.5px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function PubSubCard({ connectionId }: { connectionId: string }) {
  const t = useRedisToolsT();
  const [channel, setChannel] = useState("");
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<RedisPubSubMessage[]>([]);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef<string | null>(null);

  const stop = useCallback(async (subId: string) => {
    activeRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setSubscriptionId(null);
    try {
      await redisTools.pubsubStop(connectionId, subId);
    } catch {
      /* server may already have ended it */
    }
  }, [connectionId]);

  useEffect(() => () => {
    if (activeRef.current) void redisTools.pubsubStop(connectionId, activeRef.current).catch(() => {});
    if (timerRef.current) clearTimeout(timerRef.current);
  }, [connectionId]);

  const poll = useCallback(async (subId: string) => {
    if (activeRef.current !== subId) return;
    try {
      const batch = await redisTools.pubsubPoll(connectionId, subId, 50);
      if (activeRef.current !== subId) return;
      if (batch.messages.length) setMessages((current) => [...current, ...batch.messages].slice(-2000));
      if (batch.dropped) setDropped((current) => current + batch.dropped);
      if (batch.stopped) {
        await redisTools.pubsubStop(connectionId, subId).catch(() => {});
        activeRef.current = null;
        setSubscriptionId(null);
        return;
      }
      timerRef.current = setTimeout(() => void poll(subId), 500);
    } catch (cause) {
      if (activeRef.current === subId) {
        activeRef.current = null;
        setSubscriptionId(null);
        setError(`${t("pollFailed")}: ${String(cause)}`);
      }
    }
  }, [connectionId, t]);

  const subscribe = async () => {
    if (!channel.trim()) return;
    setError(null);
    setMessages([]);
    setDropped(0);
    try {
      const subId = await redisTools.pubsubStart(connectionId, channel.trim());
      activeRef.current = subId;
      setSubscriptionId(subId);
      void poll(subId);
    } catch (cause) {
      setError(`${t("startFailed")}: ${String(cause)}`);
    }
  };

  return (
    <ToolCard
      className="flex min-h-[320px] flex-col"
      title={
        <span className="flex items-center gap-2">
          <Radio className="h-3.5 w-3.5" />
          {t("pubsub")}
        </span>
      }
      aside={
        subscriptionId ? (
          <span className="flex items-center gap-1.5 text-[11px] text-success">
            <Activity className="h-3 w-3" />
            {t("listening")} · {channel}
          </span>
        ) : undefined
      }
    >
      <div className="flex gap-2">
        <Input
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !subscriptionId && !e.nativeEvent.isComposing) void subscribe();
          }}
          placeholder={t("channel")}
          disabled={!!subscriptionId}
          className="font-mono"
        />
        {subscriptionId ? (
          <Button variant="danger" onClick={() => void stop(subscriptionId)}>
            <Square className="h-3 w-3 fill-current" />
            {t("stop")}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void subscribe()} disabled={!channel.trim()}>
            {t("subscribe")}
          </Button>
        )}
      </div>
      {dropped > 0 && <div className="mt-2 text-[11px] text-warning">{t("dropped", { n: dropped })}</div>}
      {error && <div role="alert" className="mt-2 break-all text-[11px] text-danger">{error}</div>}
      <div className="mt-3 min-h-[180px] flex-1 overflow-auto rounded-lg border border-border/60 bg-background/50">
        {messages.length === 0 ? (
          <div className="p-3 text-[12px] text-muted-foreground">{t("noMessages")}</div>
        ) : (
          messages.map((message, index) => (
            <div
              key={`${message.received_at_ms}:${index}`}
              className="grid grid-cols-[auto_auto_1fr] gap-x-3 border-b border-border/40 px-2.5 py-1.5 font-mono text-[11px]"
            >
              <span className="text-muted-foreground">{new Date(message.received_at_ms).toLocaleTimeString()}</span>
              <span className="text-brand">{message.channel}</span>
              <span className="break-all">
                {message.payload}
                {message.binary ? ` · ${t("binary")}` : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </ToolCard>
  );
}

function ClusterCard({ connectionId }: { connectionId: string }) {
  const t = useRedisToolsT();
  const [cluster, setCluster] = useState<RedisClusterSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setCluster(await redisTools.clusterSnapshot(connectionId));
    } catch (cause) {
      setError(`${t("clusterFailed")}: ${String(cause)}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <ToolCard
      title={
        <span className="flex items-center gap-2">
          <Network className="h-3.5 w-3.5" />
          {t("cluster")}
        </span>
      }
      aside={
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          {t("loadCluster")}
        </Button>
      }
    >
      {error && <p role="alert" className="break-all text-[12px] text-muted-foreground">{error}</p>}
      {!cluster && !error && <p className="text-[12px] text-muted-foreground">{t("clusterHint")}</p>}
      {cluster && (
        <div className="grid gap-3">
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">{t("clusterInfo")}</div>
            <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-background/50 p-2 text-[10.5px]">{cluster.info}</pre>
          </div>
          <div>
            <div className="mb-1 text-[11px] text-muted-foreground">{t("nodes")}</div>
            <pre className="max-h-48 overflow-auto rounded-lg border border-border/60 bg-background/50 p-2 text-[10.5px]">{cluster.nodes.join("\n")}</pre>
          </div>
        </div>
      )}
    </ToolCard>
  );
}
