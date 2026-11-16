import {
  compareNames,
  normaliseForSearch,
  viewFolderKey,
  type ViewSummary,
} from '@simplearchitecture/shared';
import { useCallback, useState } from 'react';
import { readPref, writePref } from '../../prefs';

/** One folder of the Views list: its views by name. `key` is the compared form of its name. */
export interface ViewFolder {
  key: string;
  name: string;
  views: ViewSummary[];
}

/** The Views list: the folders by name, then the views without a folder by name. */
export interface ViewGroups {
  folders: ViewFolder[];
  loose: ViewSummary[];
}

const byName = (a: ViewSummary, b: ViewSummary): number => compareNames(a.name, b.name);

/** Groups the views by folder; a folder exists only while a view is in it. */
export function groupViews(views: readonly ViewSummary[]): ViewGroups {
  const folders = new Map<string, ViewFolder>();
  const loose: ViewSummary[] = [];
  for (const view of views) {
    if (view.folder === null) {
      loose.push(view);
      continue;
    }
    const key = viewFolderKey(view.folder);
    let folder = folders.get(key);
    if (!folder) {
      folder = { key, name: view.folder, views: [] };
      folders.set(key, folder);
    }
    folder.views.push(view);
  }
  for (const folder of folders.values()) folder.views.sort(byName);
  return {
    folders: [...folders.values()].sort((a, b) => compareNames(a.name, b.name)),
    loose: loose.sort(byName),
  };
}

/**
 * The groups the filter shows: a folder whose name matches with all its views, a folder with only
 * its matching views, and the matching views without a folder. An empty needle shows everything.
 */
export function filterGroups(groups: ViewGroups, needle: string): ViewGroups {
  if (needle === '') return groups;
  const matches = (text: string) => normaliseForSearch(text).includes(needle);
  const folders = groups.folders.flatMap((folder): ViewFolder[] => {
    if (matches(folder.name)) return [folder];
    const views = folder.views.filter((view) => matches(view.name));
    return views.length === 0 ? [] : [{ ...folder, views }];
  });
  return { folders, loose: groups.loose.filter((view) => matches(view.name)) };
}

/** The model's folder names by name, for the Folder field. */
export function folderNames(views: readonly ViewSummary[]): string[] {
  return groupViews(views).folders.map((folder) => folder.name);
}

/** The folder of these views with the same name, ignoring case and spaces at the ends. */
export function folderNamed(views: readonly ViewSummary[], name: string): string | undefined {
  const key = viewFolderKey(name);
  return (
    views.find((view) => view.folder !== null && viewFolderKey(view.folder) === key)?.folder ??
    undefined
  );
}

/**
 * A short hash of a folder's compared form (53 bits, base 36), so the browser remembers a closed
 * folder without keeping its name: browser storage holds no model content.
 */
export function folderHash(name: string): string {
  const text = viewFolderKey(name);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const closedKey = (modelId: string) => `view-folders-closed-${modelId}`;

function readClosed(modelId: string): Set<string> {
  const stored = readPref(closedKey(modelId));
  return new Set(
    stored === null ? [] : stored.split(' ').filter((hash) => /^[0-9a-z]+$/.test(hash)),
  );
}

function writeClosed(modelId: string, closed: ReadonlySet<string>): void {
  writePref(closedKey(modelId), closed.size === 0 ? null : [...closed].join(' '));
}

export interface ClosedFolders {
  isClosed: (name: string) => boolean;
  toggle: (name: string) => void;
  /** A folder renamed in this browser keeps its state. */
  carry: (from: string, to: string) => void;
  /** Forgets folders that no longer exist. */
  keepOnly: (names: readonly string[]) => void;
}

/**
 * Which folders of the model are closed, remembered in this browser per model, by hash. Folders
 * start open.
 */
export function useClosedFolders(modelId: string): ClosedFolders {
  const [state, setState] = useState(() => ({ modelId, closed: readClosed(modelId) }));
  const closed = state.modelId === modelId ? state.closed : readClosed(modelId);
  if (state.modelId !== modelId) setState({ modelId, closed });

  const update = useCallback(
    (change: (current: Set<string>) => Set<string>) => {
      setState((previous) => {
        const current = previous.modelId === modelId ? previous.closed : readClosed(modelId);
        const next = change(new Set(current));
        if (next.size === current.size && [...next].every((hash) => current.has(hash))) {
          return previous.modelId === modelId ? previous : { modelId, closed: current };
        }
        writeClosed(modelId, next);
        return { modelId, closed: next };
      });
    },
    [modelId],
  );

  return {
    isClosed: (name) => closed.has(folderHash(name)),
    toggle: (name) => {
      update((current) => {
        const hash = folderHash(name);
        if (current.has(hash)) current.delete(hash);
        else current.add(hash);
        return current;
      });
    },
    carry: (from, to) => {
      update((current) => {
        const before = folderHash(from);
        if (!current.has(before)) return current;
        current.delete(before);
        current.add(folderHash(to));
        return current;
      });
    },
    keepOnly: (names) => {
      update((current) => {
        const existing = new Set(names.map(folderHash));
        return new Set([...current].filter((hash) => existing.has(hash)));
      });
    },
  };
}
