import { asyncPanel } from "@/components/ui/asyncPanel";

// Stable component identities are essential for hidden query/plan sessions.
export const TableDataView = asyncPanel(() => import("./TableDataView").then(m => m.TableDataView));
export const QueryEditorView = asyncPanel(() => import("./QueryEditorView").then(m => m.QueryEditorView));
export const DesignerView = asyncPanel(() => import("./DesignerView").then(m => m.DesignerView));
export const ERView = asyncPanel(() => import("./ERView").then(m => m.ERView));
export const ExplainView = asyncPanel(() => import("./ExplainView").then(m => m.ExplainView));
export const ConnectionToolsView = asyncPanel(() => import("./ConnectionToolsView").then(m => m.ConnectionToolsView));
export const GlobalSearchView = asyncPanel(() => import("./GlobalSearchView").then(m => m.GlobalSearchView));
export const SyncView = asyncPanel(() => import("./SyncView").then(m => m.SyncView));
export const RedisKeyView = asyncPanel(() => import("./RedisKeyView").then(m => m.RedisKeyView));
export const ServerMonitorView = asyncPanel(() => import("./ServerMonitorView").then(m => m.ServerMonitorView));
export const QueryBuilderView = asyncPanel(() => import("./QueryBuilderView").then(m => m.QueryBuilderView));

export const OfflineModelView = asyncPanel(() => import("./OfflineModelView").then(m => m.OfflineModelView));
