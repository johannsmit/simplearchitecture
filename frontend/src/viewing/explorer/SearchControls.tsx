import type { FilterField, ModelGraph } from '@simplearchitecture/shared';
import { useEffect, type ReactNode, type RefObject } from 'react';
import { Icon } from '../../icons';
import { FilterButton, FilterChips } from './ElementFilter';
import type { ElementSearch } from './search';

interface SearchControlsProps {
  graph: ModelGraph;
  fields: readonly FilterField[];
  search: ElementSearch;
  inputRef: RefObject<HTMLInputElement | null>;
  filterButtonRef: RefObject<HTMLButtonElement | null>;
  /** At the end of the search row (the catalog's counts line). */
  end?: ReactNode;
}

/**
 * The element search field, the Filter button and the filter chips. Above the element list, or
 * above the table while the catalog shows: moved, never both. `/` anywhere outside a
 * text field moves to the field while it is shown.
 */
export function SearchControls({
  graph,
  fields,
  search,
  inputRef,
  filterButtonRef,
  end,
}: SearchControlsProps) {
  const { query, setQuery, filters, setFilters } = search;

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [inputRef]);

  return (
    <>
      <div className="search-row">
        <div className="search">
          <Icon name="search" />
          <input
            ref={inputRef}
            type="search"
            aria-label="Search elements"
            placeholder="Search elements…"
            aria-keyshortcuts="/"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query !== '') {
                event.preventDefault();
                setQuery('');
              }
            }}
          />
          <kbd aria-hidden="true">/</kbd>
        </div>
        <FilterButton
          graph={graph}
          fields={fields}
          query={query}
          filters={filters}
          onChange={setFilters}
          buttonRef={filterButtonRef}
        />
        {end}
      </div>
      <FilterChips
        fields={fields}
        filters={filters}
        onChange={setFilters}
        buttonRef={filterButtonRef}
      />
    </>
  );
}
