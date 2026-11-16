import {
  relationshipStandardKeys,
  sortDefinitions,
  standardProperties,
  type RelationshipPropertyDefinition,
  type RelationshipPropertyUsage,
} from '@simplearchitecture/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listProperties, propertyUsage } from '../api';
import { Icon } from '../icons';
import { counted, formatNumber } from '../words';
import { AdminNav } from './AdminNav';
import { DeletePropertyDialog, PropertyDialog } from './PropertyDialog';

/**
 * Admin → Properties: the extra properties of a Relation, in every model. An Admin adds, edits and
 * deletes them; the server checks the same rules and is the one to refuse. Properties added from
 * the custom metadata in models (the upgrade, an import) carry "From models" until saved.
 */

type Load =
  | { status: 'loading' }
  | {
      status: 'ready';
      properties: RelationshipPropertyDefinition[];
      usage: Map<string, RelationshipPropertyUsage>;
    }
  | { status: 'error' };

type Open =
  | { kind: 'new' }
  | { kind: 'edit'; property: RelationshipPropertyDefinition }
  | { kind: 'delete'; property: RelationshipPropertyDefinition };

const fromModelsTitle = 'Added from the custom metadata in models. Check its name and kind.';

/** "48 in 3 models", or "None". */
function valuesText(usage: RelationshipPropertyUsage | undefined): string | undefined {
  const values = (usage?.relations ?? 0) + (usage?.contains ?? 0);
  if (values === 0) return undefined;
  return `${formatNumber(values)} in ${counted(usage?.models ?? 0, 'model')}`;
}

const kindLabel = (kind: string): string => (kind === 'choice' ? 'Choice' : 'Text');

export function PropertiesPage() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [open, setOpen] = useState<Open | null>(null);
  const [status, setStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const newButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  // The button that opened the dialog: + New property, or a row's pencil or trash.
  const returnTo = useRef<HTMLElement | null>(null);
  // Where focus goes once the dialog is gone: a modal dialog keeps the page behind it inert, so
  // nothing there can take focus while it is open.
  const focusAfterClose = useRef<HTMLElement | null>(null);
  // The property just saved in Edit: its pencil gets focus back if reading the list again redrew
  // its row (a new key, or a new place in the order).
  const savedKey = useRef<string | null>(null);

  const reload = useCallback((signal?: AbortSignal) => {
    Promise.all([listProperties(signal), propertyUsage(signal)])
      .then(([properties, usage]) => {
        setLoad({
          status: 'ready',
          properties: sortDefinitions(properties),
          usage: new Map(usage.map((entry) => [entry.key, entry])),
        });
      })
      .catch(() => {
        if (!signal?.aborted) setLoad({ status: 'error' });
      });
  }, []);

  useEffect(() => {
    document.title = 'Properties – Admin – SimpleArchitecture';
    const controller = new AbortController();
    reload(controller.signal);
    return () => {
      controller.abort();
    };
  }, [reload]);

  const properties = load.status === 'ready' ? load.properties : [];
  const usageOf = (key: string) => (load.status === 'ready' ? load.usage.get(key) : undefined);
  const tagged = properties.filter((property) => property.fromModels);

  useEffect(() => {
    if (open !== null || focusAfterClose.current === null) return;
    focusAfterClose.current.focus();
    focusAfterClose.current = null;
  }, [open]);

  useEffect(() => {
    const key = savedKey.current;
    if (load.status === 'loading' || key === null) return;
    savedKey.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body || !active.isConnected) {
      (editButtons.current.get(key) ?? heading.current)?.focus();
    }
  }, [load]);

  const close = (focusTo: HTMLElement | null = returnTo.current) => {
    focusAfterClose.current = focusTo;
    setOpen(null);
  };
  const gone = () => {
    close(heading.current);
    setStatus('Someone else deleted this property.');
    reload();
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
              Extra properties for relationships (Relation), in every model. They show after the
              standard properties on every Relation.
            </p>
          </div>
          <button
            ref={newButton}
            className="btn primary"
            type="button"
            onClick={() => {
              returnTo.current = newButton.current;
              setOpen({ kind: 'new' });
            }}
          >
            <Icon name="plus" size="sm" />
            New property
          </button>
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

        {tagged.length > 0 && (
          <p className="hint from-models-note">
            <Icon name="info" size="sm" />
            {tagged.length === 1
              ? '1 property was'
              : `${formatNumber(tagged.length)} properties were`}{' '}
            added from the custom metadata in models. Check their names and kinds: rename “
            {tagged[0]?.name}”, or make it a choice.
          </p>
        )}

        {load.status === 'ready' && properties.length === 0 && (
          <div className="table-card empty">
            <Icon name="layers" />
            <h2>No properties defined yet.</h2>
            <p>
              Add the extra properties relationships need, such as a data owner or a criticality.
              They show after the standard properties on every Relation.
            </p>
          </div>
        )}

        {properties.length > 0 && (
          <div className="table-card">
            <table className="models-table properties-table">
              <caption className="vh">Defined properties</caption>
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
                  const usage = usageOf(property.key);
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
                          usage === undefined
                            ? undefined
                            : `${formatNumber(usage.relations)} on Relations, ${formatNumber(usage.contains)} on Contains`
                        }
                      >
                        {values ?? <span className="muted">None</span>}
                      </td>
                      <td className="act">
                        <button
                          ref={(element) => {
                            if (element) editButtons.current.set(property.key, element);
                            else editButtons.current.delete(property.key);
                          }}
                          type="button"
                          className="icon-btn"
                          aria-label={`Edit ${property.name}`}
                          title={`Edit ${property.name}`}
                          onClick={(event) => {
                            returnTo.current = event.currentTarget;
                            setOpen({ kind: 'edit', property });
                          }}
                        >
                          <Icon name="pencil" />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger-hover"
                          aria-label={`Delete ${property.name}`}
                          title={`Delete ${property.name}`}
                          onClick={(event) => {
                            returnTo.current = event.currentTarget;
                            setOpen({ kind: 'delete', property });
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
            Standard properties of a Relation{' '}
            <span className="count">{relationshipStandardKeys.length}</span>
          </summary>
          <p className="hint">
            Set by the metamodel. Defined properties can&apos;t use these names or keys.
          </p>
          <div className="table-card">
            <table className="models-table">
              <caption className="vh">Standard properties of a Relation</caption>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Key</th>
                  <th scope="col">Kind</th>
                </tr>
              </thead>
              <tbody>
                {relationshipStandardKeys.map((key) => {
                  const standard = standardProperties[key as keyof typeof standardProperties];
                  const kind = standard.value.kind;
                  return (
                    <tr key={key}>
                      <td>{standard.label}</td>
                      <td>
                        <code className="muted">{key}</code>
                      </td>
                      <td>
                        {kind === 'choice'
                          ? 'Choice'
                          : kind === 'text-list'
                            ? 'List of texts'
                            : 'Text'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>

        {open !== null && open.kind !== 'delete' && (
          <PropertyDialog
            property={open.kind === 'edit' ? open.property : undefined}
            all={properties}
            usage={open.kind === 'edit' ? usageOf(open.property.key) : undefined}
            onCancel={() => {
              close();
            }}
            onGone={gone}
            onAnnounce={setStatus}
            onSaved={(saved, created) => {
              setStatus(`${created ? 'Created' : 'Saved'} the property ${saved.name}.`);
              if (!created) savedKey.current = saved.key;
              close();
              reload();
            }}
          />
        )}
        {open?.kind === 'delete' && (
          <DeletePropertyDialog
            property={open.property}
            usage={usageOf(open.property.key)}
            onCancel={() => {
              close();
            }}
            onGone={gone}
            onDeleted={(values, models) => {
              setStatus(
                `Deleted the property ${open.property.name} and ${counted(values, 'value')} from ${counted(models, 'model')}.`,
              );
              close(heading.current);
              reload();
            }}
          />
        )}
      </div>
    </main>
  );
}
