import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ModelReverseDialog } from "./ModelReverseDialog";
import { api } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { newModel } from "@/lib/offlineModel";
import type { ModelReversePreview, ModelSourceTable } from "@/lib/modelReverse";
vi.mock("@/lib/api", () => ({ api: { listDatabases: vi.fn(), listTables: vi.fn(), previewReverseModel: vi.fn() } }));
const config = [{ id: "pg", name: "Source", driver: "postgres" as const, read_only: true }, { id: "two", name: "Second", driver: "postgres" as const }, { id: "redis", name: "Redis", driver: "redis" as const }, { id: "off", name: "Offline", driver: "mysql" as const }];
function plan(tables: ModelSourceTable[]): ModelReversePreview { return { model: { ...newModel("postgres"), tables: tables.map((t,i) => ({ ...t, id: `t${i}`, comment: "", position: { x: 0, y: 0 }, columns: [{ id: `c${i}`, name: "id", type: "integer", nullable: false, primaryKey: true, unique: false, comment: "" }], primaryKey: [`c${i}`], uniqueKeys: [] })) }, warnings: [{ code: "coverage", object: "" }], omitted_warnings: 0 }; }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  vi.clearAllMocks(); useI18n.setState({ lang: "en" }); useConnections.setState({ list: config, status: { pg: "connected", two: "connected", redis: "connected", off: "disconnected" } });
  vi.mocked(api.listDatabases).mockResolvedValue(["first", "second"]);
  vi.mocked(api.listTables).mockImplementation(async (_id,schema) => [{ name: schema === "second" ? "other" : "items", kind: "table" }, { name: "view", kind: "view" }]);
  vi.mocked(api.previewReverseModel).mockImplementation(async (_id,tables) => plan(tables));
});
const source = () => fireEvent.change(screen.getByLabelText("Connected source database"), { target: { value: "pg" } });
const read = async () => { source(); fireEvent.click(await screen.findByLabelText("first.items")); fireEvent.click(screen.getByRole("button", { name: "Read & preview" })); await screen.findByRole("region", { name: "Imported model preview" }); };
it("reads across schemas under StrictMode, accepts readonly sources and saves only after explicit review", async () => {
  const save = vi.fn(async (_name: string, _model: ModelReversePreview["model"]) => true), close=vi.fn(); render(<StrictMode><ModelReverseDialog visible busy={false} saveError={null} onSave={save} onClose={close} /></StrictMode>);
  expect(screen.queryByRole("option", { name: /Redis|Offline/ })).not.toBeInTheDocument(); source(); fireEvent.click(await screen.findByLabelText("first.items"));
  fireEvent.change(screen.getByLabelText("Source schema / database"), { target: { value: "second" } });fireEvent.click(await screen.findByLabelText("second.other"));
  fireEvent.click(screen.getByRole("button", { name: "Read & preview" })); await screen.findByRole("region", { name: "Imported model preview" });
  expect(api.previewReverseModel).toHaveBeenCalledWith("pg", [{ schema:"first",name:"items" },{ schema:"second",name:"other" }]); expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name:"Save as new model" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name:/I reviewed/ }));fireEvent.change(screen.getByLabelText("Model name"),{ target:{ value:"Imported" } });fireEvent.click(screen.getByRole("button",{ name:"Save as new model" }));
  await waitFor(()=>expect(close).toHaveBeenCalledOnce());expect(save.mock.calls[0][0]).toBe("Imported");
});
it("ignores late source schema responses when selecting another connection", async () => {
  const pending=deferred<string[]>();vi.mocked(api.listDatabases).mockImplementation(id=>id==="pg"?pending.promise:Promise.resolve(["fresh"]));
  render(<ModelReverseDialog visible busy={false} saveError={null} onSave={vi.fn()} onClose={vi.fn()} />);source();fireEvent.change(screen.getByLabelText("Connected source database"),{target:{value:"two"}});
  await screen.findByRole("option",{name:"fresh"});await act(async()=>pending.resolve(["stale"]));expect(screen.queryByRole("option",{name:"stale"})).not.toBeInTheDocument();
});
it("discards a preview if the source disconnects while metadata is pending", async () => {
  const pending=deferred<ModelReversePreview>();vi.mocked(api.previewReverseModel).mockReturnValue(pending.promise);
  render(<ModelReverseDialog visible busy={false} saveError={null} onSave={vi.fn()} onClose={vi.fn()} />);source();fireEvent.click(await screen.findByLabelText("first.items"));fireEvent.click(screen.getByRole("button",{name:"Read & preview"}));
  act(()=>useConnections.setState({status:{pg:"disconnected"}}));await act(async()=>pending.resolve(plan([{schema:"first",name:"items"}])));
  expect(screen.queryByRole("region",{name:"Imported model preview"})).not.toBeInTheDocument();expect(screen.getByRole("button",{name:"Save as new model"})).toBeDisabled();
});
it("does not adopt or save metadata after the dialog unmounts", async () => {
  const pending=deferred<ModelReversePreview>();vi.mocked(api.previewReverseModel).mockReturnValue(pending.promise);const save=vi.fn();
  const view=render(<ModelReverseDialog visible busy={false} saveError={null} onSave={save} onClose={vi.fn()} />);source();fireEvent.click(await screen.findByLabelText("first.items"));fireEvent.click(screen.getByRole("button",{name:"Read & preview"}));view.unmount();await act(async()=>pending.resolve(plan([{schema:"first",name:"items"}])));expect(save).not.toHaveBeenCalled();
});
it("rejects a mismatched preview and requires a new preview after selection changes", async () => {
  vi.mocked(api.previewReverseModel).mockResolvedValueOnce(plan([{schema:"other",name:"wrong"}]));render(<ModelReverseDialog visible busy={false} saveError={null} onSave={vi.fn()} onClose={vi.fn()} />);
  source();fireEvent.click(await screen.findByLabelText("first.items"));fireEvent.click(screen.getByRole("button",{name:"Read & preview"}));expect(await screen.findByRole("alert")).toHaveTextContent("changed");
  fireEvent.click(screen.getByRole("button",{name:"Read & preview"}));await screen.findByRole("region",{name:"Imported model preview"});fireEvent.click(screen.getByRole("checkbox",{name:/I reviewed/}));fireEvent.click(screen.getByLabelText("first.items"));expect(screen.queryByRole("region",{name:"Imported model preview"})).not.toBeInTheDocument();
});
it("retains the preview and name when saving fails, and hides portals on inactive tabs", async () => {
  const save=vi.fn(async()=>false);const props={visible:true,busy:false,saveError:null,onSave:save,onClose:vi.fn()};const view=render(<ModelReverseDialog {...props} />);await read();fireEvent.click(screen.getByRole("checkbox",{name:/I reviewed/}));fireEvent.change(screen.getByLabelText("Model name"),{target:{value:"Draft"}});fireEvent.click(screen.getByRole("button",{name:"Save as new model"}));await waitFor(()=>expect(save).toHaveBeenCalled());
  view.rerender(<ModelReverseDialog {...props} saveError="Failed save" />);expect(screen.getByRole("alert")).toHaveTextContent("Failed save");expect(screen.getByLabelText("Model name")).toHaveValue("Draft");view.rerender(<ModelReverseDialog {...props} visible={false} />);expect(screen.queryByRole("dialog")).not.toBeInTheDocument();view.rerender(<ModelReverseDialog {...props} />);expect(screen.getByLabelText("Model name")).toHaveValue("Draft");
});
it("keeps the new schema loading state when an older table request finishes", async () => {
  const oldTables=deferred<Awaited<ReturnType<typeof api.listTables>>>(),newSchemas=deferred<string[]>();
  vi.mocked(api.listDatabases).mockImplementation(id=>id==="pg"?Promise.resolve(["old"]):newSchemas.promise);vi.mocked(api.listTables).mockReturnValue(oldTables.promise);
  render(<ModelReverseDialog visible busy={false} saveError={null} onSave={vi.fn()} onClose={vi.fn()} />);source();await waitFor(()=>expect(api.listTables).toHaveBeenCalled());fireEvent.change(screen.getByLabelText("Connected source database"),{target:{value:"two"}});
  expect(screen.getByRole("status")).toHaveTextContent("Reading source schemas");await act(async()=>oldTables.resolve([{name:"stale",kind:"table"}]));expect(screen.getByRole("status")).toHaveTextContent("Reading source schemas");expect(screen.queryByLabelText("old.stale")).not.toBeInTheDocument();await act(async()=>newSchemas.resolve(["new"]));
});
