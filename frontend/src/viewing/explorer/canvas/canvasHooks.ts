import { useEffect, useRef, useState, type RefObject } from 'react';
import { whenFontsReady } from './cardSize';

/** Whether the last thing the person did was press the pointer (rather than a key). */
export function usePointerLast(): RefObject<boolean> {
  const pointerLast = useRef(false);
  useEffect(() => {
    const pointer = () => {
      pointerLast.current = true;
    };
    const key = () => {
      pointerLast.current = false;
    };
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
  return pointerLast;
}

/** Whether the fonts the cards are measured with have loaded. */
export function useFontsReady(): boolean {
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => {
    let live = true;
    void whenFontsReady().then(() => {
      if (live) setFontsReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return fontsReady;
}
