/**
 * Runs a heavy on-device job (privacy scan, step labels) on a worker thread, so the desktop app's
 * main process (which also serves the editor) never blocks. The desktop build bundles this file as
 * dist/jobWorker.cjs and sets LENS_JOB_WORKER to it; elsewhere (dev server, tests) jobs.ts runs the
 * same functions in-process.
 */
import { parentPort, workerData } from "node:worker_threads";
import { runJob, type JobRequest } from "./jobs";

const req = workerData as JobRequest;
runJob(req, (stage, done, total) => parentPort?.postMessage({ type: "progress", stage, done, total }))
  .then((result) => parentPort?.postMessage({ type: "done", result }))
  .catch((e) => parentPort?.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) }));
