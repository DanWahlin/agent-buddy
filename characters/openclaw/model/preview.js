import {createOpenClawScene} from './model.js';

const forge = createOpenClawScene(document.getElementById('sprite'));
window.renderOpenClaw = pose => {
  forge.render(pose);
  return document.getElementById('sprite').toDataURL('image/png');
};
window.openClawReady = true;
forge.render({track: 'right', step: 0, blink: 0});
