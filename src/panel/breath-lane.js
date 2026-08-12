const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

export function createBreathLane(element) {
  element.classList.add('lane');
  element.innerHTML = '<div class="lane-fill"></div><div class="lane-ticks"></div>';
  const fill = element.querySelector('.lane-fill');
  const ticks = element.querySelector('.lane-ticks');
  let animation = null;

  function stopFill() {
    animation?.cancel();
    animation = null;
    fill.style.transform = 'scaleX(0)';
  }

  function drainOver(ms, className) {
    stopFill();
    element.dataset.mode = className;
    if (REDUCED.matches) return;
    // WAAPI: hardware accelerated, interruptible, and off the main thread.
    animation = fill.animate(
      [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: ms, easing: 'linear', fill: 'forwards' },
    );
  }

  return {
    tick(outcome) {
      stopFill();
      const mark = document.createElement('i');
      mark.className = `tick tick-${outcome}`;
      ticks.append(mark);
      if (ticks.childElementCount > 120) ticks.firstElementChild.remove();
    },
    rest(ms) {
      drainOver(ms, 'resting');
    },
    break(ms) {
      drainOver(ms, 'break');
    },
    stop() {
      stopFill();
      element.dataset.mode = 'idle';
    },
  };
}
