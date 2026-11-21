import {
  compareNames,
  customMetadata,
  displayLabel,
  elementArchitectureState,
  elementDescription,
  elementFunctions,
  hasStandardProperty,
  isIsoCountryCode,
  metadataText,
  referenceIds,
  referencedBy,
  relationshipGroups,
  standardProperties,
  standardPropertyRows,
  type ModelElement,
  type ModelGraph,
  type PropertyRow,
  type StandardPropertyDefinition,
} from '@simplearchitecture/shared';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';
import { colourClass, StateBadge, TypeMark } from '../../metamodel-ui';

/** Descriptions longer than this many lines (or characters) start clamped. */
const clampLines = 8;
const clampChars = 600;
const functionsShown = 10;
/** Reference links and Referenced by rows shown before "Show all N". */
const referencesShown = 10;

// Web addresses in a description, without trailing punctuation.
const urlPattern = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/;

/** Only http(s) addresses become links; anything else stays text. */
function safeHref(text: string): string | undefined {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Plain text with its line breaks kept; http(s) addresses become links that open in a new tab.
 * Model text is untrusted: it is never rendered as HTML or Markdown.
 */
export function LinkedText({ text }: { text: string }) {
  return (
    <>
      {text.split(urlPattern).map((part, index) => {
        // split() with a capture group puts the addresses at the odd positions.
        const href = index % 2 === 1 ? safeHref(part) : undefined;
        return href ? (
          <a key={index} href={href} target="_blank" rel="noopener noreferrer">
            {part}
          </a>
        ) : (
          part
        );
      })}
    </>
  );
}

export function Description({ text }: { text: string }) {
  const long = text.split('\n').length > clampLines || text.length > clampChars;
  const [expanded, setExpanded] = useState(false);
  return (
    <section aria-label="Description">
      <p className={`desc${long && !expanded ? ' clamped' : ''}`}>
        <LinkedText text={text} />
      </p>
      {long && (
        <button
          type="button"
          className="linkbtn"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  );
}

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' });
  } catch {
    return undefined;
  }
})();

/** A standard property's value as the details panel shows it (the catalog's cells reuse it). */
export function PropertyValue({ row }: { row: PropertyRow }): ReactNode {
  const { value } = row;
  const definition: StandardPropertyDefinition = standardProperties[row.key];
  const { readAs } = definition;
  if (value === undefined || value === null || value === '') {
    return readAs ?? <span className="muted">Not set</span>;
  }
  const rule = definition.value;
  if (
    readAs !== undefined &&
    rule.kind === 'choice' &&
    !(typeof value === 'string' && rule.options.includes(value))
  ) {
    // A value from before the property was standard (Kind): kept, marked, and read as `readAs`.
    const note = `not ${rule.options.join(' or ')}; read as ${readAs}`;
    return (
      <span className="not-iso" title={`${note.charAt(0).toUpperCase()}${note.slice(1)}`}>
        {metadataText(value)}
        <Icon name="alert" size="sm" />
        <span className="vh"> ({note})</span>
      </span>
    );
  }
  const kind = rule.kind;
  if (row.key === 'architectureState' && typeof value === 'string') {
    return value === 'Current' || value === 'Target' || value === 'Deprecate' ? (
      <StateBadge state={value} />
    ) : (
      value
    );
  }
  if (kind === 'country' && typeof value === 'string') {
    if (isIsoCountryCode(value)) {
      const name = regionNames?.of(value);
      return name && name !== value ? `${value} · ${name}` : value;
    }
    return (
      <span className="not-iso" title="Not an ISO 3166-1 alpha-2 code">
        {value} <Icon name="alert" size="sm" />
        <span className="vh"> (not an ISO 3166-1 alpha-2 code)</span>
      </span>
    );
  }
  return metadataText(value);
}

/** Structured values as JSON in a box that scrolls; focusable so the keyboard can scroll it. */
function JsonValue({ name, value }: { name: string; value: unknown }) {
  return (
    <pre className="json" tabIndex={0} role="group" aria-label={`${name} (JSON)`}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function MetadataValue({ name, value }: { name: string; value: unknown }): ReactNode {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return <JsonValue name={name} value={value} />;
  }
  if (Array.isArray(value) && value.some((entry) => typeof entry === 'object' && entry !== null)) {
    return <JsonValue name={name} value={value} />;
  }
  return <span className="pre-wrap">{metadataText(value)}</span>;
}

/** "Show all N" / "Show fewer" under a list cut at `referencesShown`. */
function ShowAll(props: { total: number; all: boolean; onToggle: () => void }) {
  if (props.total <= referencesShown) return null;
  return (
    <button type="button" className="linkbtn" aria-expanded={props.all} onClick={props.onToggle}>
      {props.all ? 'Show fewer' : `Show all ${props.total}`}
    </button>
  );
}

const elementName = (element: ModelElement): string => element.name.trim() || '(unnamed)';

/** A Reference field's elements as links, in their stored order; a click goes to the element. */
function ReferenceLinks(props: {
  name: string;
  ids: readonly string[];
  graph: ModelGraph;
  onFocusElement: (id: string) => void;
}) {
  const { ids, graph } = props;
  const [all, setAll] = useState(false);
  if (ids.length === 0) return <span className="muted">Not set</span>;
  return (
    <>
      <ul
        className="ref-links"
        aria-label={`${props.name}: ${ids.length} ${ids.length === 1 ? 'element' : 'elements'}`}
      >
        {(all ? ids : ids.slice(0, referencesShown)).map((id, index) => {
          const element = graph.elements.get(id);
          if (!element) {
            return (
              <li key={`${String(index)}:${id}`} className="ref-missing">
                <Icon name="alert" size="sm" />
                Element not found
              </li>
            );
          }
          const name = elementName(element);
          return (
            <li key={`${String(index)}:${id}`}>
              <button
                type="button"
                className="rel"
                aria-label={`${name}, ${element.type}. Go to element`}
                onClick={() => {
                  props.onFocusElement(id);
                }}
              >
                <TypeMark type={element.type} metadata={element.metadata} />
                <span className="rname">{name}</span> <span className="rtype">{element.type}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <ShowAll
        total={ids.length}
        all={all}
        onToggle={() => {
          setAll(!all);
        }}
      />
    </>
  );
}

/** The elements that refer to this one in a Reference field; left out when there are none. */
function ReferencedBy(props: {
  graph: ModelGraph;
  element: ModelElement;
  onFocusElement: (id: string) => void;
}) {
  const { graph, element } = props;
  const headingId = useId();
  const [all, setAll] = useState(false);
  // One row per referring element, by name, with the fields that hold this one.
  const rows = useMemo(() => {
    const byElement = new Map<string, { element: ModelElement; keys: string[] }>();
    for (const { element: from, key } of referencedBy(graph, element.id)) {
      const row = byElement.get(from.id);
      if (row) row.keys.push(key);
      else byElement.set(from.id, { element: from, keys: [key] });
    }
    return [...byElement.values()];
  }, [graph, element.id]);
  if (rows.length === 0) return null;
  return (
    <section className="referenced-by" aria-labelledby={headingId}>
      <h3 id={headingId}>
        Referenced by <span className="count">{rows.length}</span>
      </h3>
      <div className="rgroup">
        <ul>
          {(all ? rows : rows.slice(0, referencesShown)).map(({ element: from, keys }) => {
            const name = elementName(from);
            const fields = `in ${[...keys].sort(compareNames).join(', ')}`;
            return (
              <li key={from.id}>
                <button
                  type="button"
                  className="rel"
                  aria-label={`${name}, ${from.type}, ${fields}. Go to element`}
                  onClick={() => {
                    props.onFocusElement(from.id);
                  }}
                >
                  <TypeMark type={from.type} metadata={from.metadata} />
                  <span className="rname">{name}</span> <span className="rtype">{from.type}</span>{' '}
                  <span className="rlabel">{fields}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <ShowAll
        total={rows.length}
        all={all}
        onToggle={() => {
          setAll(!all);
        }}
      />
    </section>
  );
}

interface DetailsPanelProps {
  graph: ModelGraph;
  element: ModelElement;
  /** The element's deep link, for Copy link. */
  link: string;
  onFocusElement: (id: string) => void;
  /**
   * Put keyboard focus on the element's name when the panel opens: it was reached by following a
   * relationship here, and the panel the focus was in has been replaced.
   */
  focusHeading?: boolean;
  onHeadingFocused?: () => void;
  /**
   * Modelling with editing on: the head gets these actions (Delete, the Saved note) and the
   * form takes the place of Description, Properties, Functions and Custom metadata.
   */
  edit?: { headActions: ReactNode; form: ReactNode };
  /** An id for the name heading, so the form can put focus on it after a save. */
  headingId?: string;
  /** Editable Modelling: Add relationship and an Open button per row. */
  relationships?: RelationshipTools;
  /** After Copy link: Show on canvas while the catalog shows. */
  headExtra?: ReactNode;
  /** The "Used in views" section, after Relationships. */
  usedIn?: ReactNode;
}

export interface RelationshipTools {
  /** "+ Add relationship", at the end of the section's heading row. */
  action: ReactNode;
  /** The Add relationship box, when open. */
  box: ReactNode;
  onOpen: (relationshipId: string) => void;
  /** A row lit for a moment (just added). */
  highlightId?: string;
}

/** Everything about the focused element: properties, functions, relationships in words. */
export function DetailsPanel({
  graph,
  element,
  link,
  onFocusElement,
  focusHeading = false,
  onHeadingFocused,
  edit,
  headingId,
  relationships,
  headExtra,
  usedIn,
}: DetailsPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    onHeadingFocused?.();
  }, [focusHeading, onHeadingFocused]);
  const [status, setStatus] = useState('');
  const [allFunctions, setAllFunctions] = useState(false);
  useEffect(() => {
    if (status === '') return;
    const timer = setTimeout(() => {
      setStatus('');
    }, 2000);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  const description = elementDescription(element);
  const state = elementArchitectureState(element);
  const sourcing = hasStandardProperty(element.type, 'sourcing')
    ? element.metadata.sourcing
    : undefined;
  const properties = standardPropertyRows(element);
  const hasFunctions = hasStandardProperty(element.type, 'functions');
  const functions = elementFunctions(element);
  const groups = useMemo(() => relationshipGroups(graph, element.id), [graph, element]);
  const relationshipTotal = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const custom = customMetadata(element);
  const hasReferences = custom.some(([, value]) => (referenceIds(value)?.length ?? 0) > 0);

  const copy = (text: string, done: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setStatus(done);
      },
      () => {
        setStatus("Couldn't copy. Copy it from the address bar.");
      },
    );
  };

  return (
    <>
      <div className={`d-head ${colourClass(element.type)}${edit ? ' is-editing' : ''}`}>
        <div className="d-type">
          <TypeMark type={element.type} metadata={element.metadata} />
          {element.type}
          {edit && <span> · Editing</span>}
        </div>
        <h2 ref={heading} id={headingId} tabIndex={-1}>
          {element.name || <i>(unnamed)</i>}
        </h2>
        {!edit && (state !== undefined || typeof sourcing === 'string') && (
          <div className="tags">
            {state !== undefined && <StateBadge state={state} />}
            {typeof sourcing === 'string' && sourcing !== '' && (
              <span className="tag">{sourcing}</span>
            )}
          </div>
        )}
        <div className="d-actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              copy(new URL(link, window.location.origin).href, 'Link copied');
            }}
          >
            <Icon name="link" size="sm" />
            Copy link
          </button>
          {headExtra}
          {edit?.headActions}
        </div>
        <p className="vh" role="status">
          {status}
        </p>
      </div>

      {edit?.form}

      {edit ? null : description ? (
        <Description key={element.id} text={description} />
      ) : (
        <section aria-label="Description">
          <p className="muted">No description.</p>
        </section>
      )}

      {!edit && properties.length > 0 && (
        <section>
          <h3>Properties</h3>
          <dl className="props">
            {properties.map((row) => (
              <div key={row.key}>
                <dt>{row.label}</dt>
                <dd>
                  <PropertyValue row={row} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {!edit && hasFunctions && (
        <section>
          <h3>
            Functions <span className="count">{functions.length}</span>
          </h3>
          {functions.length === 0 ? (
            <p className="muted">No functions.</p>
          ) : (
            <>
              <ul className="fn-list">
                {(allFunctions ? functions : functions.slice(0, functionsShown)).map(
                  (name, index) => (
                    <li key={index}>{name}</li>
                  ),
                )}
              </ul>
              {functions.length > functionsShown && (
                <button
                  type="button"
                  className="linkbtn"
                  aria-expanded={allFunctions}
                  onClick={() => {
                    setAllFunctions(!allFunctions);
                  }}
                >
                  {allFunctions ? 'Show fewer' : `Show all ${functions.length}`}
                </button>
              )}
            </>
          )}
        </section>
      )}

      <section>
        <div className={relationships ? 'rel-h3row' : undefined}>
          <h3>
            Relationships <span className="count">{relationshipTotal}</span>
          </h3>
          {relationships?.action}
        </div>
        {relationships?.box}
        {groups.length === 0 && (
          <p className="muted">No relationships. This element stands alone.</p>
        )}
        {groups.map((group) => (
          <div className="rgroup" key={group.heading}>
            <h4>
              {group.heading} <span className="count">{group.rows.length}</span>
            </h4>
            <ul>
              {group.rows.map(({ relationship, other, self }, index) => {
                const name = self ? '(this element)' : other.name || '(unnamed)';
                const state = relationship.architectureState;
                const stateText = state === 'Current' ? '' : `, ${state}`;
                const label = displayLabel(relationship, graph);
                return (
                  <li
                    key={`${relationship.id}-${index}`}
                    className={
                      relationships
                        ? `has-open${relationships.highlightId === relationship.id ? ' is-new' : ''}`
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="rel"
                      aria-label={`${group.heading} ${name}${stateText}, ${other.type}${label ? `, "${label}"` : ''}`}
                      disabled={self}
                      onClick={() => {
                        onFocusElement(other.id);
                      }}
                    >
                      <TypeMark type={other.type} metadata={other.metadata} />
                      <span className="rmain">
                        {group.direction === 'both' && (
                          <span className="rboth" aria-hidden="true" title="Both ways">
                            ↔{' '}
                          </span>
                        )}
                        <span className="rname">{name}</span>
                        {state !== 'Current' && (
                          <>
                            {' '}
                            <StateBadge state={state} />
                          </>
                        )}
                      </span>{' '}
                      <span className="rtype">{other.type}</span>
                      {label && (
                        <>
                          {' '}
                          <span className="rlabel">&ldquo;{label}&rdquo;</span>
                        </>
                      )}
                    </button>
                    {relationships && (
                      <button
                        type="button"
                        className="icon-btn rel-open"
                        aria-label={`Open relationship: ${group.heading} ${name}`}
                        title="Open relationship"
                        onClick={() => {
                          relationships.onOpen(relationship.id);
                        }}
                      >
                        <Icon name="chev-right" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <ReferencedBy
        // Its own key: Description, a sibling, is keyed by the element's id.
        key={`referenced-by:${element.id}`}
        graph={graph}
        element={element}
        onFocusElement={onFocusElement}
      />

      {usedIn}

      {!edit && custom.length > 0 && (
        <section>
          <details
            className="meta"
            key={element.id}
            // Open from the start when it holds references to show (the person can close it).
            open={hasReferences || undefined}
          >
            <summary>
              <Icon name="chev-right" size="sm" />
              Custom metadata <span className="count">{custom.length}</span>
            </summary>
            <dl className="props">
              {custom.map(([key, value]) => {
                const ids = referenceIds(value);
                return (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      {ids !== undefined ? (
                        <ReferenceLinks
                          name={key}
                          ids={ids}
                          graph={graph}
                          onFocusElement={onFocusElement}
                        />
                      ) : (
                        <MetadataValue name={key} value={value} />
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </details>
        </section>
      )}

      <div className="d-foot">
        <span>ID</span>
        <code>{element.id}</code>
        <button
          type="button"
          className="icon-btn"
          aria-label="Copy element ID"
          title="Copy element ID"
          onClick={() => {
            copy(element.id, 'Element ID copied');
          }}
        >
          <Icon name="copy" size="sm" />
        </button>
      </div>
    </>
  );
}
