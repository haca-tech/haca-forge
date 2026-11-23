import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { installFileUrlRefresh } from './lib/fileUrls';

// Expired signed file URLs (images, videos, downloads) get one fresh URL from the API.
installFileUrlRefresh();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
