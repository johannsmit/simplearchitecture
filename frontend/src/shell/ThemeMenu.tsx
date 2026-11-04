import { useState } from 'react';
import { Icon, type IconName } from '../icons';
import { applyTheme, currentTheme, themeChoices, type ThemeChoice } from '../theme';
import { Popover } from './Popover';

const names: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark' };
const icons: Record<ThemeChoice, IconName> = { light: 'sun', dark: 'moon' };

/** Theme button: Light (the default) or Dark. Applies at once and is remembered. */
export function ThemeMenu() {
  const [theme, setTheme] = useState<ThemeChoice>(currentTheme);
  const label = `Theme: ${names[theme]}`;

  return (
    <Popover
      id="theme"
      role="menu"
      buttonClassName="icon-btn"
      buttonLabel={label}
      buttonTitle={label}
      buttonContent={<Icon name={icons[theme]} />}
      popoverClassName="theme-pop"
    >
      {(close) =>
        themeChoices.map((choice) => (
          <button
            key={choice}
            type="button"
            className="menu-item"
            role="menuitemradio"
            aria-checked={choice === theme}
            onClick={() => {
              applyTheme(choice);
              setTheme(choice);
              close();
            }}
          >
            <Icon name={icons[choice]} />
            {names[choice]}
            <span className="tick">
              <Icon name="check" size="sm" />
            </span>
          </button>
        ))
      }
    </Popover>
  );
}
