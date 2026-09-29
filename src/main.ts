import './ui/styles.css';
import { Game } from './game/Game';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');

const game = new Game(root);
(window as unknown as { __game: Game }).__game = game;
game.ui.showNewGameDialog(true);
game.start();
