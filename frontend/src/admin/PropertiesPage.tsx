import {
  elementStandardKeys,
  nodeTypeDefinitions,
  nodeTypes,
  relationshipStandardKeys,
  sortDefinitions,
  standardProperties,
  type PropertyList,
  type StandardPropertyKey,
} from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listProperties, propertyUsage } from '../api';
import { usePageTitle } from '../branding';
import { Icon } from '../icons';
import { counted, formatNumber } from '../words';
import { AdminNav } from './AdminNav';
import {
  DeletePropertyDialog,
  listWord,
  PropertyDialog,
  valueCount,
  type AnyDefinition,
  type AnyUsage,
} from './PropertyDialog';

/**
 * Admin → Properties: the extra properties of elements (every type) and of a Relation, in every
 * model, in two lists. An Admin adds, edits and deletes them; the server checks the same rules and
 * is the one to refuse. Properties added from the custom metadata in models (the upgrade, an
 * import) carry "From models" until saved.
 */

interface ListLoad {
  properties: AnyDefinition[];
  usage: Map<string, AnyUsage>;
}

type Load =
  | { status: 'loading' }
  | { status: 'ready'; lists: Record<PropertyList, ListLoad> }
  | { status: 'error' };

type Open =
  | { kind: 'new'; list: PropertyList }
  | { kind: 'edit'; list: PropertyList; property: AnyDefinition }
  | { kind: 'delete'; list: PropertyList; property: AnyDefinition };

const fromModelsTitle = 'Added from the custom metadata in models. Check its name and kind.';

/** "48 in 3 models", or undefined for none. */
function valuesText(usage: AnyUsage | undefined): string | undefined {
  const values = valueCount(usage);
  if (values === 0) return undefined;
  return `${formatNumber(values)} in ${counted(usage?.models ?? 0, 'model')}`;
}

const kindLabel = (kind: string): string =>
  kind === 'choice' ? 'Choice' : kind === 'reference' ? 'Reference' : 'Text';

const standardKindLabel = (key: StandardPropertyKey): string => {
  const kind = standardProperties[key].value.kind;
  return kind === 'choice'
    ? 'Choice'
    : kind === 'text-list'
      ? 'List of texts'
      : kind === 'country'
        ? 'Country code'
        : 'Text';
};

/** The element types that have a standard property: "Every type", or their names. */
function typesWith(key: StandardPropertyKey): string {
  const types = nodeTypes.filter((type) => nodeTypeDefinitions[type].properties.includes(key));
  return types.length === nodeTypes.length ? 'Every type' : types.join(', ');
}

/** What each list says: its heading, lead, empty state and standard properties. */
const listTexts: Record<
  PropertyList,
  {
    heading: string;
    lead: string;
    empty: string;
    emptyLead: string;
    standardSummary: string;
    standardLead: string;
  }
> = {
  element: {
    heading: 'Element properties',
    lead: 'On every element, of every type.',
    empty: 'No element properties defined yet.',
    emptyLead:
      'Add the extra properties elements need, such as a cost centre, a lifecycle stage or the elements one depends on. They show after the standard properties on every element.',
    standardSummary: 'Standard properties of an element',
    standardLead:
      "Set by the metamodel. Element properties can't use these names or keys, nor Name or Type.",
  },
  relationship: {
    heading: 'Relation properties',
    lead: 'On every relationship of the type Relation.',
    empty: 'No relation properties defined yet.',
    emptyLead:
      'Add the extra properties relationships need, such as a data owner or a criticality. They show after the standard properties on every Relation.',
    standardSummary: 'Standard properties of a Relation',
    standardLead: "Set by the metamodel. Defined properties can't use these names or keys.",
  },
};

const lists: readonly PropertyList[] = ['element', 'relationship'];

export function PropertiesPage() {
  usePageTitle('Properties – Admin');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [open, setOpen] = useState<Open | null>(null);
  const [status, setStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const sectionHeadings = useRef(new Map<PropertyList, HTMLHeadingElement>());
  const newButtons = useRef(new Map<PropertyList, HTMLButtonElement>());
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  // The button that opened the dialog: a section's New, or a row's pencil or trash.
  const returnTo = useRef<HTMLElement | null>(null);
  // Where focus goes once the dialog is gone: a modal dialog keeps the page behind it inert, so
  // nothing there can take focus while it is open.
  const focusAfterClose = useRef<HTMLElement | null>(null);
  // The property just saved in Edit (`list|key`): its pencil gets focus back if reading the
  // lists again redrew its row (a new key, or a new place in the order).
  const savedKey = useRef<{ list: PropertyList; key: string } | null>(null);

  const reload = useCallback((signal?: AbortSignal) => {
    Promise.all([listProperties(signal), propertyUsage(signal)])
      .then(([properties, usage]) => {
        setLoad({
          status: 'ready',
          lists: {
            element: {
              properties: sortDefinitions(properties.element),
              usage: new Map(usage.element.map((entry) => [entry.key, entry])),
            },
            relationship: {
              properties: sortDefinitions(properties.relationship),
              usage: new Map(usage.relationship.map((entry) => [entry.key, entry])),
            },
          },
        });
      })
      .catch(() => {
        if (!signal?.aborted) setLoad({ status: 'error' });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    reload(controller.signal);
    return () => {
      controller.abort();
    };
  }, [reload]);

  const propertiesOf = (list: PropertyList) =>
    load.status === 'ready' ? load.lists[list].properties : [];
  const usageOf = (list: PropertyList, key: string) =>
    load.status === 'ready' ? load.lists[list].usage.get(key) : undefined;
  const editKey = (list: PropertyList, key: string) => `${list}|${key}`;

  useEffect(() => {
    if (open !== null || focusAfterClose.current === null) return;
    focusAfterClose.current.focus();
    focusAfterClose.current = null;
  }, [open]);

  useEffect(() => {
    const saved = savedKey.current;
    if (load.status === 'loading' || saved === null) return;
    savedKey.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) {
      (
        editButtons.current.get(editKey(saved.list, saved.key)) ??
        sectionHeadings.current.get(saved.list) ??
        heading.current
      )?.focus();
    }
  }, [load]);

  const close = (focusTo: HTMLElement | null = returnTo.current) => {
    focusAfterClose.current = focusTo;
    setOpen(null);
  };
  const gone = (list: PropertyList) => {
    close(sectionHeadings.current.get(list) ?? heading.current);
    setStatus('Someone else deleted this property.');
    reload();
  };

  const section = (list: PropertyList) => {
    const texts = listTexts[list];
    const properties = propertiesOf(list);
    const tagged = properties.filter((property) => property.fromModels);
    const word = listWord(list);
    const headingId = `properties-${list}`;
    const standardKeys: readonly string[] =
      list === 'element' ? elementStandardKeys : relationshipStandardKeys;
    return (
      <section key={list} className="properties-section" aria-labelledby={headingId}>
        <div className="section-head">
          <div>
            <h2
              id={headingId}
              tabIndex={-1}
              ref={(element) => {
                if (element) sectionHeadings.current.set(list, element);
                else sectionHeadings.current.delete(list);
              }}
            >
              {texts.heading}
            </h2>
            <p>{texts.lead}</p>
          </div>
          <button
            ref={(element) => {
              if (element) newButtons.current.set(list, element);
              else newButtons.current.delete(list);
            }}
            className="btn primary"
            type="button"
            onClick={(event) => {
              returnTo.current = event.currentTarget;
              setOpen({ kind: 'new', list });
            }}
          >
            <Icon name="plus" size="sm" />
            New {word}
          </button>
        </div>

        {tagged.length > 0 && (
          <p className="hint from-models-note">
            <Icon name="info" size="sm" />
            {tagged.length === 1
              ? `1 ${word} was`
              : `${formatNumber(tagged.length)} ${word.replace('property', 'properties')} were`}{' '}
            added from the custom metadata in models. Check{' '}
            {tagged.length === 1 ? 'its name and kind' : 'their names and kinds'}: rename “
            {tagged[0]?.name}”, or make it a choice.
          </p>
        )}

        {load.status === 'ready' && properties.length === 0 && (
          <div className="table-card empty">
            <Icon name="layers" />
            <h3>{texts.empty}</h3>
            <p>{texts.emptyLead}</p>
          </div>
        )}

        {properties.length > 0 && (
          <div className="table-card">
            <table className="models-table properties-table">
              <caption className="vh">{texts.heading}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Kind</th>
                  <th scope="col" className="n">
                    Values
                  </th>
                  <th scope="col">
                    <span className="vh">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {properties.map((property) => {
                  const usage = usageOf(list, property.key);
                  const values = valuesText(usage);
                  const options = property.options ?? [];
                  return (
                    <tr key={property.key}>
                      <td className="name-cell">
                        <span className="cut" title={property.name}>
                          {property.name}
                        </span>
                        {property.fromModels && (
                          <span className="tag" title={fromModelsTitle}>
                            From models<span className="vh">. {fromModelsTitle}</span>
                          </span>
                        )}
                      </td>
                      <td>
                        <code className="muted">{property.key}</code>
                      </td>
                      <td>
                        {property.kind === 'choice' ? (
                          <span title={options.join(', ')}>
                            Choice · {counted(options.length, 'option')}
                          </span>
                        ) : (
                          kindLabel(property.kind)
                        )}
                      </td>
                      <td
                        className="n"
                        title={
                          usage !== undefined && 'relations' in usage
                            ? `${formatNumber(usage.relations)} on Relations, ${formatNumber(usage.contains)} on Contains`
                            : undefined
                        }
                      >
                        {values ?? <span className="muted">None</span>}
                      </td>
                      <td className="act">
                        <button
                          ref={(element) => {
                            const at = editKey(list, property.key);
                            if (element) editButtons.current.set(at, element);
                            else editButtons.current.delete(at);
                          }}
                          type="button"
                          className="icon-btn"
                          aria-label={`Edit ${word} ${property.name}`}
                          title={`Edit ${property.name}`}
                          onClick={(event) => {
                            returnTo.current = event.currentTarget;
                            setOpen({ kind: 'edit', list, property });
                          }}
                        >
                          <Icon name="pencil" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger-hover"
                          aria-label={`Delete ${word} ${property.name}`}
                          title={`Delete ${property.name}`}
                          onClick={(event) => {
                            returnTo.current = event.currentTarget;
                            setOpen({ kind: 'delete', list, property });
                          }}
                        >
                          <Icon name="trash" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <details className="standard-properties">
          <summary>
            {texts.standardSummary} <span className="count">{standardKeys.length}</span>
          </summary>
          <p className="hint">{texts.standardLead}</p>
          <div className="table-card">
            <table className="models-table">
              <caption className="vh">{texts.standardSummary}</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Kind</th>
                  {list === 'element' && <th scope="col">Types</th>}
                </tr>
              </thead>
              <tbody>
                {standardKeys.map((key) => {
                  const standardKey = key as StandardPropertyKey;
                  return (
                    <tr key={key}>
                      <td>{standardProperties[standardKey].label}</td>
                      <td>
                        <code className="muted">{key}</code>
                      </td>
                      <td>{standardKindLabel(standardKey)}</td>
                      {list === 'element' && <td>{typesWith(standardKey)}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      </section>
    );
  };

  return (
    <main id="content" tabIndex={-1} className="page-scroll">
      <div className="page properties-page">
        <AdminNav />
        <div className="page-head">
          <div>
            <h1 ref={heading} tabIndex={-1}>
              Properties
            </h1>
            <p>
              Extra properties an Admin defines, in every model. They show after the standard
              properties.
            </p>
          </div>
        </div>

        <p className="vh" role="status">
          {status}
        </p>

        {load.status === 'loading' && (
          <p className="app-message" role="status">
            Loading…
          </p>
        )}

        {load.status === 'error' && (
          <div className="table-card load-error" role="alert">
            <Icon name="alert" />
            <p>
              <b>Couldn&apos;t load the properties.</b>
            </p>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setLoad({ status: 'loading' });
                reload();
              }}
            >
              Try again
            </button>
          </div>
        )}

        {load.status === 'ready' && lists.map((list) => section(list))}

        {open !== null && open.kind !== 'delete' && (
          <PropertyDialog
            list={open.list}
            property={open.kind === 'edit' ? open.property : undefined}
            all={propertiesOf(open.list)}
            usage={open.kind === 'edit' ? usageOf(open.list, open.property.key) : undefined}
            onCancel={() => {
              close();
            }}
            onGone={() => {
              gone(open.list);
            }}
            onAnnounce={setStatus}
            onSaved={(saved, created) => {
              setStatus(
                `${created ? 'Created' : 'Saved'} the ${listWord(open.list)} ${saved.name}.`,
              );
              if (!created) savedKey.current = { list: open.list, key: saved.key };
              close(created ? (newButtons.current.get(open.list) ?? null) : returnTo.current);
              reload();
            }}
          />
        )}
        {open?.kind === 'delete' && (
          <DeletePropertyDialog
            list={open.list}
            property={open.property}
            usage={usageOf(open.list, open.property.key)}
            onCancel={() => {
              close();
            }}
            onGone={() => {
              gone(open.list);
            }}
            onDeleted={(values, models) => {
              setStatus(
                `Deleted the ${listWord(open.list)} ${open.property.name} and ${counted(values, 'value')} from ${counted(models, 'model')}.`,
              );
              close(sectionHeadings.current.get(open.list) ?? heading.current);
              reload();
            }}
          />
        )}
      </div>
    </main>
  );
}
