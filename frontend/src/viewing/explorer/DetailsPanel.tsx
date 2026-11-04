import {
  customMetadata,
  elementArchitectureState,
  elementDescription,
  elementFunctions,
  hasStandardProperty,
  isIsoCountryCode,
  metadataText,
  relationshipGroups,
  standardProperties,
  standardPropertyRows,
  type ModelElement,
  type ModelGraph,
  type PropertyRow,
} from '@simplearchitecture/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../icons';
import { colourClass, StateBadge, TypeMark } from '../../metamodel-ui';

/** Descriptions longer than this many lines (or characters) start clamped. */
const clampLines = 8;
const clampChars = 600;
const functionsShown = 10;

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
  if (value === undefined || value === null || value === '') {
    return <span className="muted">Not set</span>;
  }
  const kind = standardProperties[row.key].value.kind;
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
          <TypeMark type={element.type} />
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
                      aria-label={`${group.heading} ${name}${stateText}, ${other.type}${relationship.label ? `, "${relationship.label}"` : ''}`}
                      disabled={self}
                      onClick={() => {
                        onFocusElement(other.id);
                      }}
                    >
                      <TypeMark type={other.type} />
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
                      {relationship.label && (
                        <>
                          {' '}
                          <span className="rlabel">&ldquo;{relationship.label}&rdquo;</span>
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

      {!edit && custom.length > 0 && (
        <section>
          <details className="meta">
            <summary>
              <Icon name="chev-right" size="sm" />
              Custom metadata <span className="count">{custom.length}</span>
            </summary>
            <dl className="props">
              {custom.map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>
                    <MetadataValue name={key} value={value} />
                  </dd>
                </div>
              ))}
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
