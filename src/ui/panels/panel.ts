import { h, icon } from '../dom';
import { ICONS } from '../icons';

export interface PanelHandle {
  el: HTMLElement;
  body: HTMLElement;
  title: HTMLElement;
}

/** Side panel shell with a title and a close button. */
export function makePanel(title: string, onClose: () => void): PanelHandle {
  const titleEl = h('h3', null, title);
  const close = h('button', { class: 'icon-btn', type: 'button', title: 'Close (Esc)' }, icon(ICONS.close));
  close.addEventListener('click', onClose);
  const body = h('div', { class: 'panel-body' });
  const el = h('section', null, h('header', null, titleEl, close), body);
  return { el, body, title: titleEl };
}

/** Definition list rows; returns a function that updates the values. */
export function kvList(rows: string[]): { el: HTMLElement; set: (values: Array<string | number>) => void } {
  const dds = rows.map(() => h('dd'));
  const el = h('dl', { class: 'kv' }, ...rows.flatMap((r, i) => [h('dt', null, r), dds[i]]));
  return {
    el,
    set: (values) => values.forEach((v, i) => (dds[i].textContent = String(v))),
  };
}
