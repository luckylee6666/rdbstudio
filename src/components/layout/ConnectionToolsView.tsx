import { useEffect, useState } from "react";
import { Radio, Unplug, Users } from "lucide-react";
import {
  ConnectionPicker,
  SchemaPicker,
  ToolEmpty,
  ToolPage,
  useDefaultConnection,
} from "@/components/tools/ToolKit";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import type { ConnectionConfig } from "@/types";
import { ObjectManagerView } from "./ObjectManagerView";
import { RedisToolsView } from "./RedisToolsView";

const acceptSql = (c: ConnectionConfig) => c.driver !== "redis";
const acceptRedis = (c: ConnectionConfig) => c.driver === "redis";

export function ConnectionToolsView({ kind, initialConnectionId, initialSchema, objectKind, objectName }: {
  kind: "objects" | "redis-tools";
  initialConnectionId?: string;
  initialSchema?: string;
  objectKind?: "event" | "sequence";
  objectName?: string;
}) {
  const t = useT();
  const accept = kind === "redis-tools" ? acceptRedis : acceptSql;
  const defaultId = useDefaultConnection(accept);
  const [selected, setSelected] = useState(initialConnectionId ?? "");
  const [schema, setSchema] = useState(initialSchema ?? "");
  useEffect(() => {
    if (!selected && defaultId) setSelected(defaultId);
  }, [selected, defaultId]);

  const connection = useConnections((s) => s.list.find((c) => c.id === selected));
  const connected = useConnections((s) => s.status[selected] === "connected");
  const isObjects = kind === "objects";

  return (
    <ToolPage
      icon={isObjects ? Users : Radio}
      title={t(isObjects ? "tool.objects.title" : "tool.redis.title")}
      description={t(isObjects ? "tool.objects.desc" : "tool.redis.desc")}
      bodyClassName={isObjects ? "flex flex-col p-0 overflow-hidden" : undefined}
    >
      <div
        className={
          isObjects
            ? "grid shrink-0 gap-3 border-b border-border/70 px-5 py-3 md:grid-cols-[minmax(240px,360px)_minmax(200px,280px)]"
            : "mx-auto mb-4 max-w-6xl md:max-w-[380px] xl:mx-auto xl:max-w-6xl"
        }
      >
        <ConnectionPicker
          label={t("query.toolbar.target")}
          value={selected}
          accept={accept}
          onChange={(id) => {
            setSelected(id);
            setSchema("");
          }}
        />
        {isObjects && (
          <SchemaPicker
            label={connection?.driver === "postgres" ? "Schema" : t("objects.database")}
            connectionId={selected}
            value={schema}
            onChange={setSchema}
          />
        )}
      </div>
      {!connection || !connected ? (
        <ToolEmpty
          icon={Unplug}
          title={connection ? t("tool.connect_first") : t("tool.no_connections")}
          hint={connection ? t("tool.connect_first_hint") : undefined}
        />
      ) : isObjects ? (
        <div className="min-h-0 flex-1">
          <ObjectManagerView
            key={`${connection.id}:${schema}`}
            connectionId={connection.id}
            driver={connection.driver}
            readOnly={connection.read_only}
            schema={schema || (connection.driver === "postgres" ? "public" : connection.database)}
            initialKind={objectKind}
            initialName={selected === initialConnectionId && schema === (initialSchema ?? "") ? objectName : undefined}
          />
        </div>
      ) : (
        <RedisToolsView key={connection.id} connectionId={connection.id} />
      )}
    </ToolPage>
  );
}
