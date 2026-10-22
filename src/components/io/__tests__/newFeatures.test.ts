import { describe, expect, it } from "vitest";
import { autoDetectMaskKind } from "../ExportDialog";
import { inferColumnGeneratorConfig } from "../DataGeneratorDialog";
import { buildErSvg, loadErPositions, saveErPositions } from "../../er/ERDiagram";
import { tabDisplay } from "@/lib/tabTitles";
import type { ColumnDetail, TableDescription } from "@/types";

function makeCol(overrides: Partial<ColumnDetail>): ColumnDetail {
  return {
    name: "col",
    data_type: "TEXT",
    nullable: true,
    ordinal_position: 1,
    is_primary_key: false,
    is_auto_increment: false,
    ...overrides,
  };
}

describe("new workbench features", () => {
  it("auto-detects sensitive column mask kinds by column name", () => {
    expect(autoDetectMaskKind("user_email")).toBe("email");
    expect(autoDetectMaskKind("mobile_phone")).toBe("phone");
    expect(autoDetectMaskKind("password_hash")).toBe("redact");
    expect(autoDetectMaskKind("api_token")).toBe("redact");
    expect(autoDetectMaskKind("id_card_no")).toBe("partial");
    expect(autoDetectMaskKind("full_name")).toBe("name");
    expect(autoDetectMaskKind("created_at")).toBeNull();
  });

  it("infers test data generator rules from column metadata", () => {
    expect(
      inferColumnGeneratorConfig(
        makeCol({
          name: "id",
          data_type: "INTEGER",
          is_primary_key: true,
          is_auto_increment: true,
          nullable: false,
        })
      ).rule
    ).toBe("skip");

    expect(
      inferColumnGeneratorConfig(
        makeCol({
          name: "id",
          data_type: "BIGINT",
          is_primary_key: true,
          is_identity: true,
          nullable: false,
        })
      ).rule
    ).toBe("skip");

    expect(
      inferColumnGeneratorConfig(
        makeCol({
          name: "id",
          data_type: "INTEGER",
          is_primary_key: true,
          is_auto_increment: false,
          nullable: false,
        })
      ).rule
    ).toBe("sequence");

    expect(
      inferColumnGeneratorConfig(
        makeCol({ name: "contact_email", data_type: "VARCHAR(255)" })
      ).rule
    ).toBe("email");

    expect(
      inferColumnGeneratorConfig(
        makeCol({ name: "status", data_type: "TEXT" })
      ).rule
    ).toBe("enum_list");

    expect(
      inferColumnGeneratorConfig(
        makeCol({ name: "price", data_type: "NUMERIC(10,2)" })
      ).rule
    ).toBe("random_float");
  });

  it("persists ER diagram node positions and renders standalone SVG", () => {
    const key = "conn1:public";
    saveErPositions(key, { users: { x: 120, y: 80 } });
    expect(loadErPositions(key)).toEqual({ users: { x: 120, y: 80 } });

    const tables: TableDescription[] = [
      {
        schema: "public",
        name: "users",
        columns: [
          makeCol({
            name: "id",
            data_type: " int4",
            is_primary_key: true,
            nullable: false,
          }),
          makeCol({ name: "email", data_type: "text" }),
        ],
        primary_key: ["id"],
        foreign_keys: [],
        indexes: [],
      },
      {
        schema: "public",
        name: "orders",
        columns: [
          makeCol({
            name: "id",
            data_type: "int4",
            is_primary_key: true,
            nullable: false,
          }),
          makeCol({ name: "user_id", data_type: "int4", nullable: false }),
        ],
        primary_key: ["id"],
        foreign_keys: [
          {
            name: "fk_orders_user",
            columns: ["user_id"],
            referenced_table: "users",
            referenced_columns: ["id"],
          },
        ],
        indexes: [],
      },
    ];

    const svg = buildErSvg(tables, loadErPositions(key));
    expect(svg).toContain("<svg");
    expect(svg).toContain("users");
    expect(svg).toContain("orders");
    expect(svg).toContain("<path");

    saveErPositions(key, {});
    expect(loadErPositions(key)).toEqual({});
  });

  it("resolves localized title for monitor tab kind", () => {
    const display = tabDisplay(
      { id: "tool:monitor", kind: "monitor", title: "Server monitor" },
      (k) => `translated:${k}`
    );
    expect(display.title).toBe("translated:tool.monitor.title");
  });
});
