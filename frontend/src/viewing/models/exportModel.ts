import type { JgfDocument } from '@simplearchitecture/shared';

const maxFileNameLength = 100;

/**
 * A safe file name for a model. The name is free text, so anything a file system or a browser could
 * read as a path or a control character goes.
 */
export function exportFileName(modelName: string): string {
  const base = modelName
    .replace(/[\p{C}<>:"/\\|?*]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, maxFileNameLength)
    .trim();
  return `${base === '' ? 'model' : base}.json`;
}

/** Hands the browser the model as a JGF file to save. */
export function saveModelFile(document_: JgfDocument, modelName: string): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(document_, null, 2)}\n`], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = exportFileName(modelName);
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
