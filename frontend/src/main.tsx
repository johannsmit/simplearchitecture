import '@fontsource-variable/inter';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { BrandingProvider } from './branding';
import '@xyflow/react/dist/base.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/shell.css';
import './styles/models.css';
import './styles/explorer.css';
import './styles/branding.css';
import './styles/agents.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element #root not found');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <BrandingProvider>
        <App />
      </BrandingProvider>
    </BrowserRouter>
  </StrictMode>,
);
