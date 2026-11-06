import {
  canBeTwoWay,
  displayLabel,
  hasStandardEdgeProperty,
  relationTextProperties,
  standardProperties,
  type ModelGraph,
  type ModelRelationship,
} from '@simplearchitecture/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Icon } from '../../icons';
import { EdgeSample, relationshipTypeLine, StateBadge, TypeMark } from '../../metamodel-ui';
import { nameOf, relationshipSentence } from '../../modelling/relationships';
import { Description, MetadataValue, PropertyValue } from './DetailsPanel';

/** Metadata shown in its own row above, not under "Custom metadata". */
const ownRows = new Set(['description', 'architectureState']);

interface RelationshipDetailsProps {
  graph: ModelGraph;
  relationship: ModelRelationship;
  /** The element the panel goes back to. */
  backId: string;
  onBack: () => void;
  onFocusElement: (id: string) => void;
  /** Modellers with editing available: where "Open in Modelling" goes. */
  openInModelling?: { to: string; state: unknown } | undefined;
  focusHeading: boolean;
  onHeadingFocused: () => void;
}

/**
 * A relationship in the details panel, read-only (Viewing, and Modelling without a database):
 * the form's layout without its inputs.
 */
export function RelationshipDetails(props: RelationshipDetailsProps) {
  const { graph, relationship } = props;
  const heading = useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = useState('');
  const { focusHeading, onHeadingFocused } = props;
  useEffect(() => {
    if (!focusHeading) return;
    heading.current?.focus();
    onHeadingFocused();
  }, [focusHeading, onHeadingFocused]);

  const sentence = relationshipSentence(graph, relationship);
  const label = displayLabel(relationship, graph);
  const { metadata, architectureState: state } = relationship;
  const description = typeof metadata.description === 'string' ? metadata.description : '';
  // Identity, Identity Context and Data on a Relation; elsewhere such keys stay custom metadata.
  const texts = relationTextProperties.filter((key) =>
    hasStandardEdgeProperty(key, relationship.type),
  );
  const other = Object.entries(metadata)
    .filter(([key]) => !ownRows.has(key) && !(texts as readonly string[]).includes(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  // A two-way relationship has no from and to: its ends are only in the order stored.
  const twoWay = relationship.twoWay === true;
  const ends = [
    [twoWay ? 'Between' : 'From', graph.elements.get(relationship.source)],
    [twoWay ? 'And' : 'To', graph.elements.get(relationship.target)],
  ] as const;

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        props.onBack();
      }}
    >
      <div className="d-head rel-head">
        <div className="rel-top">
          <button
            type="button"
            className="linkbtn"
            aria-label={`Back to ${nameOf(graph, props.backId)}`}
            onClick={props.onBack}
          >
            <Icon name="back" size="sm" />
            {nameOf(graph, props.backId)}
          </button>
          {props.openInModelling && (
            <Link className="btn" to={props.openInModelling.to} state={props.openInModelling.state}>
              <Icon name="pencil" size="sm" />
              Open in Modelling
            </Link>
          )}
        </div>
        <div className="d-type">
          <EdgeSample type={relationship.type} twoWay={twoWay} />
          {relationshipTypeLine(relationship)}
        </div>
        <h2 ref={heading} tabIndex={-1}>
          {sentence}
        </h2>
      </div>

      <section aria-label="Ends">
        <h3>Ends</h3>
        <ul className="rel-ends-list">
          {ends.map(([caption, end]) =>
            end ? (
              <li key={caption}>
                <button
                  type="button"
                  className="rel rel-endrow"
                  aria-label={`${caption}: ${end.name || '(unnamed)'}, ${end.type}. Go to element`}
                  onClick={() => {
                    props.onFocusElement(end.id);
                  }}
                >
                  <span className="rcap">{caption}</span>
                  <TypeMark type={end.type} />
                  <span className="rname">{end.name || '(unnamed)'}</span>
                  <span className="rtype">{end.type}</span>
                  <Icon name="chev-right" size="sm" />
                </button>
              </li>
            ) : null,
          )}
        </ul>
        {label !== undefined && (
          <p className="rel-label">
            <span className="muted">Label</span> “{label}”
            <span className="muted"> · from the import</span>
          </p>
        )}
      </section>

      <section>
        <h3>Properties</h3>
        <dl className="props">
          <div>
            <dt>Type</dt>
            <dd>
              <EdgeSample type={relationship.type} twoWay={twoWay} /> {relationship.type}
            </dd>
          </div>
          {canBeTwoWay(relationship.type) && (
            <div>
              <dt>Direction</dt>
              <dd>{twoWay ? '↔ Both ways' : '→ One way'}</dd>
            </div>
          )}
          <div>
            <dt>Architecture state</dt>
            <dd>
              <StateBadge state={state} />
            </dd>
          </div>
          {texts.map((key) => (
            <div key={key}>
              <dt>{standardProperties[key].label}</dt>
              <dd>
                <PropertyValue
                  row={{ key, label: standardProperties[key].label, value: metadata[key] }}
                />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {description ? (
        <Description key={relationship.id} text={description} />
      ) : (
        <section aria-label="Description">
          <p className="muted">No description.</p>
        </section>
      )}

      {other.length > 0 && (
        <section>
          <h3>
            Custom metadata <span className="count">{other.length}</span>
          </h3>
          <dl className="props">
            {other.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  <MetadataValue name={key} value={value} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="d-foot">
        <span>ID</span>
        <code>{relationship.id}</code>
        <button
          type="button"
          className="icon-btn"
          aria-label="Copy relationship ID"
          title="Copy relationship ID"
          onClick={() => {
            void navigator.clipboard.writeText(relationship.id).then(
              () => {
                setStatus('Relationship ID copied');
              },
              () => undefined,
            );
          }}
        >
          <Icon name="copy" size="sm" />
        </button>
        <p className="vh" role="status">
          {status}
        </p>
      </div>
    </div>
  );
}
