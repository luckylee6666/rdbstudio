import { afterEach, describe, expect, it, vi } from "vitest";
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { api } from "./api";
import type { ConnectionConfig, DesignerChange } from "@/types";

interface Recorded {
  cmd: string;
  payload: Record<string, unknown> | undefined;
}

function installRecorder(response: (cmd: string) => unknown) {
  const calls: Recorded[] = [];
  mockIPC((cmd, payload) => {
    calls.push({
      cmd,
      payload: payload as Record<string, unknown> | undefined,
    });
    return response(cmd);
  });
  return calls;
}

afterEach(() => {
  clearMocks();
});

describe("api", () => {
  it("listConnections invokes list_connections with no args and returns array", async () => {
    const fakeList: ConnectionConfig[] = [
      {
        id: "c1",
        name: "local",
        driver: "sqlite",
        file_path: "/tmp/db.sqlite",
      },
    ];
    const calls = installRecorder(() => fakeList);

    const result = await api.listConnections();

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("list_connections");
    expect(result).toEqual(fakeList);
  });

  it("saveConnection passes the config under args.config", async () => {
    const cfg: ConnectionConfig = {
      id: "c1",
      name: "local",
      driver: "postgres",
      host: "localhost",
      port: 5432,
      username: "u",
    };
    const calls = installRecorder(() => cfg);

    const saved = await api.saveConnection(cfg);

    expect(calls[0].cmd).toBe("save_connection");
    expect(calls[0].payload).toEqual({ config: cfg });
    expect(saved).toEqual(cfg);
  });

  it("executeQuery passes id and sql and returns QueryResult", async () => {
    const result = {
      columns: [{ name: "a", data_type: "INT" }],
      rows: [[1]],
      rows_affected: null,
      elapsed_ms: 3,
    };
    const calls = installRecorder(() => result);

    const got = await api.executeQuery("c1", "SELECT 1 AS a");

    expect(calls[0].cmd).toBe("execute_query");
    expect(calls[0].payload).toEqual({ id: "c1", sql: "SELECT 1 AS a" });
    expect(got).toEqual(result);
  });

  it("listSchemas passes database: null when omitted", async () => {
    const calls = installRecorder(() => ["public"]);

    await api.listSchemas("c1");

    expect(calls[0].cmd).toBe("list_schemas");
    expect(calls[0].payload).toEqual({ id: "c1", database: null });
  });

  it("listSchemas forwards database when provided", async () => {
    const calls = installRecorder(() => ["public"]);

    await api.listSchemas("c1", "mydb");

    expect(calls[0].payload).toEqual({ id: "c1", database: "mydb" });
  });

  it("previewCsv forwards all args and defaults limit to 5", async () => {
    const preview = { headers: ["a", "b"], sample_rows: [], total_sampled: 0 };
    const calls = installRecorder(() => preview);

    await api.previewCsv("/tmp/x.csv", ",", true);

    expect(calls[0].cmd).toBe("preview_csv");
    expect(calls[0].payload).toEqual({
      path: "/tmp/x.csv",
      delimiter: ",",
      hasHeader: true,
      limit: 5,
    });
  });

  it("generateAlterDdl passes schema: null when omitted", async () => {
    const plan = { statements: ["ALTER TABLE t ADD c INT"], warnings: [] };
    const calls = installRecorder(() => plan);
    const change: DesignerChange = {
      columns: [
        {
          name: "c",
          data_type: "INT",
          nullable: true,
          is_primary_key: false,
        },
      ],
    };

    const got = await api.generateAlterDdl("c1", "t", change);

    expect(calls[0].cmd).toBe("generate_alter_ddl");
    expect(calls[0].payload).toEqual({
      id: "c1",
      table: "t",
      change,
      schema: null,
    });
    expect(got).toEqual(plan);
  });

  it("propagates errors thrown by the mocked IPC handler", async () => {
    mockIPC(() => {
      throw new Error("boom");
    });
    await expect(api.listConnections()).rejects.toThrow("boom");
  });

  it("connectionStatus returns ConnectionSummary", async () => {
    const summary = { id: "c1", connected: true, server_version: "15.4" };
    const spy = vi.fn<(cmd: string, payload: unknown) => typeof summary>(
      () => summary
    );
    mockIPC((cmd, payload) => spy(cmd, payload));

    const got = await api.connectionStatus("c1");
    expect(got).toEqual(summary);
    expect(spy).toHaveBeenCalledWith("connection_status", { id: "c1" });
  });
});
