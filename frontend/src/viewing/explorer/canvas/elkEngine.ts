import ELK from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';

let instance: InstanceType<typeof ELK> | undefined;

/**
 * The ELK instance for the canvas. ELK runs in a web worker (the one elkjs ships), so laying out
 * a large neighbourhood never blocks the page. Tests replace this module with in-process ELK.
 */
export function getElk(): InstanceType<typeof ELK> {
  instance ??= new ELK({ workerUrl: elkWorkerUrl });
  return instance;
}
