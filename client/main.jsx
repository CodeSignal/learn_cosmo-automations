/*
 * Import order matters — the cascade is load-bearing.
 *
 * 1. design system foundations (colors before everything: they define the tokens)
 * 2. design system components
 * 3. React Flow's stylesheet
 * 4. our token bridge and app styles (base → shell → canvas → detail → help),
 *    so our overrides win
 */
import './design-system/colors/colors.css';
import './design-system/spacing/spacing.css';
import './design-system/typography/typography.css';

import './design-system/components/button/button.css';
import './design-system/components/boxes/boxes.css';
import './design-system/components/input/input.css';
import './design-system/components/tags/tags.css';
import './design-system/components/table/table.css';
import './design-system/components/icons/icons.css';
import './design-system/components/modal/modal.css';
import './design-system/components/dropdown/dropdown.css';
import './design-system/components/split-panel/split-panel.css';
// Stops the mouse wheel changing a focused number input — auto-initialises.
import './design-system/components/input/input.js';

import '@xyflow/react/dist/style.css';

import './theme/xyflow-theme.css';
import './theme/base.css';
import './theme/shell.css';
import './theme/canvas.css';
import './theme/detail.css';
import './theme/help.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
