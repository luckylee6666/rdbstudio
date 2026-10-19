import { invoke } from "@tauri-apps/api/core";

export interface RedisPage<T> {
  items: T[];
  cursor: string;
  done: boolean;
  truncated: boolean;
}
export interface RedisHashEntry {
  field: string;
  value: string;
  field_binary: boolean;
  value_binary: boolean;
}
export interface RedisStreamEntry {
  id: string;
  fields: Record<string, string>;
  binary_fields: string[];
  truncated: boolean;
}
export interface RedisStreamGroup {
  name: string;
  consumers: number;
  pending: number;
  last_delivered_id: string;
}
export interface RedisClusterSnapshot {
  info: string;
  nodes: string[];
}
export interface RedisPubSubMessage {
  channel: string;
  payload: string;
  binary: boolean;
  received_at_ms: number;
}
export interface RedisPubSubBatch {
  messages: RedisPubSubMessage[];
  dropped: number;
  stopped: boolean;
}

export const redisTools = {
  hscan: (id: string, key: string, cursor = "0") =>
    invoke<RedisPage<RedisHashEntry>>("redis_hscan", { id, key, cursor }),
  sscan: (id: string, key: string, cursor = "0") =>
    invoke<RedisPage<string>>("redis_sscan", { id, key, cursor }),
  xrange: (id: string, key: string, start = "-", count = 100, reverse = false) =>
    invoke<RedisPage<RedisStreamEntry>>("redis_xrange", { id, key, start, count, reverse }),
  xadd: (id: string, key: string, fields: Array<[string, string]>) =>
    invoke<string>("redis_xadd", { id, key, fields }),
  xdel: (id: string, key: string, ids: string[]) =>
    invoke<number>("redis_xdel", { id, key, ids }),
  xinfoGroups: (id: string, key: string) =>
    invoke<RedisStreamGroup[]>("redis_xinfo_groups", { id, key }),
  xgroupCreate: (id: string, key: string, group: string) =>
    invoke<void>("redis_xgroup_create", { id, key, group }),
  xgroupDestroy: (id: string, key: string, group: string) =>
    invoke<boolean>("redis_xgroup_destroy", { id, key, group }),
  clusterSnapshot: (id: string) =>
    invoke<RedisClusterSnapshot>("redis_cluster_snapshot", { id }),
  listSetCas: (id: string, key: string, index: number, expected: string, next: string) =>
    invoke<void>("redis_list_set_cas", { id, key, index, expected, next }),
  listDeleteCas: (id: string, key: string, index: number, expected: string) =>
    invoke<void>("redis_list_delete_cas", { id, key, index, expected }),
  pubsubStart: (id: string, channel: string) =>
    invoke<string>("redis_pubsub_start", { id, channel }),
  pubsubPoll: (id: string, subscriptionId: string, limit = 50) =>
    invoke<RedisPubSubBatch>("redis_pubsub_poll", { id, subscriptionId, limit }),
  pubsubStop: (id: string, subscriptionId: string) =>
    invoke<void>("redis_pubsub_stop", { id, subscriptionId }),
};
