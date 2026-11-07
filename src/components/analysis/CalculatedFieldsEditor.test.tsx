import { captureAnalysisConfiguration } from "@/lib/analysisPresets";
import { DEFAULT_TIME_OPTIONS } from "@/lib/resultTime";
import { DEFAULT_METRIC_OPTIONS } from "@/lib/resultCharts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalculatedFieldsEditor } from "./CalculatedFieldsEditor";
import { ResultAnalysis } from "./ResultAnalysis";
import { calculateRows, type CalculatedField, type CalculationPlan } from "@/lib/calculatedFields";
import { runAnalysis, calculationFailure, type AnalysisPipelineRequest } from "@/lib/analysisPipeline";
import { useI18n } from "@/store/i18n";
import { saveTextFile } from "@/lib/csv";
const api=vi.hoisted(()=>({listAnalysisPresets:vi.fn(),getAnalysisPreset:vi.fn(),saveAnalysisPreset:vi.fn()}));
vi.mock("@/lib/api",()=>({api}));
vi.mock("@/components/theme/ThemeProvider",()=>({useTheme:()=>({theme:"light"})}));
vi.mock("@/lib/csv",async original=>({...await original<object>(),saveTextFile:vi.fn().mockResolvedValue(null)}));
class MockWorker {
  static all:MockWorker[]=[]; terminated=false; request!:AnalysisPipelineRequest|{rows:unknown[][];plan:CalculationPlan}; onmessage:((event:{data:unknown})=>void)|null=null;
  constructor(){MockWorker.all.push(this);} postMessage(request:MockWorker["request"]){this.request=request;} terminate(){this.terminated=true;}
  finish(){try{this.onmessage?.({data:"plan" in this.request?{preview:calculateRows(this.request.rows,this.request.plan,true).preview}:runAnalysis(this.request)});}catch(cause){this.onmessage?.({data:calculationFailure(cause)});}}
}
const columns=[{name:"price",data_type:"DECIMAL"},{name:"quantity",data_type:"INTEGER"},{name:"category",data_type:"TEXT"}];
const rows=[["2.5",3,"East"],["4",2,"West"]];
const applied=vi.fn(), closed=vi.fn();
const fields:CalculatedField[]=[{id:"total",name:"Total",type:"number",expression:"[1]*[2]"}];
const finish=()=>act(()=>MockWorker.all.at(-1)!.finish());
beforeEach(()=>{vi.resetAllMocks();MockWorker.all=[];vi.stubGlobal("Worker",MockWorker);useI18n.setState({lang:"en"});api.listAnalysisPresets.mockResolvedValue([]);api.saveAnalysisPreset.mockResolvedValue({id:"id"});});
afterEach(()=>vi.unstubAllGlobals());
function editor(f:CalculatedField[]=[],sourceRows=rows){return render(<CalculatedFieldsEditor columns={columns} rows={sourceRows} fields={f} onApply={applied} onClose={closed}/>);}
describe("calculated field editor",()=>{
 it("requires successful whole-snapshot validation and previews exact values before applying",()=>{
  editor();fireEvent.click(screen.getByRole("button",{name:"Add calculated field"}));fireEvent.change(screen.getByLabelText("Field name"),{target:{value:"Revenue"}});fireEvent.change(screen.getByLabelText("Formula"),{target:{value:"[1]*[2]"}});
  expect(screen.getByRole("button",{name:"Apply calculated fields"})).toBeDisabled();fireEvent.click(screen.getByRole("button",{name:"Validate and preview"}));expect(MockWorker.all.at(-1)!.request.rows).toEqual([["2.5",3],["4",2]]);finish();
  expect(screen.getByText("Validated 2 loaded rows. Preview shows the first 20.")).toBeInTheDocument();expect(screen.getByText("7.5")).toBeInTheDocument();fireEvent.click(screen.getByRole("button",{name:"Apply calculated fields"}));expect(applied).toHaveBeenCalledWith([expect.objectContaining({name:"Revenue",expression:"[1]*[2]",type:"number"})]);
 });
 it("checks beyond the preview window, reports the failing field and row and retains drafts",()=>{
  const source=Array.from({length:25},(_,i)=>[i===24?"bad":"2.5",3,"East"]);editor(fields,source);fireEvent.click(screen.getByRole("button",{name:"Validate and preview"}));finish();
  expect(screen.getByRole("alert")).toHaveTextContent("Total · Row 25");expect(screen.getByRole("button",{name:"Apply calculated fields"})).toBeDisabled();expect(screen.getByLabelText("Formula")).toHaveValue("[1]*[2]");
 });
 it("cancels obsolete validation and prevents late worker responses from enabling Apply",()=>{
  const ui=editor(fields);fireEvent.click(screen.getByRole("button",{name:"Validate and preview"}));const old=MockWorker.all.at(-1)!;fireEvent.change(screen.getByLabelText("Formula"),{target:{value:"[1]+1"}});expect(old.terminated).toBe(true);act(()=>old.finish());expect(screen.getByRole("button",{name:"Apply calculated fields"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"Validate and preview"}));const current=MockWorker.all.at(-1)!;ui.unmount();expect(current.terminated).toBe(true);act(()=>current.finish());expect(applied).not.toHaveBeenCalled();
 });
 it("allows removal of blank drafts and prevents deleting referenced fields",()=>{
  const ui=editor();fireEvent.click(screen.getByRole("button",{name:"Add calculated field"}));fireEvent.click(screen.getByRole("button",{name:"Add calculated field"}));fireEvent.click(screen.getByRole("button",{name:"Delete calculated field"}));expect(screen.queryByRole("alert")).toBeNull();expect(screen.getByLabelText("Field name")).toHaveValue("Calculation 1");ui.unmount();
  editor([...fields,{id:"profit",name:"Profit",type:"number",expression:"[4]-1"}]);fireEvent.click(screen.getByRole("button",{name:"Delete calculated field"}));expect(screen.getByRole("alert")).toHaveTextContent("referenced by another formula");
 });
 it("invalidates the old analysis, exposes calculated columns and saves only compact formula definitions",async()=>{
  render(<ResultAnalysis snapshot={{columns,rows,label:"private SQL source",scope:"result"}} onClose={closed}/>);const original=MockWorker.all[0];
  fireEvent.click(screen.getByRole("button",{name:"Calculated fields"}));fireEvent.click(screen.getByRole("button",{name:"Add calculated field"}));fireEvent.change(screen.getByLabelText("Field name"),{target:{value:"Revenue"}});fireEvent.change(screen.getByLabelText("Formula"),{target:{value:"[1]*[2]"}});fireEvent.click(screen.getByRole("button",{name:"Validate and preview"}));finish();fireEvent.click(screen.getByRole("button",{name:"Apply calculated fields"}));
  expect(original.terminated).toBe(true);act(()=>original.finish());expect(screen.getByRole("button",{name:"Export analysis JSON"})).toBeDisabled();fireEvent.change(screen.getByLabelText("Profile column"),{target:{value:"3"}});fireEvent.click(screen.getByRole("checkbox",{name:"Interpret numeric text as numbers"}));finish();expect(screen.getByText("15.5")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"Analysis configurations"}));await waitFor(()=>expect(api.listAnalysisPresets).toHaveBeenCalled());fireEvent.click(screen.getByRole("button",{name:"Save current as new"}));fireEvent.change(screen.getByLabelText("Configuration name"),{target:{value:"Formula"}});fireEvent.click(screen.getByRole("button",{name:"Save configuration"}));await waitFor(()=>expect(api.saveAnalysisPreset).toHaveBeenCalled());
  const saved=api.saveAnalysisPreset.mock.calls[0][0];expect(saved.config).toMatchObject({version:2,bindings:{profile:{calculated:0}},calculations:{inputs:[{name:"price",ordinal:0},{name:"quantity",ordinal:1}],fields:[{name:"Revenue",expression:"[1]*[2]"}]}});expect(JSON.stringify(saved)).not.toContain("private SQL");expect(JSON.stringify(saved)).not.toContain("2.5");expect(JSON.stringify(saved)).not.toContain("East");
 });
 it("loads version 2 with changed input positions and keeps numeric calculations when text parsing is off",async()=>{
  const config={version:2,mode:"profile",chart:"bar",bindings:{profile:{calculated:0}},aggregate:"sum",parseStrings:false,axisKind:"category",timeOptions:{input:"iso",naive:"utc",bucket:"instant"},metricOptions:{target:"",minimum:"0",maximum:"100",direction:"higher",comparison:"previous"},sample:true,series:{mode:"total"},calculations:{inputs:[{name:"quantity",dataType:"INTEGER",ordinal:1},{name:"price",dataType:"DECIMAL",ordinal:0}],fields:[{...fields[0],expression:"[1]*[2]"}]}};
  api.listAnalysisPresets.mockResolvedValue([{id:"id",revision:"r",name:"Saved formula",mode:"profile",chart:"bar",has_series_values:false}]);api.getAnalysisPreset.mockResolvedValue({config});
  render(<ResultAnalysis snapshot={{columns,rows,label:"Snapshot",scope:"result"}} onClose={closed}/>);fireEvent.click(screen.getByRole("button",{name:"Analysis configurations"}));await screen.findByRole("option",{name:/Saved formula/});fireEvent.change(screen.getByLabelText("Select configuration"),{target:{value:"id"}});fireEvent.click(screen.getByRole("button",{name:"Load and map fields"}));
  const mapping=await screen.findByRole("dialog",{name:"Review column mapping"});expect(within(mapping).getByLabelText("Formula input [1]")).toHaveValue("1");expect(within(mapping).getByLabelText("Formula input [2]")).toHaveValue("0");fireEvent.click(screen.getByRole("button",{name:"Apply to snapshot"}));finish();expect(screen.getByText("15.5")).toBeInTheDocument();
  expect(screen.getByRole("checkbox",{name:"Interpret numeric text as numbers"})).not.toBeChecked();fireEvent.click(screen.getByRole("button",{name:"Export analysis JSON"}));await waitFor(()=>expect(saveTextFile).toHaveBeenCalled());expect(JSON.parse(vi.mocked(saveTextFile).mock.calls[0][1]).calculatedFields[0].expression).toBe("[2]*[1]");
 });
 it("lets imported calculated fields be renamed when target source names collide",async()=>{
  const config=captureAnalysisConfiguration(columns,{mode:"profile",chart:"bar",column:3,row:0,split:-1,measure:0,aggregate:"sum",parseStrings:false,axisKind:"category",timeOptions:DEFAULT_TIME_OPTIONS,metricOptions:DEFAULT_METRIC_OPTIONS,scatterX:0,scatterY:1,scatterLabel:-1,sample:true,calculatedFields:fields},{mode:"total"});
  api.listAnalysisPresets.mockResolvedValue([{id:"id",revision:"r",name:"Collision",mode:"profile",chart:"bar",has_series_values:false}]);api.getAnalysisPreset.mockResolvedValue({config});
  render(<ResultAnalysis snapshot={{columns:[...columns,{name:"Total",data_type:"TEXT"}],rows:rows.map(r=>[...r,"source"]),label:"Snapshot",scope:"result"}} onClose={closed}/>);
  fireEvent.click(screen.getByRole("button",{name:"Analysis configurations"}));await screen.findByRole("option",{name:/Collision/});fireEvent.change(screen.getByLabelText("Select configuration"),{target:{value:"id"}});fireEvent.click(screen.getByRole("button",{name:"Load and map fields"}));await screen.findByRole("dialog",{name:"Review column mapping"});
  fireEvent.click(screen.getByRole("button",{name:"Apply to snapshot"}));expect(screen.getByRole("alert")).toHaveTextContent("Choose a valid target");
  fireEvent.change(screen.getByLabelText("Field name [3]"),{target:{value:"Derived total"}});fireEvent.click(screen.getByRole("button",{name:"Apply to snapshot"}));finish();expect(screen.getByLabelText("Profile column")).toHaveValue("4");expect(screen.getByText("15.5")).toBeInTheDocument();
 });

});
