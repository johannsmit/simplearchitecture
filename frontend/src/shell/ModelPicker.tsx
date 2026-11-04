import { useState } from 'react';
import { Link, useMatch } from 'react-router';
import { Icon } from '../icons';
import { useModels } from '../models';
import { counted } from '../words';
import { modelPath, spaceHome, type ExplorerSpace } from '../viewing/paths';
import { Popover } from './Popover';

/** Above this many models the picker gets a filter field. */
const filterFrom = 8;

/**
 * Header model picker (Viewing and Modelling): every stored model, the open one marked. A model
 * picked opens in the space the user is in.
 */
export function ModelPicker({ space }: { space: ExplorerSpace }) {
  const { list } = useModels();
  const match = useMatch(`/${space}/models/:modelId/*`);
  const currentId = match?.params.modelId;
  const [filter, setFilter] = useState('');

  const models = list.status === 'ready' ? list.models : [];
  const current = models.find((model) => model.id === currentId);
  const name =
    current?.name ??
    (list.status === 'ready' && models.length === 0
      ? 'No models yet'
      : currentId !== undefined && list.status !== 'ready'
        ? 'Loading…'
        : 'Choose a model');
  const needle = filter.trim().toLowerCase();
  const shown =
    needle === '' ? models : models.filter((m) => m.name.toLowerCase().includes(needle));

  return (
    <Popover
      id="model"
      buttonClassName="picker-btn"
      buttonLabel={`Model: ${name}`}
      buttonContent={
        <>
          <Icon name="layers" />
          <span className="picker-text" aria-hidden="true">
            <small>Model</small> <span title={current?.name}>{name}</span>
          </span>
          <Icon name="chev-down" size="sm" />
        </>
      }
      popoverClassName="model-pop"
    >
      {(close) => (
        <>
          {models.length >= filterFrom && (
            <div className="search pop-search">
              <Icon name="search" />
              <input
                type="search"
                aria-label="Find a model"
                placeholder="Find a model…"
                value={filter}
                onChange={(event) => {
                  setFilter(event.target.value);
                }}
              />
            </div>
          )}
          {list.status === 'loading' && <p className="pop-note muted">Loading models…</p>}
          {list.status === 'error' && (
            <p className="pop-note muted">The models couldn&apos;t be loaded.</p>
          )}
          {shown.length > 0 && (
            <ul className="model-list" aria-label="Models">
              {shown.map((model) => {
                const isCurrent = model.id === currentId;
                return (
                  <li key={model.id}>
                    <Link
                      to={modelPath(model.id, space)}
                      aria-current={isCurrent ? 'page' : undefined}
                      onClick={close}
                    >
                      {isCurrent ? <Icon name="check" size="sm" /> : <span />}
                      <b>{model.name}</b>{' '}
                      <small>
                        {counted(model.nodeCount, 'element')} ·{' '}
                        {counted(model.edgeCount, 'relationship')}
                      </small>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {needle !== '' && shown.length === 0 && (
            <p className="pop-note muted">No model matches.</p>
          )}
          <div className="pop-sep" />
          <Link className="menu-item" to={spaceHome(space)} onClick={close}>
            <Icon name="layers" />
            All models
          </Link>
        </>
      )}
    </Popover>
  );
}
