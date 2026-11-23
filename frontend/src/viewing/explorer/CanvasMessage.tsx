import type { ReactNode } from 'react';
import { Icon, type IconName } from '../../icons';

/** The canvas area's message in place of a canvas: a view or element that isn't there. */
export function CanvasMessage(props: {
  icon: IconName;
  title: string;
  text: string;
  action: ReactNode;
}) {
  return (
    <div id="canvas" tabIndex={-1} className="canvas canvas-state">
      <div className="empty">
        <Icon name={props.icon} />
        <h2>{props.title}</h2>
        <p>{props.text}</p>
        {props.action}
      </div>
    </div>
  );
}
