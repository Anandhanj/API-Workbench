import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { installErrorReporting } from './lib/error-reporting';
import './styles/globals.css';

// Capture uncaught renderer errors / rejections to the main-process debug log.
installErrorReporting();

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
