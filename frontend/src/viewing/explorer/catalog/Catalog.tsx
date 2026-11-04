import {
  architectureStates,
  catalogCell,
  catalogTable,
  catalogTabs,
  defaultCatalogSort,
  filterFields,
  isIsoCountryCode,
  sourcingOptions,
  type CatalogColumn,
  type CatalogSort,
  type CatalogTab,
  type ElementChangeResult,
  type ModelElement,
  type ModelGraph,
  type NodeType,
} from '@simplearchitecture/shared';
import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { ApiRequestError, getElement } from '../../../api';
import { Icon } from '../../../icons';
import { StateBadge, TypeMark } from '../../../metamodel-ui';
import { cellChange, cellError, cellServerErrors, cellText } from '../../../modelling/draft';
import type { EditorHandle, EditorState } from '../../../modelling/ElementEditor';
import { saveCell } from '../../../modelling/save';
import { counted, formatNumber } from '../../../words';
import { activeFilterCount } from '../ElementFilter';
import { PropertyValue } from '../DetailsPanel';
import type { ElementSearch } from '../search';
import { SearchControls } from '../SearchControls';
import { CellEditor, type CellEdit, type CellMove } from './CellEditor';

/** The sort per model and tab, for this tab's session. */
const sortByModelTab = new Map<string, CatalogSort>();
/** The last tab used per model, for this tab's session. */
const lastTabByModel = new Map<string, CatalogTab>();

/** Forgets the sorts and last tabs (as a reload does). For tests. */
export function forgetCatalogState(): void {
  sortByModelTab.clear();
  lastTabByModel.clear();
}

/** The tab the catalog opens on: the selected element's type, else the last one used, else All. */
export function catalogTabOnEntry(modelId: string, selectedType: NodeType | undefined): CatalogTab {
  return selectedType ?? lastTabByModel.get(modelId) ?? 'all';
}

/** How long the cursor rests on a row before the details panel follows it. */
export const followDelayMillis = 200;
const descriptionTitleLength = 500;
/** Column widths, for the table's least width; Description takes the rest, at least 240px. */
const columnWidths: Readonly<Record<string, number>> = {
  name: 240,
  type: 150,
  description: 240,
  architectureState: 160,
  owningTeam: 180,
  supplierHqCountry: 170,
  sourcing: 110,
  functions: 220,
};
const rowHeight = 36;

/** Modelling with editing on: what saving a cell needs from the explorer. */
export interface CatalogEditing {
  versionOf: (id: string) => number | undefined;
  onStored: (result: ElementChangeResult) => void;
  /** Someone else deleted the element: it leaves the model. */
  onGone: (id: string) => void;
  onAnnounce: (text: string) => void;
  /** For the unsaved changes dialog: an open, changed cell. */
  handle: RefObject<EditorHandle | null>;
  onState: (state: EditorState | null) => void;
}

interface CatalogProps {
  modelId: string;
  graph: ModelGraph;
  /** The elements that match the search and filters. */
  matches: readonly ModelElement[];
  search: ElementSearch;
  tab: CatalogTab;
  onTab: (tab: CatalogTab) => void;
  selectedId: string | undefined;
  /** Selects an element (asking first about unsaved changes), then runs `then`. */
  onSelect: (id: string, then?: () => void) => void;
  /** Focuses the element on the canvas. */
  onFocusElement: (id: string) => void;
  editing?: CatalogEditing;
  hint: string;
  /** Under "This model has no elements yet". */
  emptyText: string;
}

/**
 * The cursor cell: `id` null is the header row. It holds while the selection is the one it was
 * set under (`selection`); a selection from elsewhere moves it to the selected row.
 */
interface Cursor {
  id: string | null | undefined;
  col: number;
  selection: string;
}

const tabLabel = (tab: CatalogTab) => (tab === 'all' ? 'All' : tab);
const cellId = (row: number | 'h', col: number) => `cc-${row}-${col}`;

function choiceOptions(key: string): readonly string[] | undefined {
  if (key === 'architectureState') return architectureStates;
  if (key === 'sourcing') return sourcingOptions;
  return undefined;
}

/** A cell's value, shown as in the details panel. */
function CellValue({ element, column }: { element: ModelElement; column: CatalogColumn }) {
  const { key } = column;
  if (key === 'name') return element.name ? element.name : <i>(unnamed)</i>;
  if (key === 'type') {
    return (
      <>
        <TypeMark type={element.type} />
        {element.type}
      </>
    );
  }
  const { text } = catalogCell(element, key);
  if (text === '') {
    return (
      <>
        <span className="muted" aria-hidden="true">
          –
        </span>
        <span className="vh">Not set</span>
      </>
    );
  }
  const options = choiceOptions(key);
  if (options !== undefined) {
    if (!options.includes(text)) {
      return (
        <span className="not-iso" title={`Not one of ${options.join(', ')}`}>
          {text} <Icon name="alert" size="sm" />
          <span className="vh"> (not one of {options.join(', ')})</span>
        </span>
      );
    }
    return key === 'architectureState' ? (
      <StateBadge state={text as (typeof architectureStates)[number]} />
    ) : (
      text
    );
  }
  if (key === 'supplierHqCountry') {
    return <PropertyValue row={{ key, label: column.label, value: text }} />;
  }
  if (key === 'description') return text.replace(/\n+/g, ' ');
  return text;
}

function titleOf(element: ModelElement, column: CatalogColumn, editable: boolean): string {
  const { key } = column;
  if (key === 'type') return editable ? 'Change the type in the details panel' : element.type;
  const { value, text } = catalogCell(element, key);
  if (text === '') return '';
  if (key === 'description' && text.length > descriptionTitleLength) {
    return `${text.slice(0, descriptionTitleLength)}…`;
  }
  if (key === 'functions' && Array.isArray(value)) return value.map(String).join('\n');
  if (key === 'supplierHqCountry' && !isIsoCountryCode(text)) {
    return `${text}: Not an ISO 3166-1 alpha-2 code`;
  }
  return text;
}

interface RowProps {
  element: ModelElement;
  index: number;
  columns: readonly CatalogColumn[];
  selected: boolean;
  /** The column of the cursor in this row, or -1. */
  cursorCol: number;
  editable: boolean;
  /** The column being edited in this row, or -1, and its editor. */
  editCol: number;
  editor: ReactNode;
}

const CatalogRow = memo(function CatalogRow({
  element,
  index,
  columns,
  selected,
  cursorCol,
  editable,
  editCol,
  editor,
}: RowProps) {
  return (
    <tr aria-selected={selected} className={selected ? 'is-selected' : undefined} data-row={index}>
      {columns.map((column, col) => {
        const Cell = col === 0 ? 'th' : 'td';
        const editing = col === editCol;
        return (
          <Cell
            key={column.key}
            id={cellId(index, col)}
            role={col === 0 ? 'rowheader' : 'gridcell'}
            {...(col === 0 ? { scope: 'row' } : {})}
            data-col={col}
            tabIndex={col === cursorCol && !editing ? 0 : -1}
            aria-readonly={editable && column.key === 'type' ? true : undefined}
            title={editing ? undefined : titleOf(element, column, editable) || undefined}
            className={`cat-${column.key}${editable && column.key !== 'type' ? ' is-editable' : ''}${editing ? ' is-editing' : ''}`}
          >
            {editing ? (
              editor
            ) : (
              <span className="cat-text">
                <CellValue element={element} column={column} />
              </span>
            )}
          </Cell>
        );
      })}
    </tr>
  );
});

/**
 * The catalog: the search row, the type tabs and the elements that
 * match as an ARIA grid. Viewing reads; Modelling with editing on edits the name and the standard
 * properties in place, one cell at a time, with the details panel's versions and conflicts.
 */
export function Catalog(props: CatalogProps) {
  const { modelId, graph, matches, search, tab, onTab, selectedId, editing } = props;
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  const fields = useMemo(() => filterFields(graph), [graph]);
  const searchInput = useRef<HTMLInputElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const tablist = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const sortKey = `${modelId}|${tab}`;
  const [sorts, setSorts] = useState<ReadonlyMap<string, CatalogSort>>(
    () => new Map(sortByModelTab),
  );
  const sort = sorts.get(sortKey) ?? defaultCatalogSort;
  const live = useMemo(() => catalogTable(matches, tab, sort), [matches, tab, sort]);
  const { columns, counts } = live;

  useEffect(() => {
    lastTabByModel.set(modelId, tab);
  }, [modelId, tab]);

  // Rows don't jump under you: the order is kept until the tab, the sort, the search, the
  // filters or the number of elements change. A saved edit only changes the row's values.
  const orderKey = `${sortKey}|${sort.column}|${sort.direction}|${search.query}|${JSON.stringify(search.filters)}|${graph.elements.size}`;
  const [order, setOrder] = useState(() => ({
    key: orderKey,
    ids: live.rows.map((row) => row.element.id),
  }));
  let orderIds = order.ids;
  if (order.key !== orderKey) {
    orderIds = live.rows.map((row) => row.element.id);
    setOrder({ key: orderKey, ids: orderIds });
  }
  const rows = useMemo(
    () =>
      orderIds
        .map((id) => graph.elements.get(id))
        .filter(
          (element): element is ModelElement =>
            element !== undefined && (tab === 'all' || element.type === tab),
        ),
    [orderIds, graph, tab],
  );
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows]);

  // The cursor: a cell, or a header cell (id null). By default the selected row's Name cell.
  const selectedType = selectedId === undefined ? undefined : graph.elements.get(selectedId)?.type;
  const selectionKey = `${selectedId ?? ''}|${selectedType ?? ''}`;
  const [cursor, setCursor] = useState<Cursor>({ id: undefined, col: 0, selection: '' });
  const own = cursor.selection === selectionKey;
  const cursorId: string | null | undefined =
    own && cursor.id === null
      ? null
      : own && typeof cursor.id === 'string' && rowIndex.has(cursor.id)
        ? cursor.id
        : selectedId !== undefined && rowIndex.has(selectedId)
          ? selectedId
          : rows[0]?.id;
  const cursorCol = Math.min(cursor.col, columns.length - 1);
  const cursorRow = cursorId === null ? -1 : (rowIndex.get(cursorId ?? '') ?? -1);
  const moveFocus = useRef(false);
  /** The cursor was moved by keys: the selection follows once it rests. */
  const follow = useRef(false);

  const [edit, setEdit] = useState<CellEdit | null>(null);
  const editRef = useRef(edit);
  useLayoutEffect(() => {
    editRef.current = edit;
  });

  /**
   * Scrolls the grid so a cell or row shows whole: below the sticky header and, for a cell other
   * than Name, right of the sticky Name column. The browser's own scrolling on focus doesn't know
   * the sticky parts and can leave the row a pixel under the edge.
   */
  const revealInGrid = (target: HTMLElement, besideName: boolean) => {
    const box = scroller.current;
    if (!box) return;
    const header = box.querySelector('thead')?.getBoundingClientRect().height ?? rowHeight;
    const name = besideName
      ? (box.querySelector('thead th')?.getBoundingClientRect().width ?? 0)
      : 0;
    const area = box.getBoundingClientRect();
    const bottom = area.top + box.clientHeight;
    const right = area.left + box.clientWidth;
    const at = target.getBoundingClientRect();
    if (at.top < area.top + header) box.scrollTop -= area.top + header - at.top;
    else if (at.bottom > bottom) box.scrollTop += Math.ceil(at.bottom - bottom);
    if (at.left < area.left + name) box.scrollLeft -= area.left + name - at.left;
    else if (at.right > right) box.scrollLeft += Math.ceil(at.right - right);
  };

  const focusCursor = () => {
    moveFocus.current = true;
  };
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    const id = cursorRow === -1 ? cellId('h', cursorCol) : cellId(cursorRow, cursorCol);
    const target = document.getElementById(id);
    if (!target) return;
    target.focus({ preventScroll: true });
    if (cursorRow !== -1) revealInGrid(target, cursorCol !== 0);
  });

  const go = (id: string | null | undefined, col: number, byKeys = true) => {
    setCursor({ id, col, selection: selectionKey });
    follow.current = byKeys;
    focusCursor();
  };

  // The details panel follows the cursor once it rests, so holding ↓ stays smooth.
  useEffect(() => {
    if (!follow.current || typeof cursorId !== 'string' || cursorId === selectedId) return;
    const id = cursorId;
    const timer = setTimeout(() => {
      follow.current = false;
      latest.current.onSelect(id);
    }, followDelayMillis);
    return () => {
      clearTimeout(timer);
    };
  }, [cursorId, selectedId]);

  // A selection from outside the table (the list, the panel, the address): the cursor goes to its
  // row, the catalog shows its type's tab (All never switches) and the row scrolls into view.
  const seenSelection = useRef(selectionKey);
  // On entering the catalog (or Back to it), the selected row is in view.
  const scrollTo = useRef<string | null>(selectedId ?? null);
  useEffect(() => {
    if (seenSelection.current === selectionKey) return;
    seenSelection.current = selectionKey;
    if (selectedId === undefined || selectedType === undefined) return;
    if (!matches.some((element) => element.id === selectedId)) return;
    if (tab !== 'all' && selectedType !== tab) latest.current.onTab(selectedType);
    scrollTo.current = selectedId;
  }, [selectionKey, selectedId, selectedType, matches, tab]);
  useEffect(() => {
    if (scrollTo.current === null) return;
    const index = rowIndex.get(scrollTo.current);
    const box = scroller.current;
    if (index === undefined || !box) return;
    scrollTo.current = null;
    const row = box.querySelector<HTMLElement>(`tr[data-row="${index}"] > th`);
    if (row) revealInGrid(row, false);
  });

  // A row that leaves the model (deleted in the panel, or by someone else): the cursor, the
  // selection and keyboard focus go to the next row (the previous one if it was last).
  const previous = useRef<{ ids: string[]; cursorId: string | null | undefined }>({
    ids: [],
    cursorId: undefined,
  });
  useEffect(() => {
    const before = previous.current;
    previous.current = { ids: rows.map((row) => row.id), cursorId };
    const gone = before.cursorId;
    if (typeof gone !== 'string' || graph.elements.has(gone)) return;
    const at = before.ids.indexOf(gone);
    const next = rows[Math.min(Math.max(at, 0), rows.length - 1)];
    if (next) {
      // The selection moves there, and the cursor with it.
      focusCursor();
      latest.current.onSelect(next.id);
    } else {
      tablist.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    }
  }, [rows, cursorId, graph]);

  const toggleSort = (column: CatalogColumn) => {
    const next: CatalogSort =
      sort.column === column.key
        ? { column: column.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { column: column.key, direction: 'asc' };
    sortByModelTab.set(sortKey, next);
    setSorts(new Map(sortByModelTab));
  };

  // Editing.
  const editElement = edit === null ? undefined : graph.elements.get(edit.id);
  const dirty =
    edit !== null &&
    editElement !== undefined &&
    cellChange(editElement, edit.key, edit.text) !== undefined;
  const canSave = edit !== null && edit.conflict === null && !edit.forbidden;
  const editName = editElement?.name ?? '';
  const onState = editing?.onState;
  const open = edit !== null;
  useEffect(() => {
    onState?.(open ? { dirty, name: editName, canSave, cell: true } : null);
  }, [onState, open, dirty, editName, canSave]);
  useEffect(
    () => () => {
      onState?.(null);
    },
    [onState],
  );

  const close = (move: CellMove, from: CellEdit) => {
    // At once, not after the next render: a click replayed after the save must pass.
    editRef.current = null;
    setEdit(null);
    latest.current.editing?.onState(null);
    // A click elsewhere (or Save in the unsaved changes dialog): the click decides where the
    // cursor goes, not the save.
    if (move === 'none') return;
    const row = rowIndex.get(from.id) ?? 0;
    let { col } = from;
    let id: string | undefined = from.id;
    if (move === 'down') id = rows[Math.min(row + 1, rows.length - 1)]?.id ?? from.id;
    if (move === 'right') col = Math.min(col + 1, columns.length - 1);
    if (move === 'left') col = Math.max(col - 1, 0);
    go(id, col, move === 'down');
  };

  const commit = async (move: CellMove, override?: string): Promise<boolean> => {
    const current = editRef.current;
    if (!current || current.saving || current.conflict !== null || current.forbidden) return false;
    const element = graph.elements.get(current.id);
    const save = latest.current.editing;
    if (!element || !save) return false;
    const text = override ?? current.text;
    if (cellChange(element, current.key, text) === undefined) {
      close(move, current);
      return true;
    }
    const problem = cellError(element, current.key, text);
    if (problem !== undefined) {
      setEdit({ ...current, text, messages: [problem] });
      return false;
    }
    setEdit({ ...current, text, saving: true, messages: [] });
    try {
      const result = await saveCell(
        modelId,
        element,
        save.versionOf(element.id),
        current.key,
        text,
      );
      if (result) save.onStored(result);
      save.onAnnounce('Saved.');
      close(move, current);
      return true;
    } catch (error) {
      const status = error instanceof ApiRequestError ? error.status : 0;
      const body = error instanceof ApiRequestError ? error.body : undefined;
      const failed = { ...current, text, saving: false, messages: [] as string[] };
      const issues = (body as { fields?: unknown } | undefined)?.fields;
      if (status === 422 && Array.isArray(issues)) {
        failed.messages = cellServerErrors(
          current.key,
          issues.filter(
            (issue): issue is { field: string; message: string } =>
              typeof (issue as { field?: unknown } | null)?.field === 'string' &&
              typeof (issue as { message?: unknown }).message === 'string',
          ),
        );
      } else if (status === 409) {
        failed.conflict = 'changed';
      } else if (
        status === 404 &&
        (body as { missing?: unknown } | undefined)?.missing !== 'model'
      ) {
        failed.conflict = 'deleted';
      } else if (status === 403) {
        failed.forbidden = true;
        failed.messages = ['You can no longer edit this model.'];
      } else if (status === 0 || status >= 500) {
        failed.messages = ["The change wasn't saved. Check your connection and try again."];
      } else {
        const message = error instanceof Error ? error.message : '';
        failed.messages = [`The change wasn't saved. ${message}`.trim()];
      }
      setEdit(failed);
      return false;
    }
  };

  const cancel = () => {
    const current = editRef.current;
    if (!current) return;
    setEdit(null);
    go(current.id, current.col, false);
  };

  const resolveConflict = async () => {
    const current = editRef.current;
    const save = latest.current.editing;
    if (!current || !save) return;
    if (current.conflict === 'deleted') {
      setEdit(null);
      save.onGone(current.id);
      return;
    }
    try {
      const fresh = await getElement(modelId, current.id);
      save.onStored(fresh);
      save.onAnnounce('Reloaded. Showing the latest version.');
      setEdit(null);
      go(current.id, current.col, false);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) {
        setEdit({ ...current, conflict: 'deleted' });
      } else {
        setEdit({ ...current, messages: ["The element couldn't be reloaded. Try again."] });
      }
    }
  };

  useImperativeHandle(editing?.handle, () => ({
    save: () => commit('none'),
    discard: () => {
      setEdit(null);
    },
    name: editName,
    canSave,
  }));

  /** Opens a cell: with its value, empty, or with a typed character. */
  const openCell = (
    id: string,
    col: number,
    start: { text?: string; letter?: string; suggest?: boolean } = {},
  ) => {
    const column = columns[col];
    const element = graph.elements.get(id);
    if (!editing || !column || column.key === 'type' || !element || edit !== null) return;
    const key = column.key;
    const choice = choiceOptions(key) !== undefined;
    let text = start.text ?? cellText(element, key);
    let letter: string | undefined;
    if (start.letter !== undefined) {
      if (choice) letter = start.letter;
      else text = start.letter;
    }
    latest.current.onSelect(id, () => {
      follow.current = false;
      setCursor({ id, col, selection: `${id}|${element.type}` });
      setEdit({
        id,
        col,
        key,
        text,
        saving: false,
        messages: [],
        conflict: null,
        forbidden: false,
        ...(letter === undefined ? {} : { letter }),
        // Suggestions open at once, unless it was opened with Enter or F2.
        ...(start.suggest === true || start.letter !== undefined ? { suggesting: true } : {}),
        ...(start.letter !== undefined && !choice ? { typedFirst: true } : {}),
      });
    });
  };

  // A click elsewhere in the explorer saves the open cell; what the click does happens once the
  // save succeeds. An unchanged cell just closes.
  useEffect(() => {
    if (!open) return;
    const onClick = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.cat-editor') || !target.closest('.explorer')) return;
      const current = editRef.current;
      const element = current ? graph.elements.get(current.id) : undefined;
      if (!current || !element) return;
      if (cellChange(element, current.key, current.text) === undefined && !current.saving) {
        setEdit(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void commit('none').then((ok) => {
        if (ok && target.isConnected) target.click();
      });
    };
    window.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('click', onClick, true);
    };
  });

  // The grid's keys.
  const pageSize = () => {
    const height = scroller.current?.clientHeight ?? 0;
    return height > rowHeight * 2 ? Math.floor(height / rowHeight) - 1 : 10;
  };

  const onGridKey = (event: KeyboardEvent<HTMLTableElement>) => {
    if (edit !== null) return;
    const last = rows.length - 1;
    const lastCol = columns.length - 1;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const idAt = (index: number) => (index < 0 ? null : (rows[Math.min(index, last)]?.id ?? null));
    const ctrl = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case 'ArrowDown':
        handled();
        go(idAt(Math.min(cursorRow + 1, last)), cursorCol);
        return;
      case 'ArrowUp':
        handled();
        go(cursorRow <= 0 ? null : idAt(cursorRow - 1), cursorCol);
        return;
      case 'ArrowRight':
        handled();
        go(cursorId, Math.min(cursorCol + 1, lastCol));
        return;
      case 'ArrowLeft':
        handled();
        go(cursorId, Math.max(cursorCol - 1, 0));
        return;
      case 'Home':
        handled();
        go(ctrl ? idAt(0) : cursorId, 0);
        return;
      case 'End':
        handled();
        go(ctrl ? idAt(last) : cursorId, lastCol);
        return;
      case 'PageDown':
        handled();
        go(idAt(Math.min(cursorRow + pageSize(), last)), cursorCol);
        return;
      case 'PageUp':
        handled();
        go(cursorRow === -1 ? null : idAt(Math.max(cursorRow - pageSize(), 0)), cursorCol);
        return;
    }
    if (cursorId === null) {
      const column = columns[cursorCol];
      if ((event.key === 'Enter' || event.key === ' ') && column) {
        handled();
        toggleSort(column);
      }
      return;
    }
    if (cursorId === undefined) return;
    if (event.key === 'Enter') {
      handled();
      if (event.shiftKey || !editing) props.onFocusElement(cursorId);
      else openCell(cursorId, cursorCol);
      return;
    }
    if (ctrl || event.altKey) return;
    if (editing) {
      if (event.key === 'F2') {
        handled();
        openCell(cursorId, cursorCol);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        handled();
        openCell(cursorId, cursorCol, { text: '', suggest: true });
      } else if (event.key === ' ') {
        handled();
      } else if (event.key.length === 1 && event.key !== '/') {
        handled();
        openCell(cursorId, cursorCol, { letter: event.key });
      }
      return;
    }
    // Viewing: a letter jumps to the next row whose name starts with it.
    if (event.key.length === 1 && /\S/.test(event.key) && event.key !== '/') {
      const letter = event.key.toLowerCase();
      for (let step = 1; step <= rows.length; step++) {
        const candidate = rows[(cursorRow + step) % rows.length];
        if (candidate?.name.toLowerCase().startsWith(letter)) {
          handled();
          go(candidate.id, cursorCol);
          return;
        }
      }
    }
  };

  const cellOf = (event: MouseEvent<HTMLTableElement>) => {
    const cell = (event.target as HTMLElement).closest<HTMLElement>('[data-col]');
    if (!cell) return undefined;
    const col = Number(cell.dataset.col);
    const tr = cell.closest<HTMLElement>('tr[data-row]');
    const id = tr ? rows[Number(tr.dataset.row)]?.id : null;
    return id === undefined ? undefined : { id, col };
  };

  const onGridClick = (event: MouseEvent<HTMLTableElement>) => {
    if ((event.target as HTMLElement).closest('.cat-editor')) return;
    const at = cellOf(event);
    if (!at) return;
    const column = columns[at.col];
    if (at.id === null) {
      go(null, at.col, false);
      if (column) toggleSort(column);
      return;
    }
    go(at.id, at.col, false);
    // A single click selects; it never edits.
    if (at.id !== selectedId) props.onSelect(at.id);
  };

  const onGridDoubleClick = (event: MouseEvent<HTMLTableElement>) => {
    if ((event.target as HTMLElement).closest('.cat-editor')) return;
    const at = cellOf(event);
    if (!at || at.id === null) return;
    if (editing) openCell(at.id, at.col, { suggest: true });
    else props.onFocusElement(at.id);
  };

  // The tabs: one Tab stop, ← → Home End show another tab at once.
  const focusTab = useRef(false);
  useEffect(() => {
    if (!focusTab.current) return;
    focusTab.current = false;
    tablist.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, [tab]);
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = catalogTabs.indexOf(tab);
    const to =
      event.key === 'ArrowRight'
        ? (at + 1) % catalogTabs.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + catalogTabs.length) % catalogTabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? catalogTabs.length - 1
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const next = catalogTabs[to];
    if (next === undefined || next === tab) return;
    focusTab.current = true;
    onTab(next);
  };

  if (graph.elements.size === 0) {
    return (
      <div id="canvas" tabIndex={-1} className="canvas canvas-state">
        <div className="empty">
          <Icon name="layers" />
          <h2>This model has no elements yet</h2>
          <p>{props.emptyText}</p>
        </div>
      </div>
    );
  }

  const filtering = activeFilterCount(search.filters) > 0;
  const typed = search.query.trim();
  const narrowed = typed !== '' || filtering;
  const total = graph.elements.size;
  const resultText = narrowed
    ? `${formatNumber(matches.length)} of ${counted(total, 'element')} match`
    : counted(total, 'element');
  const clearFilters = () => {
    search.setFilters({});
    filterButton.current?.focus();
  };
  const clearSearch = () => {
    search.setQuery('');
    searchInput.current?.focus();
  };

  let noRows: ReactNode = null;
  if (matches.length === 0) {
    noRows = !filtering ? (
      <>
        No elements match &ldquo;{typed}&rdquo;.{' '}
        <button type="button" className="linkbtn" onClick={clearSearch}>
          Clear search
        </button>
      </>
    ) : typed === '' ? (
      <>
        No elements match these filters.{' '}
        <button type="button" className="linkbtn" onClick={clearFilters}>
          Clear filters
        </button>
      </>
    ) : (
      <>
        No elements match &ldquo;{typed}&rdquo; with these filters.{' '}
        <button type="button" className="linkbtn" onClick={clearFilters}>
          Clear filters
        </button>{' '}
        ·{' '}
        <button type="button" className="linkbtn" onClick={clearSearch}>
          Clear search
        </button>
      </>
    );
  } else if (rows.length === 0 && tab !== 'all') {
    noRows = narrowed ? (
      <>
        No {tab} elements match.{' '}
        <button
          type="button"
          className="linkbtn"
          onClick={() => {
            focusTab.current = true;
            onTab('all');
          }}
        >
          {matches.length === 1
            ? 'See the match'
            : `See all ${formatNumber(matches.length)} matches`}
        </button>
      </>
    ) : (
      <>This model has no {tab} elements.</>
    );
  }

  const editorFor = (element: ModelElement): ReactNode => {
    if (edit === null || edit.id !== element.id) return null;
    const column = columns[edit.col];
    if (!column) return null;
    return (
      <CellEditor
        graph={graph}
        element={element}
        column={column}
        edit={edit}
        onText={(text) => {
          setEdit({ ...edit, text, messages: [] });
        }}
        onCommit={(move, text) => {
          void commit(move, text);
        }}
        onCancel={cancel}
        onConflict={() => {
          void resolveConflict();
        }}
      />
    );
  };

  return (
    <div id="canvas" tabIndex={-1} className="catalog">
      <div className="cat-search">
        <SearchControls
          graph={graph}
          fields={fields}
          search={search}
          inputRef={searchInput}
          filterButtonRef={filterButton}
        />
        <div className="result-count" aria-live="polite">
          {resultText}
        </div>
      </div>
      <div className="cat-tabs-row">
        <div
          ref={tablist}
          className="cat-tabs"
          role="tablist"
          aria-label="Element types"
          onKeyDown={onTabKey}
        >
          {catalogTabs.map((t) => {
            const count = counts[t];
            const name = tabLabel(t);
            return (
              <button
                key={t}
                id={`cat-tab-${t}`}
                type="button"
                role="tab"
                aria-selected={t === tab}
                aria-controls="cat-panel"
                aria-label={`${name}, ${counted(count, 'element')}${narrowed ? (count === 1 ? ' matches' : ' match') : ''}`}
                tabIndex={t === tab ? 0 : -1}
                onClick={() => {
                  if (t !== tab) onTab(t);
                }}
              >
                {name} <span className="count">{formatNumber(count)}</span>
              </button>
            );
          })}
        </div>
        <p id="catalog-hint" className="cat-hint">
          {props.hint}
        </p>
      </div>
      <div className="cat-panel" id="cat-panel" role="tabpanel" aria-labelledby={`cat-tab-${tab}`}>
        {noRows !== null ? (
          <p className="tree-empty cat-empty">{noRows}</p>
        ) : (
          <div className="cat-scroll" ref={scroller}>
            <table
              className="cat-grid"
              role="grid"
              aria-label={`${tabLabel(tab)} elements`}
              aria-describedby="catalog-hint"
              aria-readonly={editing ? undefined : true}
              style={{
                minWidth: columns.reduce((sum, column) => sum + (columnWidths[column.key] ?? 0), 0),
              }}
              onKeyDown={onGridKey}
              onClick={onGridClick}
              onDoubleClick={onGridDoubleClick}
            >
              <colgroup>
                {columns.map((column) => (
                  <col key={column.key} className={`col-${column.key}`} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((column, col) => {
                    const active = sort.column === column.key;
                    return (
                      <th
                        key={column.key}
                        id={cellId('h', col)}
                        role="columnheader"
                        scope="col"
                        data-col={col}
                        tabIndex={cursorRow === -1 && cursorCol === col ? 0 : -1}
                        title={`Sort by ${column.label}`}
                        aria-sort={
                          active
                            ? sort.direction === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : undefined
                        }
                        className={`cat-${column.key}${active ? ' is-sorted' : ''}`}
                      >
                        <span className="cat-th">
                          {column.label}
                          {active && (
                            <Icon
                              name={sort.direction === 'asc' ? 'arrow-up' : 'arrow-down'}
                              size="sm"
                            />
                          )}
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((element, index) => (
                  <CatalogRow
                    key={element.id}
                    element={element}
                    index={index}
                    columns={columns}
                    selected={element.id === selectedId}
                    cursorCol={index === cursorRow ? cursorCol : -1}
                    editable={editing !== undefined}
                    editCol={edit !== null && edit.id === element.id ? edit.col : -1}
                    editor={editorFor(element)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
