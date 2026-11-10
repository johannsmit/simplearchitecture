import type { ValidationIssue } from '@simplearchitecture/shared';

/** Import report reason codes in words. Unknown codes are shown as they are. */
const reasonWords: Record<string, string> = {
  'skipped-by-config': 'Skipped by the mapping settings',
  'unknown-element-type': 'Type not in the mapping',
  'missing-identifier': 'Has no identifier',
  'duplicate-identifier': 'Identifier used twice',
  'reserved-identifier': 'Identifier not allowed',
  'used-for-folding': 'Used to fold a function',
  'no-matching-rule': 'No relationship rule matches',
  'source-folded': 'Source was folded into an element',
  'target-folded': 'Target was folded into an element',
};

export function reasonInWords(code: string): string {
  return Object.hasOwn(reasonWords, code) ? (reasonWords[code] ?? code) : code;
}

/** Validation issue codes in words. Unknown codes are shown as they are. */
const issueWords: Record<string, string> = {
  'non-iso-country': 'Country is not an ISO code',
  'not-standard-for-type': 'Not a standard property for this type',
  'property-not-for-type': 'Property not for this relationship type',
  'retired-property': 'Data kept as it was',
  'older-data-property': 'Data converted to Request Data',
  'data-values-not-kept': 'Request or Response Data breaks its rules',
};

export function issueInWords(code: string): string {
  return Object.hasOwn(issueWords, code) ? (issueWords[code] ?? code) : code;
}

export interface IssueGroup {
  code: string;
  issues: ValidationIssue[];
}

/** Issues grouped by code, largest group first. */
export function groupIssues(issues: readonly ValidationIssue[]): IssueGroup[] {
  const byCode = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    const list = byCode.get(issue.code);
    if (list) list.push(issue);
    else byCode.set(issue.code, [issue]);
  }
  return [...byCode.entries()]
    .map(([code, list]) => ({ code, issues: list }))
    .sort((a, b) => b.issues.length - a.issues.length || a.code.localeCompare(b.code));
}

/** File size for people: "312 KB", "2.4 MB". */
export function fileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The file formats Admin → Models imports. */
export type ImportFormat = 'oef' | 'jgf';

/** Largest file the import takes, per format (the API checks again). */
const maxImportMegabytes: Record<ImportFormat, number> = { oef: 10, jgf: 5 };

const chooseFileMessage = 'Choose a JGF file (.json) or an ArchiMate OEF file (.xml).';

/**
 * Client checks before upload. Returns the file to upload, or the message to show.
 * The server checks the same things again.
 */
export function checkImportFiles(
  files: readonly File[],
): { ok: true; file: File; format: ImportFormat } | { ok: false; message: string } {
  const [file] = files;
  if (files.length !== 1 || !file) return { ok: false, message: 'Drop one file at a time.' };
  const name = file.name.toLowerCase();
  const format = name.endsWith('.xml') ? 'oef' : name.endsWith('.json') ? 'jgf' : undefined;
  if (format === undefined) return { ok: false, message: chooseFileMessage };
  const limit = maxImportMegabytes[format];
  if (file.size > limit * 1024 * 1024) {
    return {
      ok: false,
      message: `This file is ${fileSize(file.size)}. The limit for this type of file is ${limit} MB.`,
    };
  }
  return { ok: true, file, format };
}

/** The heading for a failed import, per status. */
export function importFailureHeading(status: number, format: ImportFormat): string {
  switch (status) {
    case 400:
      return format === 'jgf'
        ? "This file isn't a valid JGF file"
        : "This file isn't a valid OEF file";
    case 413:
      return 'The file or model is too large';
    case 415:
      return chooseFileMessage;
    case 409:
      return 'The store is full (500 models). Delete a model to import another.';
    case 401:
      return 'Your session ended. Sign in again, then import the file again.';
    case 403:
      return 'Importing needs the Admin role.';
    default:
      return "The import didn't finish. Try again in a moment.";
  }
}
