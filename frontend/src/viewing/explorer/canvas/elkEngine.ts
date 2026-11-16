import ELK from 'elkjs/lib/elk-api';
import elkWorkerUrl from 'elkjs/lib/elk-worker.min.js?url';

let instance: InstanceType<typeof ELK> | undefined;

/**
 * The ELK instance for the canvas. ELK runs in a web worker (the one elkjs ships), so laying out
 * a large neighbourhood never blocks the page. A layout that takes too long stops the worker
 * (`terminateWorker`): the next layout then gets a new one. Tests replace this module with
 * in-process ELK.
 */
export function getElk(): InstanceType<typeof ELK> {
  if (!instance) {
    const elk = new ELK({ workerUrl: elkWorkerUrl });
    const terminate = elk.terminateWorker.bind(elk);
    elk.terminateWorker = () => {
      if (instance === elk) instance = undefined;
      terminate();
    };
    instance = elk;
  }
  return instance;
}
