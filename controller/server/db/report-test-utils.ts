// Test fixtures exercise the same staged protocol as production. Full report
// materialization lives only in this assertion helper, never in a service/API.
import { createHash, randomUUID } from "node:crypto";
import type { ControlPlaneService } from "../services/control-plane.js";
import type { ValidationCaseResult } from "../domain/models.js";
import type { ReportResults } from "../services/report-results.js";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export async function stageCases(reports: ReportResults, runId: string, results: ValidationCaseResult[]) {
  const batches: ValidationCaseResult[][] = [];
  let batch: ValidationCaseResult[] = [], bytes = 0;
  for (const result of results) {
    const size = Buffer.byteLength(JSON.stringify(result));
    if (batch.length && (batch.length >= 50 || bytes + size > 1024 * 1024)) { batches.push(batch); batch=[];bytes=0; }
    batch.push(result); bytes+=size;
  }
  if (batch.length) batches.push(batch);
  batches.push([]);
  const hashes = batches.map(value => digest(JSON.stringify(value)));
  const manifestDigest = digest(hashes.join("\n")), uploadId = manifestDigest;
  let offset = 0;
  for (let sequence=0;sequence<batches.length;sequence++) {
    await reports.stage({runId,runnerBootId:"fixture",uploadId,manifestDigest,sequence,chunks:batches.length,cases:results.length,caseOffset:offset,
      rawBytes:Buffer.byteLength(JSON.stringify(batches[sequence])),digest:hashes[sequence]!,final:sequence===batches.length-1,results:batches[sequence]!});
    offset+=batches[sequence]!.length;
  }
}
export async function completeReport(service: ControlPlaneService, input: Parameters<ControlPlaneService["completeValidation"]>[0] & {results:ValidationCaseResult[]}) {
  await stageCases(service.reportResults,input.runId,input.results);
  const {results:_results,...metadata}=input;
  await service.completeValidation(metadata);
}
export async function getReport(service: ControlPlaneService,id:string) {
  const summary=await service.getValidationRun(id), results:ValidationCaseResult[]=[];
  let cursor: string|undefined;
  do {
    const page=await service.reportResults.page(id,{cursor});
    for (const row of page.items) {
      const {traceCount:_count,nextTraceOffset,...body}=await service.reportResults.detail(id,row.ordinal);
      let offset=nextTraceOffset;
      while(offset!==null) { const more=await service.reportResults.detail(id,row.ordinal,offset);body.trace.push(...more.trace);offset=more.nextTraceOffset; }
      results[row.ordinal]=body;
    }
    cursor=page.nextCursor??undefined;
  } while(cursor);
  return {...summary,results};
}
