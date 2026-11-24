import { useRef, useState, type DragEvent, type RefObject } from 'react';
import { Icon } from '../../icons';
import { kilobytes, type PickedLogo } from './logo-file';

/** The words of one image field (the logo, the Dark theme logo or the app icon). */
export interface ImageFieldWords {
  /** The file input's name, e.g. "Logo file". */
  file: string;
  /** e.g. "Remove logo". */
  remove: string;
  /** The tile's text for what's saved, e.g. "Current logo". */
  current: string;
  /** The tile's text for a new file, e.g. "New logo, not saved yet". */
  picked: string;
}

interface ImageFieldProps {
  /** Ids: `<id>-hint`, `<id>-error`, `<id>-drop`. */
  id: string;
  /** The id of the heading that names the field (part of the drop area's name). */
  labelledBy: string;
  words: ImageFieldWords;
  accept: string;
  /** What's shown: the saved image, the new one, or null for none. */
  src: string | null;
  /** The new file, when there is one. */
  picked: PickedLogo | undefined;
  changed: boolean;
  error: string | undefined;
  busy: boolean;
  /** The tile's shape: the logo's wide tile, or the icon's small square one. */
  tile?: 'logo' | 'icon';
  /** Shown in the row when nothing is set (the icon's built-in one); otherwise no row. */
  none?: { src: string; caption: string } | undefined;
  dropRef: RefObject<HTMLButtonElement | null>;
  onFiles: (files: FileList | null) => void;
  onRemove: () => void;
}

const stop = (event: DragEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

/** One image: its tile with Remove, then the drop area that also opens the file chooser. */
export function ImageField({ dropRef, ...props }: ImageFieldProps) {
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { id, words, picked } = props;
  const tileClass = props.tile === 'icon' ? 'logo-tile icon-tile' : 'logo-tile';
  const describedBy = [`${id}-hint`, props.error === undefined ? '' : `${id}-error`]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {props.src !== null ? (
        <div className="logo-row">
          <div className={tileClass}>
            <img src={props.src} alt={picked ? words.picked : words.current} draggable={false} />
          </div>
          <div className="logo-text">
            <b>{picked ? picked.name : words.current}</b>
            {picked && (
              <small>
                {kilobytes(picked.size)} KB · {picked.width} × {picked.height} px
              </small>
            )}
            {props.changed && <span className="tag">Not saved yet</span>}
          </div>
          <button
            className="btn"
            type="button"
            aria-label={words.remove}
            disabled={props.busy}
            onClick={props.onRemove}
          >
            <Icon name="trash" size="sm" />
            Remove
          </button>
        </div>
      ) : (
        props.none && (
          <div className="logo-row">
            <div className={tileClass}>
              <img src={props.none.src} alt="" draggable={false} />
            </div>
            <div className="logo-text">
              <b>{props.none.caption}</b>
              {props.changed && <span className="tag">Not saved yet</span>}
            </div>
          </div>
        )
      )}
      <button
        ref={dropRef}
        type="button"
        className={`dropzone brand-drop${dragOver ? ' is-over' : ''}${
          props.error === undefined ? '' : ' is-invalid'
        }`}
        aria-labelledby={`${props.labelledBy} ${id}-drop`}
        aria-describedby={describedBy}
        disabled={props.busy}
        onClick={() => fileInput.current?.click()}
        onDragEnter={(event) => {
          stop(event);
          setDragOver(true);
        }}
        onDragOver={(event) => {
          stop(event);
          setDragOver(true);
        }}
        onDragLeave={() => {
          setDragOver(false);
        }}
        onDrop={(event) => {
          stop(event);
          setDragOver(false);
          props.onFiles(event.dataTransfer.files);
        }}
      >
        <Icon name="upload" />
        <span id={`${id}-drop`}>
          {props.src === null ? 'Drop an image here, or ' : 'Drop a new image here, or '}
          <u>choose a file</u>
        </span>
      </button>
      <input
        ref={fileInput}
        type="file"
        accept={props.accept}
        aria-label={words.file}
        hidden
        onChange={(event) => {
          props.onFiles(event.target.files);
          event.target.value = '';
        }}
      />
      {props.error !== undefined && (
        <p className="field-error brand-logo-error" id={`${id}-error`}>
          <Icon name="alert" size="sm" />
          <span>{props.error}</span>
        </p>
      )}
    </>
  );
}
