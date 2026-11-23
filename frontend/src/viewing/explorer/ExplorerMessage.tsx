import type { ReactNode } from 'react';
import { Icon } from '../../icons';

/** The whole explorer area's message, in place of the explorer (a model missing or not loaded). */
export function ExplorerMessage(props: { title: string; text: string; action: ReactNode }) {
  return (
    <main id="canvas" tabIndex={-1} className="page-scroll">
      <div className="empty explorer-message">
        <Icon name="layers" />
        <h1>{props.title}</h1>
        <p>{props.text}</p>
        {props.action}
      </div>
    </main>
  );
}
