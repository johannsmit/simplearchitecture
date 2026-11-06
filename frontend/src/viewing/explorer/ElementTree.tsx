import {
  elementListTree,
  filterFields,
  findElements,
  listAncestorsOf,
  matchRange,
  nodeTypes,
  type ElementListRow,
  type ModelGraph,
  type NodeType,
} from '@simplearchitecture/shared';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Icon } from '../../icons';
import { TypeMark } from '../../metamodel-ui';
import { counted, formatNumber } from '../../words';
import { elementDragType } from './canvas/view';
import { activeFilterCount } from './ElementFilter';
import { useElementSearch, type ElementSearch } from './search';
import { SearchControls } from './SearchControls';

export { forgetElementFilters } from './search';

/** Which groups are open, per model, for this tab's session. */
const openByModel = new Map<string, Set<NodeType>>();
/** Which elements with children are open, per model, for this tab's session. */
const openElementsByModel = new Map<string, Set<string>>();
/** Forgets which groups and elements are open in every model (as a reload does). For tests. */
export function forgetOpenRows(): void {
  openByModel.clear();
  openElementsByModel.clear();
}

/** A visible row, in order. `level` is the ARIA level: groups 1, top-level elements 2, … */
type Row =
  | { kind: 'group'; type: NodeType; key: string; level: 1 }
  | {
      kind: 'element';
      id: string;
      type: NodeType;
      key: string;
      level: number;
      /** The row ← moves to: the parent element's or the group's. */
      parentKey: string;
      /** Undefined for a leaf; else whether its children show. */
      expanded: boolean | undefined;
    };

/** Indent levels stop growing here: deeper rows keep this indent. */
const maxIndentLevel = 8;

const groupKey = (type: NodeType) => `g:${type}`;
const elementKey = (id: string) => `e:${id}`;

/** The name with the search match marked. Text only: names are never rendered as HTML. */
function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  const range = matchRange(text, query);
  if (!range) return text;
  return (
    <>
      {text.slice(0, range[0])}
      <mark>{text.slice(range[0], range[1])}</mark>
      {text.slice(range[1])}
    </>
  );
}

interface ElementTreeProps {
  modelId: string;
  graph: ModelGraph;
  /** The selected element (shown in the details panel): its row is marked and kept in view. */
  selectedId: string | undefined;
  /** A double click or Enter on a row. */
  onFocusElement: (id: string) => void;
  /** A single click or Space on a row. */
  onSelectElement?: (id: string) => void;
  /** Shift+Enter on a row (dragging a row onto the canvas does the same). */
  onAddToCanvas?: (id: string) => void;
  /** Shown above the search row: + New element in Modelling, or why editing is off. */
  top?: ReactNode;
  /** Shown instead of the search and the tree when the model has no elements. */
  emptyText?: string;
  /** The search and filters, shared with the catalog; the list keeps its own without them. */
  search?: ElementSearch;
  /** The catalog shows the search row above the table: the list leaves it out. */
  searchElsewhere?: boolean;
}

/**
 * Every element of the model grouped by node type (metamodel order), with search. An element
 * contained by one of the same type is listed under it (`elementListTree`). An ARIA tree with one
 * Tab stop; arrow keys, Home/End, Enter, `*` and type-ahead as in the README.
 */
export function ElementTree({
  modelId,
  graph,
  selectedId: focusId,
  onFocusElement,
  onSelectElement,
  onAddToCanvas,
  top,
  emptyText = 'No elements yet.',
  search: shared,
  searchElsewhere = false,
}: ElementTreeProps) {
  const own = useElementSearch(modelId);
  const { query, setQuery, filters, setFilters } = shared ?? own;
  const [open, setOpen] = useState<Set<NodeType>>(() => {
    const saved = openByModel.get(modelId);
    if (saved) return new Set(saved);
    const focusType = focusId ? graph.elements.get(focusId)?.type : undefined;
    return new Set(focusType ? [focusType] : []);
  });
  // The path to the selected element starts open.
  const [openElements, setOpenElements] = useState<Set<string>>(
    () =>
      new Set([
        ...(openElementsByModel.get(modelId) ?? []),
        ...(focusId === undefined ? [] : listAncestorsOf(graph, focusId)),
      ]),
  );
  const [cursor, setCursor] = useState<string | undefined>(
    focusId ? elementKey(focusId) : undefined,
  );
  const moveFocus = useRef(false);
  const focusType = focusId === undefined ? undefined : graph.elements.get(focusId)?.type;
  const focusPath = useMemo(
    () => (focusId === undefined ? [] : listAncestorsOf(graph, focusId)),
    [graph, focusId],
  );
  // The selected element, its type and its parents: a type or Contains change (Modelling) moves
  // its row, and the new path opens.
  const focusKey = `${focusId ?? ''}|${focusType ?? ''}|${focusPath.join('\u0000')}`;
  const [seenFocus, setSeenFocus] = useState(focusKey);
  const search = useRef<HTMLInputElement>(null);
  const tree = useRef<HTMLUListElement>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const fields = useMemo(() => filterFields(graph), [graph]);

  useEffect(() => {
    openByModel.set(modelId, open);
  }, [modelId, open]);

  useEffect(() => {
    openElementsByModel.set(modelId, openElements);
  }, [modelId, openElements]);

  const filtering = activeFilterCount(filters) > 0;
  // While narrowed or filtering, every group with matches is open and counts its matches.
  const narrowed = query.trim() !== '' || filtering;
  const matches = useMemo(() => findElements(graph, { query, filters }), [graph, query, filters]);
  // Not narrowed: every element, and the counts are the group sizes.
  const groups = useMemo(
    () => (narrowed ? elementListTree(graph, matches) : elementListTree(graph)),
    [graph, matches, narrowed],
  );
  const isOpen = (type: NodeType) => narrowed || open.has(type);
  // While narrowed, every row with children is on a match's path: open, and it can't be closed.
  const isElementOpen = (id: string) => narrowed || openElements.has(id);

  const rows: Row[] = useMemo(() => {
    const visible: Row[] = [];
    const addRows = (list: readonly ElementListRow[], level: number, parentKey: string) => {
      for (const { element, children } of list) {
        const expanded =
          children.length === 0 ? undefined : narrowed || openElements.has(element.id);
        const key = elementKey(element.id);
        visible.push({
          kind: 'element',
          id: element.id,
          type: element.type,
          key,
          level,
          parentKey,
          expanded,
        });
        if (expanded) addRows(children, level + 1, key);
      }
    };
    for (const group of groups) {
      const key = groupKey(group.type);
      visible.push({ kind: 'group', type: group.type, key, level: 1 });
      if (narrowed || open.has(group.type)) addRows(group.rows, 2, key);
    }
    return visible;
  }, [groups, open, openElements, narrowed]);
  const rowIndex = useMemo(() => new Map(rows.map((row, index) => [row.key, index])), [rows]);
  const currentKey = cursor !== undefined && rowIndex.has(cursor) ? cursor : rows[0]?.key;

  // A focus change from elsewhere (canvas, details, URL) opens its group and every row it is
  // listed under, and moves the cursor to its row. Adjusted while rendering, so the row is there
  // in the same render. Nothing closes by itself.
  if (seenFocus !== focusKey) {
    setSeenFocus(focusKey);
    const type = focusType;
    if (focusId !== undefined && type) {
      if (!open.has(type)) setOpen(new Set([...open, type]));
      if (focusPath.some((id) => !openElements.has(id))) {
        setOpenElements(new Set([...openElements, ...focusPath]));
      }
      setCursor(elementKey(focusId));
    }
  }

  // ...and scrolls it into view.
  useEffect(() => {
    if (!focusId) return;
    // Scroll the tree's own box, not scrollIntoView(): in Chromium that also moves the Tab
    // starting point into the tree, so a deep link's first Tab would skip "Skip to canvas".
    const frame = requestAnimationFrame(() => {
      const box = tree.current;
      const row = box?.querySelector<HTMLElement>('[aria-selected="true"] > .trow');
      if (!box || !row) return;
      const rowBox = row.getBoundingClientRect();
      const treeBox = box.getBoundingClientRect();
      if (rowBox.top < treeBox.top) box.scrollTop -= treeBox.top - rowBox.top;
      else if (rowBox.bottom > treeBox.bottom) box.scrollTop += rowBox.bottom - treeBox.bottom;
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [focusId, focusKey]);

  // Move keyboard focus to the cursor row after a key press re-rendered the tree.
  useEffect(() => {
    if (!moveFocus.current || currentKey === undefined) return;
    moveFocus.current = false;
    const index = rowIndex.get(currentKey);
    if (index !== undefined) document.getElementById(`tree-row-${index}`)?.focus();
  }, [currentKey, rowIndex]);

  const go = (key: string | undefined) => {
    if (key === undefined) return;
    moveFocus.current = true;
    setCursor(key);
    // Already there (e.g. Home on the first row): focus it now.
    if (key === currentKey) {
      moveFocus.current = false;
      const index = rowIndex.get(key);
      if (index !== undefined) document.getElementById(`tree-row-${index}`)?.focus();
    }
  };

  const toggle = (type: NodeType, to?: boolean) => {
    setOpen((current) => {
      const next = new Set(current);
      if (to ?? !next.has(type)) next.add(type);
      else next.delete(type);
      return next;
    });
  };

  const toggleElement = (id: string, to?: boolean) => {
    setOpenElements((current) => {
      const next = new Set(current);
      if (to ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = currentKey === undefined ? -1 : (rowIndex.get(currentKey) ?? -1);
    const row = rows[index];
    if (!row) return;
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case 'ArrowDown':
        handled();
        go(rows[Math.min(index + 1, rows.length - 1)]?.key);
        return;
      case 'ArrowUp':
        handled();
        go(rows[Math.max(index - 1, 0)]?.key);
        return;
      case 'Home':
        handled();
        go(rows[0]?.key);
        return;
      case 'End':
        handled();
        go(rows[rows.length - 1]?.key);
        return;
      case 'ArrowRight': {
        handled();
        const next = rows[index + 1];
        const firstChild = next !== undefined && next.level > row.level ? next.key : row.key;
        if (row.kind === 'group') {
          if (isOpen(row.type)) go(firstChild);
          else toggle(row.type, true);
        } else if (row.expanded === true) {
          go(firstChild);
        } else if (row.expanded === false) {
          toggleElement(row.id, true);
        }
        return;
      }
      case 'ArrowLeft':
        handled();
        if (row.kind === 'group') {
          if (!narrowed) toggle(row.type, false);
        } else if (row.expanded === true && !narrowed) {
          toggleElement(row.id, false);
        } else {
          go(row.parentKey);
        }
        return;
      case 'Enter':
        handled();
        if (row.kind === 'element') {
          if (event.shiftKey) onAddToCanvas?.(row.id);
          else onFocusElement(row.id);
        } else if (!narrowed) toggle(row.type);
        return;
      case ' ':
        if (row.kind !== 'element' || !onSelectElement) break;
        handled();
        onSelectElement(row.id);
        return;
      case '*':
        handled();
        setOpen(new Set(nodeTypes));
        return;
    }
    // Type-ahead: the next row whose name starts with the letter.
    if (
      event.key.length === 1 &&
      /\S/.test(event.key) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const letter = event.key.toLowerCase();
      const nameOf = (r: Row) =>
        r.kind === 'group' ? r.type : (graph.elements.get(r.id)?.name ?? '');
      for (let step = 1; step <= rows.length; step++) {
        const candidate = rows[(index + step) % rows.length];
        if (candidate && nameOf(candidate).toLowerCase().startsWith(letter)) {
          handled();
          go(candidate.key);
          return;
        }
      }
    }
  };

  const total = graph.elements.size;
  const resultText = narrowed
    ? `${formatNumber(matches.length)} of ${counted(total, 'element')} match`
    : counted(total, 'element');

  const clearFilters = () => {
    setFilters({});
    filterButton.current?.focus();
  };
  const clearSearch = () => {
    setQuery('');
    search.current?.focus();
  };
  const typed = query.trim();

  /** Element rows and, under each open one, its children (a nested group). */
  const elementRows = (list: readonly ElementListRow[], level: number): ReactNode =>
    list.map(({ element, children, context }) => {
      const key = elementKey(element.id);
      const selected = element.id === focusId;
      const expanded = children.length === 0 ? undefined : isElementOpen(element.id);
      const name = element.name || '(unnamed)';
      const indent = { '--indent': Math.min(level, maxIndentLevel) - 2 } as CSSProperties;
      return (
        <li
          key={element.id}
          id={`tree-row-${rowIndex.get(key) ?? 0}`}
          role="treeitem"
          aria-level={level}
          aria-selected={selected}
          aria-expanded={expanded}
          aria-label={context ? `${name}, not a match` : name}
          tabIndex={currentKey === key ? 0 : -1}
          onFocus={(event) => {
            event.stopPropagation();
            setCursor(key);
          }}
        >
          <div
            className={`trow telem${context ? ' is-context' : ''}`}
            style={indent}
            title={element.name}
            draggable={onAddToCanvas !== undefined}
            onDragStart={(event) => {
              event.dataTransfer.setData(elementDragType, element.id);
              event.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={(event) => {
              setCursor(key);
              // A click selects; the second click of a double click focuses.
              if (event.detail >= 2 || !onSelectElement) onFocusElement(element.id);
              else onSelectElement(element.id);
            }}
          >
            <span
              className="tchev"
              data-testid={expanded === undefined ? undefined : 'tree-chevron'}
              onClick={(event) => {
                if (expanded === undefined) return;
                // Opens or closes only: never selects or focuses the element.
                event.stopPropagation();
                setCursor(key);
                if (!narrowed) toggleElement(element.id);
              }}
            >
              {expanded !== undefined && (
                <Icon name={expanded ? 'chev-down' : 'chev-right'} size="sm" />
              )}
            </span>
            <span className="label">
              {!element.name ? (
                <i>(unnamed)</i>
              ) : context ? (
                element.name
              ) : (
                <Highlighted text={element.name} query={query} />
              )}
            </span>
          </div>
          {expanded === true && <ul role="group">{elementRows(children, level + 1)}</ul>}
        </li>
      );
    });

  if (total === 0) {
    return (
      <>
        {top}
        <p className="tree-empty">{emptyText}</p>
      </>
    );
  }

  return (
    <>
      {top}
      {!searchElsewhere && (
        <SearchControls
          graph={graph}
          fields={fields}
          search={{ query, setQuery, filters, setFilters }}
          inputRef={search}
          filterButtonRef={filterButton}
        />
      )}
      {/* One announcement, not two: the catalog's counts line is the live one while it shows. */}
      <div className="result-count" aria-live={searchElsewhere ? undefined : 'polite'}>
        {resultText}
      </div>
      {narrowed && matches.length === 0 ? (
        <p className="tree-empty">
          {!filtering ? (
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
          )}
        </p>
      ) : (
        <ul
          className="tree"
          role="tree"
          aria-label="Elements by type"
          ref={tree}
          onKeyDown={onKeyDown}
          // The list keeps at least 4 rows (or all of them) when the panel's space runs short.
          style={{ '--tree-rows': rows.length } as CSSProperties}
        >
          {groups.map(({ type, rows: groupRows, matchCount: count }) => {
            const groupIndex = rowIndex.get(groupKey(type)) ?? 0;
            return (
              <li
                key={type}
                id={`tree-row-${groupIndex}`}
                role="treeitem"
                aria-level={1}
                aria-expanded={isOpen(type)}
                aria-label={`${type}, ${counted(count, 'element')}`}
                tabIndex={currentKey === groupKey(type) ? 0 : -1}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) setCursor(groupKey(type));
                }}
              >
                <div
                  className="trow tgroup"
                  onClick={() => {
                    setCursor(groupKey(type));
                    if (!narrowed) toggle(type);
                  }}
                >
                  <Icon name={isOpen(type) ? 'chev-down' : 'chev-right'} size="sm" />
                  <TypeMark type={type} />
                  <span className="label">{type}</span>{' '}
                  <span className="count">{formatNumber(count)}</span>
                </div>
                {isOpen(type) && <ul role="group">{elementRows(groupRows, 2)}</ul>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
