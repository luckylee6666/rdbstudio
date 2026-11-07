import { describe, expect, it } from "vitest";
import { calculateRows, prepareCalculations, compileExpression, rewriteReferences, validateCalculatedFields, type CalculatedField, type CalculationType } from "./calculatedFields";
import { runAnalysis, calculationFailure } from "./analysisPipeline";
import { decimal, compare } from "./resultAnalysis";
const columns = [{ name: "price", data_type: "DECIMAL" }, { name: "quantity", data_type: "INTEGER" }, { name: "category", data_type: "TEXT" }];
const field = (expression: string, type: CalculationType = "number", name = "Derived", id = "derived"): CalculatedField => ({ id, name, expression, type });
function compute(expression: string, type: CalculationType = "number", rows: unknown[][] = [["2.50",3,"East"]]) {
  const plan = prepareCalculations([field(expression,type)],columns);
  return calculateRows(rows.map(row=>plan.inputs.map(i=>row[i])),plan,true).preview!;
}
const value = (expression: string, type: CalculationType = "number") => compute(expression,type).rows[0][0].value;
describe("bounded calculated fields", () => {
  it("parses precedence, unary operations, SQL text escapes and explicit numbered references", () => {
    expect(value("[1] * [2] + 1")).toBe("8.5"); expect(value("-(1 + 2) * +4")).toBe("-12");
    expect(value("NOT 1 = 2 AND TRUE OR FALSE","boolean")).toBe(true);
    expect(value("'it''s [99]'", "text")).toBe("it's [99]");
    expect(rewriteReferences("[1] + [3] + NUMBER('4[1]')",i=>i+2)).toBe("[3] + [5] + NUMBER('4[1]')");
    for(const expr of ["window.alert(1)","constructor()","__proto__()","[0]","[4]","[01]","1; SELECT 1","1 +","1,2","'unterminated","ABS(1,2)","MAX(1)","IF(TRUE,1)","[1].value","1e513"]) expect(()=>compileExpression(expr,3),expr).toThrow();
  });
  it("preserves i64 and decimals, exact division, signed remainder and explicit rounding", () => {
    expect(value("9223372036854775807 + 1")).toBe("9223372036854775808"); expect(value("0.1 + 0.2")).toBe("0.3");
    expect(value("1/8")).toBe("0.125"); expect(value("0/3")).toBe("0"); expect(value("1/-8")).toBe("-0.125");
    expect(value("-5.5 % 2")).toBe("-1.5"); expect(()=>value("1/3")).toThrow("calculation_precision"); expect(()=>value("1/0")).toThrow("calculation_zero");
    expect(value("DIVIDE(1,3,12)")).toBe("0.333333333333"); expect(compute("DIVIDE(1,3,12)").stats.roundedRows).toBe(1);
    expect(value("DIVIDE(-1,8,2)")).toBe("-0.13"); expect(value("ROUND(-1.25,1)")).toBe("-1.3"); expect(value("ROUND(150,-2)")).toBe("200");
    expect(value("FLOOR(-1.2)")).toBe("-2"); expect(value("CEIL(-1.2)")).toBe("-1"); expect(value("TRUNC(-1.2)")).toBe("-1");
    expect(()=>value("DIVIDE(1,3,129)")).toThrow("calculation_arguments");
  });
  it("retains the supported exponent/precision boundary without fixed-point reparse loss", () => {
    for(const expression of ["1e512", "1e-512", "."+"0".repeat(255)+"1e-512", "9".repeat(256)+"e512", "1e512/2", "1e-512/2"]) {
      const result = value(expression) as string; expect(decimal(result),expression).not.toBeNull();
      if (!expression.includes('/')) expect(compare(decimal(result)!,decimal(expression)!)).toBe(0);
    }
    expect(()=>value("1e512*1e512")).toThrow("calculation_overflow");
    expect(()=>value("1e-512*1e-512")).toThrow("calculation_overflow");
  });
  it("short circuits conditions and applies three-valued NULL logic without coercing truthiness", () => {
    expect(value("IF(TRUE, 3, 1/0)")).toBe("3"); expect(value("IF(NULL, 1/0, 5)")).toBe("5"); expect(value("COALESCE(NULL, 4, 1/0)")).toBe("4");
    expect(value("1 / NULLIF(0,0)")).toBeNull(); expect(value("NULL+1")).toBeNull(); expect(value("ISNULL(NULL)","boolean")).toBe(true);
    for(const [expr,expected] of [["NULL AND FALSE",false],["NULL AND TRUE",null],["NULL OR TRUE",true],["NULL OR FALSE",null],["NOT NULL",null],["1=NULL",null],["FALSE AND 1/0",false],["TRUE OR 1/0",true]] as const) expect(value(expr,"boolean")).toBe(expected);
    expect(()=>value("IF(1,2,3)")).toThrow("calculation_type"); expect(()=>value("'1'", "boolean")).toThrow("calculation_type");
  });
  it("supports typed text operations with Unicode code-point slicing and conversion", () => {
    expect(value("CONCAT(UPPER([3]), ':', TEXT([1]*[2]))","text")).toBe("EAST:7.5"); expect(value("LENGTH('👋中文')")).toBe("3");
    expect(value("SUBSTRING('A👋中文',2,2)","text")).toBe("👋中"); expect(value("REPLACE('a-a-a','a','B')","text")).toBe("B-B-B");
    expect(value("CONTAINS(LOWER([3]),'east')","boolean")).toBe(true); expect(value("STARTSWITH('abc','a') AND ENDSWITH('abc','c')","boolean")).toBe(true);
    expect(()=>value("CONCAT('a',1)","text")).toThrow("calculation_type"); expect(()=>value("REPLACE('a','','x')","text")).toThrow("calculation_arguments");
    expect(value("MIN(1,ABS(-2),NUMBER('0.1'))")).toBe("0.1");
  });
  it("handles strict UTC dates, offsets, nanoseconds and explicit calendar units", () => {
    expect(value("DATE(2024,2,29)","time")).toBe("2024-02-29T00:00:00Z"); expect(value("YEAR('2026-01-01T01:00:00+02:00')")).toBe("2025");
    expect(value("DATEADD('1969-12-31T23:59:59.999999999Z',1,'second')","time")).toBe("1970-01-01T00:00:00.999999999Z");
    expect(value("DATEDIFF('2026-11-02','2026-11-01T12:00:00Z','day')")).toBe("0"); expect(value("WEEKDAY('2026-11-02')")).toBe("1");
    expect(value("DATE_TRUNC('month','2026-11-06T03:04:05Z')","time")).toBe("2026-11-01T00:00:00Z");
    expect(()=>value("DATE(2025,2,29)","time")).toThrow("calculation_time"); expect(()=>value("DATEADD('9999-12-31',1,'day')","time")).toThrow("calculation_time");
    expect(()=>value("DATEADD('2026-11-01',1,'month')","time")).toThrow("calculation_arguments");
  });
  it("evaluates ordered dependencies, reports row/field errors, and never partially returns failed output", () => {
    const fields=[field("[1]*[2]"),field("[4]-1","number","Profit","profit")], plan=prepareCalculations(fields,columns);
    const result=calculateRows([["2.5",3],["4",2]],plan,true).preview!; expect(result.rows.map(r=>r.map(c=>c.value))).toEqual([["7.5","6.5"],["8","7"]]);
    try { calculateRows([["2.5",3],["bad",2]],plan); throw new Error("expected error"); } catch(cause) { expect(calculationFailure(cause).calculationError).toMatchObject({code:"type",row:1,field:0}); }
    expect(()=>validateCalculatedFields([field("[4]")],columns)).toThrow("calculation_reference"); expect(()=>validateCalculatedFields([field("[1]","number","price")],columns)).toThrow("calculation_name");
  });
  it("bounds syntax, input/output text and projected data; handles unsafe integers explicitly", () => {
    expect(()=>compileExpression('('.repeat(40)+'1'+')'.repeat(40),3)).toThrow("calculation_complexity");
    expect(()=>compute("[3]","text",[[1,2,"x".repeat(8193)]])).toThrow("calculation_text");
    expect(()=>compute("REPLACE([3],'a','bb')","text",[[1,2,"a".repeat(5000)]])).toThrow("calculation_text");
    expect(()=>compute("[1]","number",[[9007199254740992,1,"x"]])).toThrow("calculation_type");
    expect(()=>prepareCalculations(Array.from({length:17},(_,i)=>field("1","number",`f${i}`,`f${i}`)),columns)).toThrow("calculation_limit");
  });
  it("feeds exact calculated numeric results into profiles/pivots/scatter independently of text parsing", () => {
    const fields=[field("[1]*[2]")], raw=[["2.5",3,"A"],["4",2,"A"]];
    const run=(kind:"profile"|"pivot"|"scatter")=>{const plan=prepareCalculations(fields,columns,kind==="profile"?[3]:kind==="pivot"?[2,-1,3]:[3,1,-1]);return runAnalysis(kind==="profile"?{kind,parseStrings:false,rows:raw.map(r=>plan.inputs.map(i=>r[i])),calculations:plan}:kind==="pivot"?{kind,parseStrings:false,aggregate:"sum",split:false,rows:raw.map(r=>plan.inputs.map(i=>r[i])),calculations:plan}:{kind,parseStrings:false,sample:true,labels:false,rows:raw.map(r=>plan.inputs.map(i=>r[i])),calculations:plan}).result;};
    const profile=run("profile");expect(profile.kind==="profile"&&profile.sum.value).toBe("15.5");const pivot=run("pivot");expect(pivot.kind==="pivot"&&pivot.total.value).toBe("15.5");const scatter=run("scatter");expect(scatter.kind==="scatter"&&scatter.points.map(p=>p.x.value)).toEqual(["7.5","8"]);
  });
  it("keeps earlier text fields and source cells unchanged when later fields convert them", () => {
    const fields=[field("'001'","text","Text","text"),field("[4]","number","Number","number"),field("[4]","text","Copy","copy")];
    const plan=prepareCalculations(fields,columns); const result=calculateRows([[]],plan,true).preview!;
    expect(result.rows[0].map(c=>c.value)).toEqual(["001","1","001"]);
    const sourcePlan=prepareCalculations([field("[3]","number","Number","number"),field("[3]","text","Text","text")],columns);
    expect(calculateRows([["001"]],sourcePlan,true).preview!.rows[0].map(c=>c.value)).toEqual(["1","001"]);
  });
  it("rejects incomplete projections and keeps plain numeric text subject to the parsing option", () => {
    const plan=prepareCalculations([field("[1]*2")],columns,[3,2,-1]);
    const result=runAnalysis({kind:"scatter",parseStrings:false,sample:true,labels:false,rows:[["2.5","3"]],calculations:plan}).result;
    expect(result.kind==="scatter"&&result.invalid).toBe(1);
    expect(()=>calculateRows([["2.5"]],{...plan,inputs:[0]})).toThrow("calculation_reference");
    expect(()=>runAnalysis({kind:"profile",parseStrings:false,rows:[],calculations:plan})).toThrow("calculation_reference");
  });
  it("enforces whole-snapshot work and generated-output budgets even when previewing only twenty rows", () => {
    // Each row is small and each formula is valid, but the full workload is not.
    const expression=Array.from({length:250},()=>"FALSE").join(" OR ");
    const expensive=prepareCalculations(Array.from({length:16},(_,i)=>field(expression,"boolean",`f${i}`,`f${i}`)),[]);
    expect(()=>calculateRows(Array.from({length:3000},()=>[]),expensive,true)).toThrow("calculation_budget");
    const expanded=prepareCalculations([field("CONCAT([1],[1])","text")],[{name:"source",data_type:"TEXT"}]);
    // Under 32 MiB of source text, over 32 MiB after expansion.
    expect(()=>calculateRows(Array.from({length:5000},()=>["x".repeat(2000)]),expanded,true)).toThrow("size");
    expect(()=>calculateRows(Array.from({length:50001},()=>[]),prepareCalculations([field("1")],[]),true)).toThrow("calculation_limit");
  });

});
