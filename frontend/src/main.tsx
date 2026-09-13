import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// The typeface ships in the bundle, not from a CDN: the field app has to render
// correctly with no network. Variable, so every weight the scale uses is one file.
import '@fontsource-variable/montserrat/wght.css'
// Tokens first: every stylesheet after this one reads from them.
import './tokens.css'
import './index.css'
import './field.css'
import './landing.css'
import './overview.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register PWA Service Worker for offline capability
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => console.log('PWA Service Worker registered:', reg.scope))
      .catch(err => console.error('Service Worker registration failed:', err));
  });
}
