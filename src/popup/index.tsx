import { createElement } from 'preact';
import { render } from 'preact';
import { App } from './App';

const root = document.getElementById('root');
if (root) {
  render(createElement(App, null), root);
}
