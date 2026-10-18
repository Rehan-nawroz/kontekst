import { createElement } from 'preact';
import { render } from 'preact';
import { App } from './App';

/**
 * Popup entry point.
 *
 * index.html loads THIS file (not App.tsx) so that the component is actually
 * mounted into #root. App.tsx only exports <App /> — without a render() call
 * the popup served an empty page with no console errors.
 */
const root = document.getElementById('root');
if (root) {
  render(createElement(App, null), root);
}
