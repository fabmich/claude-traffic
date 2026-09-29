import './ui/styles.css';
import { Game } from './game/Game';
import type { SaveGame } from './game/save';

/** Live-update hook of the page viewer (absent when the game runs as a plain file). */
interface HotHook {
  ready?: (start: (data: HotData) => void) => void;
  data?: HotData;
  snapshot?: (fn: () => HotData) => void;
}
type HotData = { save?: SaveGame | null };

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');

function start(data: HotData = {}): void {
  const game = new Game(root!);
  (window as unknown as { __game: Game }).__game = game;
  let resumed = false;
  if (data.save) {
    try {
      game.loadGame(data.save);
      resumed = true;
    } catch {
      // Fall back to the start screen.
    }
  }
  if (!resumed) game.ui.showNewGameDialog(true);
  game.start();
  hot?.snapshot?.(() => ({ save: game.snapshot() }));
}

const hot = (window as unknown as { claude?: { hot?: HotHook } }).claude?.hot;
if (hot?.ready) hot.ready(start);
else start(hot?.data ?? {});
