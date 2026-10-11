import { render } from 'preact';
import { App } from './app';
import { SettingsProvider } from './settings';
// Bundled serif for the landing greeting (close to claude.ai's display serif).
import '@fontsource/source-serif-4/400.css';
import '@fontsource/source-serif-4/500.css';
import './styles/theme.css';
import './styles/app.css';
import './index.css';

import { AuthRequired } from './components/AuthRequired';
import { CompatNotice } from './components/CompatNotice';
import { signedIn } from './lib/compat';
import { getToken } from './api';

import { useEffect, useState } from 'preact/hooks';

/**
 * The app, or — when the daemon does not know this page — where to get the
 * link that it does know.
 *
 * Asked once before the app mounts (opened without the link the terminal
 * printed). The account login that also listened for mid-session 401s is
 * gone; a restarted webui is caught on the next full page load.
 */
function Root({ signedIn: initially }: { signedIn: boolean }) {
  return initially ? <App /> : <AuthRequired />;
}

// The installed app's answer for when the webui is not running (`public/sw.js`):
// a page that says how to start it, instead of the browser's "can't reach this
// page". Only where the browser allows a worker — localhost is a secure
// context; a plain-http LAN address is not, and simply goes without.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
    /* no offline page; everything else works as before */
  });
}

void signedIn(fetch, getToken()).then((ok) => {
  render(
    <SettingsProvider>
      <CompatNotice />
      <Root signedIn={ok} />
    </SettingsProvider>,
    document.getElementById('app')!,
  );
});
