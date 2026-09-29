import { formatMoney, formatInt } from '../core/math';
import type { Game } from '../game/Game';
import { TERRAIN_INFO } from '../world/terrain';
import { clear, h, icon } from './dom';
import { ICONS } from './icons';
import { createNewGameDialog } from './newGameDialog';

export interface ToolButtonDef {
  id: string;
  label: string;
  icon: string;
  hotkey?: string;
  title?: string;
  onClick: () => void;
  isActive?: () => boolean;
  isLocked?: () => string | null;
}

/** DOM user interface layered over the map canvas. */
export class UI {
  readonly layer: HTMLElement;
  private readonly topBar: HTMLElement;
  private readonly statusLine: HTMLElement;
  readonly toolbar: HTMLElement;
  readonly subToolbar: HTMLElement;
  readonly panelHost: HTMLElement;
  private readonly toastHost: HTMLElement;
  private modal: HTMLElement | null = null;
  private panels: HTMLElement[] = [];
  private refreshTimer = 0;
  private hotkeys = new Map<string, () => void>();
  private toolButtons: Array<{ def: ToolButtonDef; el: HTMLButtonElement }> = [];
  /** Callbacks run a few times per second to refresh live values. */
  readonly refreshers: Array<() => void> = [];

  private el = {
    city: h('span', { class: 'city-name' }),
    pop: h('span', { class: 'value' }, '0'),
    popGroup: h('div', { class: 'tb-group stat clickable', title: 'Population (click for city statistics)' }),
    moneyGroup: h('div', { class: 'tb-group stat clickable', title: 'Money and change per day (click for the budget)' }),
    money: h('span', { class: 'value' }, '$0'),
    moneyDelta: h('span', { class: 'delta' }),
    clock: h('span', { class: 'value' }),
    speed: [] as HTMLButtonElement[],
    extra: h('div', { class: 'tb-extra' }),
  };

  constructor(
    private game: Game,
    root: HTMLElement,
  ) {
    this.layer = h('div', { class: 'ui-layer' });
    root.append(this.layer);

    const speedDefs = [
      { icon: ICONS.pause, title: 'Pause (Space)', idx: -1 },
      { icon: ICONS.play1, title: 'Normal speed (1)', idx: 0 },
      { icon: ICONS.play2, title: 'Fast (2)', idx: 1 },
      { icon: ICONS.play3, title: 'Very fast (3)', idx: 2 },
    ];
    this.el.speed = speedDefs.map((d) => {
      const b = h('button', { class: 'speed-btn', title: d.title, type: 'button' }, icon(d.icon));
      b.addEventListener('click', () => (d.idx < 0 ? game.togglePause() : game.setSpeed(d.idx)));
      return b;
    });

    const menuBtn = h('button', { class: 'icon-btn', title: 'Menu', type: 'button' }, icon(ICONS.menu));
    menuBtn.addEventListener('click', () => this.toggleMenu(menuBtn));

    this.topBar = h(
      'div',
      { class: 'topbar panel' },
      h('div', { class: 'tb-group' }, this.el.city),
      this.el.popGroup,
      this.el.moneyGroup,
      h('div', { class: 'tb-group stat', title: 'Date and time' }, icon(ICONS.clock), this.el.clock),
      this.el.extra,
      h('div', { class: 'tb-spacer' }),
      h('div', { class: 'tb-group speed' }, ...this.el.speed),
      h('div', { class: 'tb-group' }, menuBtn),
    );
    this.el.popGroup.append(icon(ICONS.people), this.el.pop);
    this.el.moneyGroup.append(icon(ICONS.money), this.el.money, this.el.moneyDelta);
    this.layer.append(this.topBar);

    this.toolbar = h('div', { class: 'toolbar panel' });
    this.subToolbar = h('div', { class: 'subtoolbar panel hidden' });
    this.layer.append(h('div', { class: 'toolbar-wrap' }, this.subToolbar, this.toolbar));

    this.panelHost = h('div', { class: 'panel-host' });
    this.layer.append(this.panelHost);

    this.statusLine = h('div', { class: 'status-line' });
    this.layer.append(this.statusLine);

    this.toastHost = h('div', { class: 'toast-host' });
    this.layer.append(this.toastHost);

    game.events.on('speed', () => this.refreshSpeed());
    game.events.on('newGame', (w) => {
      this.el.city.textContent = w.options.cityName;
      this.refreshSpeed();
      this.refresh();
    });
    game.events.on('tool', () => this.refreshToolButtons());
    game.events.on('hover', (p) => {
      const world = game.world;
      if (!world || !world.map.inBounds(p.tx, p.ty)) {
        this.statusLine.textContent = '';
        return;
      }
      const t = world.map.terrainAt(p.tx, p.ty);
      this.statusLine.textContent = `${TERRAIN_INFO[t].name} · tile ${p.tx}, ${p.ty} — ${TERRAIN_INFO[t].description}`;
    });
  }

  /** Adds a tool button to the main toolbar. */
  addToolButton(def: ToolButtonDef, host: HTMLElement = this.toolbar): HTMLButtonElement {
    const el = h(
      'button',
      { class: 'tool-btn', type: 'button', title: def.title ?? `${def.label}${def.hotkey ? ` (${def.hotkey})` : ''}` },
      icon(def.icon),
      h('span', { class: 'tool-label' }, def.label),
    );
    el.dataset.tool = def.id;
    el.addEventListener('click', () => {
      const lock = def.isLocked?.();
      if (lock) {
        this.toast(lock, 'warn');
        return;
      }
      def.onClick();
    });
    host.append(el);
    this.toolButtons.push({ def, el });
    if (def.hotkey) this.hotkeys.set(def.hotkey.toUpperCase(), def.onClick);
    return el;
  }

  refreshToolButtons(): void {
    for (const { def, el } of this.toolButtons) {
      el.classList.toggle('active', !!def.isActive?.());
      const lock = def.isLocked?.();
      el.classList.toggle('locked', !!lock);
    }
  }

  registerHotkey(key: string, fn: () => void): void {
    this.hotkeys.set(key.toUpperCase(), fn);
  }

  /** Handles UI-level hotkeys. Returns true if consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.modal) {
      if (e.code === 'Escape' && this.modalClosable) {
        this.closeModal();
        return true;
      }
      return false;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const fn = this.hotkeys.get(key);
    if (fn) {
      fn();
      return true;
    }
    return false;
  }

  private modalClosable = true;

  showModal(el: HTMLElement, closable = true): void {
    this.closeModal();
    this.modal = el;
    this.modalClosable = closable;
    this.layer.append(el);
  }

  closeModal(): void {
    this.modal?.remove();
    this.modal = null;
  }

  get hasModal(): boolean {
    return this.modal !== null;
  }

  showNewGameDialog(first = false): void {
    const dlg = createNewGameDialog(
      (opts) => {
        this.closeModal();
        this.game.newGame(opts);
      },
      first ? null : () => this.closeModal(),
    );
    this.showModal(dlg, !first);
  }

  /** Opens a panel on the right side (replacing panels of the same kind). */
  openPanel(panel: HTMLElement, kind: string): void {
    this.closePanels(kind);
    panel.dataset.kind = kind;
    panel.classList.add('side-panel', 'panel');
    this.panels.push(panel);
    this.panelHost.append(panel);
  }

  closePanels(kind?: string): void {
    this.panels = this.panels.filter((p) => {
      if (kind === undefined || p.dataset.kind === kind) {
        p.remove();
        p.dispatchEvent(new Event('closed'));
        return false;
      }
      return true;
    });
  }

  /** Closes the most recently opened panel. Returns true if one was closed. */
  closeTopPanel(): boolean {
    const p = this.panels.pop();
    if (!p) return false;
    p.remove();
    p.dispatchEvent(new Event('closed'));
    return true;
  }

  toast(message: string, kind: 'info' | 'warn' | 'good' = 'info', ms = 3200): void {
    const t = h('div', { class: `toast ${kind}` }, message);
    this.toastHost.append(t);
    while (this.toastHost.children.length > 4) this.toastHost.firstElementChild?.remove();
    window.setTimeout(() => {
      t.classList.add('fade');
      window.setTimeout(() => t.remove(), 400);
    }, ms);
  }

  private toggleMenu(anchor: HTMLElement): void {
    const existing = this.layer.querySelector('.menu-pop');
    if (existing) {
      existing.remove();
      return;
    }
    const item = (label: string, fn: () => void) =>
      h(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          onclick: () => {
            pop.remove();
            fn();
          },
        },
        label,
      );
    const pop: HTMLElement = h('div', { class: 'menu-pop panel' }, item('New city…', () => this.showNewGameDialog(false)), item('Controls & help', () => this.showHelp()), ...this.menuExtras.map((m) => item(m.label, m.fn)));
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 8}px`;
    pop.style.right = `${window.innerWidth - r.right}px`;
    this.layer.append(pop);
    const close = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && e.target !== anchor && !anchor.contains(e.target as Node)) {
        pop.remove();
        window.removeEventListener('pointerdown', close);
      }
    };
    window.addEventListener('pointerdown', close);
  }

  /** Extra entries for the main menu (save / load / settings). */
  readonly menuExtras: Array<{ label: string; fn: () => void }> = [];

  showHelp(): void {
    const rows: Array<[string, string]> = [
      ['Left mouse', 'Use the selected tool'],
      ['Right / middle drag', 'Pan the map'],
      ['Mouse wheel', 'Zoom'],
      ['W A S D / arrows', 'Pan the map'],
      ['Space', 'Pause / resume'],
      ['1 · 2 · 3', 'Game speed'],
      ['Esc / right click', 'Cancel or close'],
      ['Shift while dragging a road', 'Straight line'],
      ['Ctrl while dragging a road', 'Overpass (bridge over roads)'],
      ['R · Z · B', 'Roads · Zones · Bulldoze'],
      ['J · L · K · T', 'Junctions · Lanes · Speed limits · Transit'],
      ['Enter / Backspace while drawing a bus line', 'Finish the line / remove the last stop'],
      ['V · C', 'Views · City statistics and budget'],
      ['Click a building, car or road', 'Show details (with no tool selected)'],
    ];
    const body = h(
      'div',
      { class: 'modal-backdrop' },
      h(
        'div',
        { class: 'modal help' },
        h('h2', null, 'Controls'),
        h('table', { class: 'help-table' }, ...rows.map(([k, v]) => h('tr', null, h('td', null, h('kbd', null, k)), h('td', null, v)))),
        h(
          'p',
          { class: 'hint' },
          'Goal: grow your city while keeping traffic flowing. Zone land next to roads; people need jobs (industry, farms, shops) and shops need goods (delivered by trucks). Manage junctions with signs, traffic lights, roundabouts and lane arrows.',
        ),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => this.closeModal() }, 'Got it')),
      ),
    );
    this.showModal(body, true);
  }

  private refreshSpeed(): void {
    const g = this.game;
    this.el.speed.forEach((b, i) => {
      const active = i === 0 ? g.paused : !g.paused && g.speedIndex === i - 1;
      b.classList.toggle('active', active);
    });
    this.topBar.classList.toggle('paused', g.paused);
  }

  /** Called every frame; refreshes the HUD a few times per second. */
  update(dtReal: number): void {
    this.refreshTimer -= dtReal;
    if (this.refreshTimer > 0) return;
    this.refreshTimer = 0.25;
    this.refresh();
  }

  setExtra(el: HTMLElement): void {
    clear(this.el.extra);
    this.el.extra.append(el);
  }

  /** Adds an element to the live stats area of the top bar. */
  addExtra(el: HTMLElement, first = false): void {
    if (first) this.el.extra.prepend(el);
    else this.el.extra.append(el);
  }

  /** Reorders the main toolbar buttons by tool id (unknown ids are skipped). */
  orderToolbar(ids: string[]): void {
    for (const id of ids) {
      const b = this.toolButtons.find((t) => t.def.id === id);
      if (b) this.toolbar.append(b.el);
    }
  }

  hasPanel(kind: string): boolean {
    return this.panels.some((p) => p.dataset.kind === kind);
  }

  /** Makes the population and money stats open something when clicked. */
  onStatClick(which: 'population' | 'money', fn: () => void): void {
    (which === 'population' ? this.el.popGroup : this.el.moneyGroup).addEventListener('click', fn);
  }

  get population(): number {
    return this.game.world?.city.population ?? 0;
  }

  /** Population that counts for unlocks: the highest ever reached, so features never lock again. */
  get unlockPopulation(): number {
    return this.game.world?.city.peakPopulation ?? 0;
  }

  get moneyPerDay(): number {
    return this.game.world?.city.moneyPerDay ?? 0;
  }

  private refresh(): void {
    const world = this.game.world;
    if (!world) return;
    this.el.clock.textContent = world.clock.format();
    this.el.pop.textContent = formatInt(this.population);
    this.el.money.textContent = world.sandbox ? '∞' : formatMoney(world.money);
    this.el.money.classList.toggle('negative', !world.sandbox && world.money < 0);
    const d = this.moneyPerDay;
    this.el.moneyDelta.textContent = world.sandbox ? '' : `${d >= 0 ? '+' : ''}${formatMoney(d)}/day`;
    this.el.moneyDelta.classList.toggle('negative', d < 0);
    for (const r of this.refreshers) r();
    this.refreshToolButtons();
  }
}
