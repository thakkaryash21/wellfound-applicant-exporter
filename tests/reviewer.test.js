// The applicant reviewer driver: the only file in this extension that clicks
// anything on Wellfound's page, and the only one whose bugs are outward-facing.
// Accepting sends a real message to a real person under the operator's name and
// cannot be undone, so every guard here was written to be seen failing before it
// was trusted.
//
// It ships as a classic MAIN-world content script, so it is loaded the way
// Chrome loads it - the file's own text, evaluated against globals the harness
// prepared - and driven from its two real edges: the DOM, and window messages.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadClassicScript, createFakeWindow } from './helpers/classic-script.js';
import { installFakeDom } from './helpers/fake-dom.js';
// The panel's own copy of the phrase that crosses the world boundary. Imported
// here so the two are compared rather than assumed equal.
import { NOTHING_SENT } from '../src/panel/accept-pass.js';

// What the page does, reduced to what was measured live and nothing more:
//   - the applicant list carries ONE `View application` control per card -
//     fifteen on a full page, all visible and enabled - and clicking card N
//     opens the reviewer AT position N;
//   - the modal carries /link/{userId}/{token}/resume_url and an `N of M`;
//   - `Accept` opens a composer in place, and confirming it removes that person
//     from the bucket, so M drops and the NEXT person slides into the SAME
//     index - the confirm auto-advances;
//   - clicking `Next applicant` raises the index and leaves M alone;
//   - synthetic KeyboardEvents do nothing whatsoever. The site advertises
//     shortcuts, but a scripted event is not a trusted one, so this harness
//     models the keyboard as inert. Where it has to guess, it guesses
//     pessimistically: a fake built to agree with the code cannot contradict
//     it, which is how both of the bugs this shape now encodes got through.
// The markup is this harness's invention; the behaviour is not.
function createPage(options = {}) {
  const dom = installFakeDom();
  const { document } = dom;
  const state = {
    queue: options.queue ?? ['70000001', '70000002', '70000003'],
    index: 1,
    open: false,
    composer: false,
    clicks: [],
    keys: [],
    sentText: null,
    rejected: false,
    focused: false,
    beforeInputs: [],
    inputs: 0,
    inputValues: [],
    order: [],
  };

  function currentId() {
    return state.queue[state.index - 1];
  }

  // One opener per applicant card, as the live list has. `data-at` is the
  // position that card's opener opens the reviewer at.
  function openers() {
    return state.queue
      .map(
        (_id, at) =>
          `<button class="open" data-at="${at + (options.firstOpensAt ?? 1)}">` +
          'View application</button>',
      )
      .join('');
  }

  function render() {
    const aria = options.acceptAriaLabel ? ` aria-label="${options.acceptAriaLabel}"` : '';
    const link = currentId() ? `<a href="/link/${currentId()}/tok9/resume_url">Resume</a>` : '';
    const composer = state.composer
      ? '<textarea id="msg"></textarea>' +
        '<button id="send">Accept application &amp; send message</button>' +
        // Only while the composer is open, and exactly one, as measured.
        // Clicking it clears the box and returns to the profile.
        '<button id="cancel">Cancel response</button>'
      : '';
    document.body.innerHTML =
      openers() +
      (state.open
        ? '<div role="dialog">' +
          `<span>${state.index} of ${state.queue.length}</span>` +
          link +
          `<button id="accept"${aria}>Accept</button>` +
          '<button id="reject">Reject</button>' +
          '<button id="next">Next applicant</button>' +
          // The noise the live page carries around the Accept button, which the
          // earlier shape of this harness did not, and which is the whole reason
          // the anchor on ACCEPT_LABEL is load-bearing. Counted live with the
          // driver's own predicates: `/^accept$/i` matches 2 controls of which 1
          // is usable; `/accept/i` matches 4 of which 3 are usable.
          //
          // Both of these are real controls the selector CAN see, and both merely
          // CONTAIN "accept". A harness that omitted them agreed with any
          // selector it was given - loosening the anchor to /accept/i passed all
          // 660 tests while being dangerous on the page.
          '<button class="profile">Ken Onyekwere - accepting new roles</button>' +
          '<div role="button" class="ideal">' +
          'Ideal next opportunity - open to accepting offers</div>' +
          // The collapsed keyboard-shortcut legend, which is where the page puts
          // BOTH of the controls this harness exists to be awkward about. Its
          // text reads `Exit Reject Accept`, as measured.
          //
          // `accept-legend` is the second EXACT `Accept` match, and the point it
          // makes is the one uniqueControl exists for: a button, not a span, so
          // the selector reaches it, and the only thing standing between it and
          // `Found 2 Accept controls` is the visible/enabled filter. The old span
          // could never exercise that, because usableControls never queried it.
          //
          // `exit` is the SAME SHAPE and the opposite lesson, and modelling it
          // as a normal button was this harness agreeing with the code again.
          // Measured live: exactly one control whose text is `Exit`, enabled,
          // not hidden, display block, visibility visible, opacity 1 - and a
          // bounding rect of 0 x 0, because the legend it sits in is collapsed.
          // It closes the reviewer when clicked; that was verified directly on
          // the page. A rect test that is right about Accept is wrong about it.
          //
          // Both zero boxes are applied in wire(), so they survive every
          // re-render.
          '<div class="legend"><kbd>A</kbd>' +
          '<button id="exit">Exit</button>' +
          '<button id="reject-legend">Reject</button>' +
          '<button id="accept-legend">Accept</button></div>' +
          (options.extraMarkup ?? '') +
          composer +
          '</div>'
        : '');
    wire();
  }

  function wire() {
    // The collapsed legend, as a browser would report it: real controls, drawn
    // at no size. A browser answers this with layout; here the harness says so
    // directly, because saying nothing is how the fake ends up agreeing with
    // whatever predicate it is handed.
    const flat = { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    for (const id of ['accept-legend', 'reject-legend', 'exit']) {
      const el = document.getElementById(id);
      if (el) el.rect = options.legendHasSize ? undefined : flat;
    }
    // The other way a control can be out of reach, and a genuinely different
    // claim: the page saying this element is not part of it, rather than saying
    // its layout is collapsed.
    if (options.exitAriaHidden) document.getElementById('exit')?.setAttribute('aria-hidden', 'true');
    for (const button of document.querySelectorAll('button, [role="button"]')) {
      button.addEventListener('click', () => {
        state.clicks.push(button.textContent.trim());
      });
    }
    for (const opener of document.querySelectorAll('.open')) {
      opener.addEventListener('click', () => {
        state.open = true;
        // Card N opens the reviewer at position N. Clicking the wrong one is
        // not an error the page reports; it just starts you in the wrong place.
        state.index = Number(opener.getAttribute('data-at'));
        state.openedAt = state.index;
        render();
      });
    }
    document.getElementById('accept')?.addEventListener('click', () => {
      options.onAcceptClick?.(state);
      // A page that takes the click and never brings the composer up: a slow
      // render, a changed markup, an error inside their own handler. Nothing
      // has been typed and nothing sent, and the driver has to say so.
      state.composer = !options.composerNeverOpens;
      render();
    });
    document.getElementById('reject')?.addEventListener('click', () => {
      state.rejected = true;
    });
    // The two ways out, as measured. Cancel clears the composer and leaves the
    // profile up; Exit closes the reviewer entirely. Neither sends anything, and
    // the harness records nothing extra about them - the assertion that matters
    // is what the page looks like afterwards.
    document.getElementById('cancel')?.addEventListener('click', () => {
      if (options.cancelDoesNothing) return;
      state.composer = false;
      render();
    });
    document.getElementById('exit')?.addEventListener('click', () => {
      if (options.exitDoesNothing) return;
      state.open = false;
      state.composer = false;
      render();
    });
    document.getElementById('next')?.addEventListener('click', () => {
      if (options.onNextClick) {
        options.onNextClick(state);
      } else if (state.index < state.queue.length) {
        // They stay in the bucket: the index rises, the total does not move.
        state.index += 1;
      }
      render();
    });
    // The composer, watched the way a page watches its own field: focus and
    // each input notification.
    const box = document.getElementById('msg');
    if (box) {
      // A composer that silently keeps nothing, which is the one failure that
      // would otherwise send an empty message to a real person.
      if (options.deafComposer) {
        Object.defineProperty(box, '_value', { get: () => '', set() {}, configurable: true });
      }
      box.focus = () => {
        document.activeElement = box;
        state.focused = true;
        state.order.push('focus');
      };
      box.addEventListener('beforeinput', (event) => {
        state.order.push('beforeinput');
        state.beforeInputs.push(event.data);
      });
      box.addEventListener('input', () => {
        state.order.push('input');
        state.inputs += 1;
        state.inputValues.push(box.value);
      });
    }
    const send = document.getElementById('send');
    if (send) {
      if (options.sendUsableAfterMs) {
        send.disabled = true;
        setTimeout(() => {
          send.disabled = false;
        }, options.sendUsableAfterMs);
      }
      send.focus = () => {
        if (options.sendCannotFocus) return;
        document.activeElement = send;
        if (!options.manualEnter) pressPhysicalEnter();
      };
    }
    send?.addEventListener('click', () => {
      const field = document.querySelector('textarea');
      state.sentText = field.value;
      // Which route the value took, captured while the composer still exists:
      // a confirmed send closes it, and the element is gone by the time a test
      // could look.
      state.viaPrototypeSetter = Boolean(field.viaPrototypeSetter);
      (options.onSendClick ?? confirmSend)(state);
      render();
    });
  }

  function pressPhysicalEnter() {
    const focused = document.activeElement;
    const event = new FakeKeyboardEvent('keydown', { key: 'Enter', isTrusted: true });
    document.dispatchEvent(event);
    if (!event.defaultPrevented && focused?.tagName === 'BUTTON') focused.click();
    return event;
  }

  // The bucket is a queue. Accepting removes that person; the index stays.
  function confirmSend() {
    state.queue.splice(state.index - 1, 1);
    state.composer = false;
    render();
  }

  // The keyboard, as measured: a scripted event is recorded here so a test can
  // see it was sent, and moves nothing, because on the live page it moved
  // nothing. `r` and `x` would be catastrophic if the site ever did trust a
  // synthetic event, so the harness treats them as if it did - and listens on
  // all three key events, because "the driver sends no keys" is a claim about
  // every one of them, not just the one it used to send.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    document.addEventListener(type, (event) => {
      state.keys.push(event.key);
      if (/^(r|x)$/i.test(event.key)) state.rejected = true;
    });
  }

  render();
  return {
    dom,
    document,
    state,
    render,
    currentId,
    pressEnter() {
      return pressPhysicalEnter();
    },
  };
}

class FakeKeyboardEvent {
  constructor(type, init) {
    this.type = type;
    this.key = init?.key;
    this.isTrusted = init?.isTrusted ?? false;
    this.defaultPrevented = false;
    this.immediatePropagationStopped = false;
    this.preventDefault = () => {
      this.defaultPrevented = true;
    };
    this.stopImmediatePropagation = () => {
      this.immediatePropagationStopped = true;
    };
  }
}

class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

class FakeInputEvent extends FakeEvent {
  constructor(type, init) {
    super(type);
    this.data = init?.data ?? null;
    this.inputType = init?.inputType ?? '';
  }
}

// The prototype whose `value` setter React reads through. The driver reaches
// for this descriptor rather than assigning `box.value` directly, so the
// harness has to own one for that path to be the path under test - and it
// records that it was the one used.
class FakeHTMLTextAreaElement {
  get value() {
    return this._value ?? '';
  }

  set value(next) {
    this._value = String(next);
    this.viaPrototypeSetter = true;
  }
}

function load(page, { inputEvents = true, typingIntervalMs = 0 } = {}) {
  const fakeWindow = createFakeWindow();
  const { exposed } = loadClassicScript('src/content/reviewer.js', {
    globals: {
      window: fakeWindow.window,
      document: page.document,
      KeyboardEvent: FakeKeyboardEvent,
      Event: FakeEvent,
      ...(inputEvents ? { InputEvent: FakeInputEvent } : {}),
      HTMLTextAreaElement: FakeHTMLTextAreaElement,
      __WFX_TYPING_INTERVAL_MS__: typingIntervalMs,
    },
    expose: '__WFX_REVIEWER__',
  });
  return { ...fakeWindow, driver: exposed };
}

const MESSAGE = 'Hey Ken,\n\nThanks so much for applying.';

let page;
let driver;

beforeEach(() => {
  // Installed before the script loads so the Date the script closes over is the
  // faked one; otherwise a poll to a deadline never reaches it.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  page?.dom.restore();
  page = undefined;
  driver = undefined;
});

function start(options, loadOptions) {
  page = createPage(options);
  driver = load(page, loadOptions).driver;
  return driver;
}

describe('opening the reviewer', () => {
  it('clicks the first of the many openers the list carries', async () => {
    start();
    // Plurality is the normal state of this page: one opener per card. Demanding
    // exactly one here - the rule that keeps Accept safe - meant the feature
    // could never start at all.
    expect(page.document.querySelectorAll('.open').length).toBe(3);
    const at = await driver.openReviewer();
    // Card N opens the reviewer at position N, so the first card is the one to
    // click: a confirmed accept holds the index and drains the bucket, so
    // position 1 is where the loop stays.
    expect(page.state.openedAt).toBe(1);
    expect(at).toEqual({ opened: true, userId: '70000001', index: 1, total: 3 });
    // One click, first time. The double-click once seen was a scrolling
    // harness's artifact, and a second click on an open modal lands unknown.
    expect(page.state.clicks).toEqual(['View application']);
  });

  it('reports where it landed rather than assuming, and stops if it is not 1', async () => {
    start({ firstOpensAt: 2 });
    await expect(driver.openReviewer()).rejects.toThrow(/opened at position 2, not 1/);
  });
});

describe('reporting who is shown', () => {
  it('reads the id from the resume link and the position from the counter', async () => {
    start();
    await driver.openReviewer();
    expect(driver.readCurrent()).toEqual({ userId: '70000001', index: 1, total: 3 });
  });

  it('errors rather than returning null when the id cannot be read', async () => {
    start();
    await driver.openReviewer();
    page.document.querySelector('a').remove();
    // Never a null, and never a fall back to the displayed name: a modal whose
    // id is unreadable stops the run, because the alternative is acting on
    // somebody the caller did not name.
    expect(() => driver.readCurrent()).toThrow(/candidate id/i);
  });

  it('errors when the modal carries two different candidate ids', async () => {
    start();
    await driver.openReviewer();
    const second = page.document.createElement('a');
    second.setAttribute('href', '/link/99999999/tokX/resume_url');
    page.document.querySelector('[role="dialog"]').append(second);
    expect(() => driver.readCurrent()).toThrow(/2 candidate ids/i);
  });
});

describe('accepting', () => {
  it('does not enter confirmation or resting while it is still waiting for physical Enter', async () => {
    start({ manualEnter: true });
    await driver.openReviewer();
    let settled = false;
    const pending = driver
      .acceptCurrent({ expectedUserId: '70000001', message: MESSAGE })
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.document.activeElement?.getAttribute('id')).toBe('send');
    expect(page.state.sentText).toBe(null);
    expect(settled).toBe(false);

    page.pressEnter();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });

  it('types the message, arms the send control, and waits for the operator to press Enter', async () => {
    start({ manualEnter: true });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '70000001',
      message: MESSAGE,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(page.state.sentText).toBe(null);
    expect(page.state.clicks).toEqual(['View application', 'Accept']);
    expect(page.state.keys).toEqual(['Tab', 'Tab', 'Tab', 'Tab']);
    expect(page.document.activeElement?.getAttribute('id')).toBe('send');

    const syntheticEnter = new FakeKeyboardEvent('keydown', { key: 'Enter' });
    page.document.dispatchEvent(syntheticEnter);
    expect(syntheticEnter.defaultPrevented).toBe(true);
    expect(page.state.sentText).toBe(null);

    page.pressEnter();
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    // Confirming auto-advances: the next person is already at index 1 and the
    // denominator dropped. A caller that pressed Next after this would skip
    // somebody, so the driver reports the new position rather than moving.
    expect(result).toEqual({
      userId: '70000001',
      accepted: true,
      next: { userId: '70000002', index: 1, total: 2 },
    });
  });

  it('refuses when the reviewer is showing somebody else', async () => {
    start();
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000002', message: MESSAGE }),
    ).rejects.toThrow(/showing 70000001, not 70000002/);
    expect(page.state.clicks).toEqual(['View application']);
  });

  it('refuses without an expected id at all', async () => {
    start();
    await driver.openReviewer();
    await expect(driver.acceptCurrent({ message: MESSAGE })).rejects.toThrow(/expected candidate/i);
  });

  it('refuses without submitting when the send control cannot take focus', async () => {
    start({ sendCannotFocus: true });
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).rejects.toThrow(/Could not focus.*nothing was sent/);
    expect(page.state.sentText).toBe(null);
    expect(page.state.clicks).toEqual(['View application', 'Accept']);
    expect(driver.sent.has('70000001')).toBe(false);
  });
});

// --- the two classes of failure -----------------------------------------------

// This driver knows something the panel cannot work out for itself: whether the
// Send control was armed. A refusal raised before arming is certain - nothing went
// anywhere - and the panel says so plainly; a failure raised after it is
// genuinely ambiguous and raises the alarm that sends the operator to Wellfound
// to check on a stranger. Flattening the two trained the operator to discount
// the alarm on the run where it was real.
//
// The wire between the two worlds carries a string and nothing else, so the
// classification travels in the text and this phrase is the contract.
describe('saying whether anything was sent', () => {
  const certainly = (message) => expect(message).toContain(driver.NOTHING_SENT);

  it('agrees with the panel on the exact phrase', async () => {
    start();
    // Two copies, in two worlds, because a MAIN-world classic script cannot
    // import - the same reason the message type strings are duplicated into it.
    // A silent divergence turns every certain refusal back into the alarm.
    expect(driver.NOTHING_SENT).toBe(NOTHING_SENT);
  });

  it('marks a composer that never opened, where nothing was even typed', async () => {
    // The Accept button click does not bring up a composer. Measured tolerance
    // is five seconds; a slow render is not an ambiguous send.
    start({ composerNeverOpens: true });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    const settled = pending.catch((error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    const error = await settled;
    expect(error.message).toMatch(/composer did not open/);
    certainly(error.message);
    expect(page.state.sentText).toBe(null);
  });

  it('marks an identity mismatch', async () => {
    start();
    await driver.openReviewer();
    const error = await driver
      .acceptCurrent({ expectedUserId: '70000002', message: MESSAGE })
      .catch((e) => e);
    certainly(error.message);
  });

  it('marks a message the composer kept nothing of', async () => {
    start({ deafComposer: true });
    await driver.openReviewer();
    const error = await driver
      .acceptCurrent({ expectedUserId: '70000001', message: MESSAGE })
      .catch((e) => e);
    expect(error.message).toMatch(/did not reach the composer/);
    certainly(error.message);
  });

  it('marks a leftover token and an empty message', async () => {
    start();
    await driver.openReviewer();
    for (const message of ['Hey [first_name],', '   ']) {
      const error = await driver
        .acceptCurrent({ expectedUserId: '70000001', message })
        .catch((e) => e);
      certainly(error.message);
    }
  });

  // The whole point of the split: this one, and only this one, may raise it.
  it('does NOT mark the send it could not confirm', async () => {
    start({ onSendClick: () => {} });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(13000);
    const result = await pending;
    // Not thrown. On a large role the fast path running out is ordinary rather
    // than an alarm, and the panel goes on watching. The sentence it hands over
    // is unchanged, and it still carries no certainty phrase - so if the
    // watching runs out too, it still reads as unclear.
    expect(result).toMatchObject({ accepted: false, pending: true });
    expect(result.reason).toMatch(/operator may or may not have sent/);
    expect(result.reason).not.toContain(driver.NOTHING_SENT);
    // The denominator before the click, which is what the panel needs to go on
    // applying the same predicate this file just applied.
    expect(result.total).toBe(3);
  });
});

// --- how the message goes in --------------------------------------------------

// Every letter the reviewer binds a shortcut to, at document level: `a` is
// Accept, `r` is Reject, `x` is Quick Reject. The real message is full of all
// three, which is why message characters are input events rather than keyboard
// events.
const RISKY_MESSAGE = 'Hey Amara,\n\nRegarding your excellent application - warm regards!';

describe('entering the message', () => {
  it('visibly yields between characters instead of completing in one task', async () => {
    start({ manualEnter: true }, { typingIntervalMs: 20 });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: 'Hello' });

    await vi.advanceTimersByTimeAsync(0);
    expect(page.state.inputValues).toEqual(['H']);
    await vi.advanceTimersByTimeAsync(20);
    expect(page.state.inputValues.length).toBeGreaterThan(1);

    await vi.runAllTimersAsync();
    page.pressEnter();
    await vi.advanceTimersByTimeAsync(300);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });

  it('dispatches no character key event, whatever the message contains', async () => {
    start();
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '70000001', message: RISKY_MESSAGE });
    // Only the two Tab attempts used to arm the operator's physical Enter.
    // Message characters never become shortcut KeyboardEvents.
    expect(page.state.keys.filter((key) => key === 'Tab')).toEqual(['Tab', 'Tab', 'Tab', 'Tab']);
    expect(page.state.keys).not.toContain('a');
    expect(page.state.keys).not.toContain('r');
    expect(page.state.keys).not.toContain('x');
    expect(page.state.rejected).toBe(false);
    expect(page.state.sentText).toBe(RISKY_MESSAGE);
  });

  it('focuses, enters each character through the prototype setter, and announces each input', async () => {
    start();
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    expect(page.state.order[0]).toBe('focus');
    expect(page.state.beforeInputs.join('')).toBe(MESSAGE);
    expect(page.state.inputs).toBe([...MESSAGE].length);
    expect(page.state.inputValues[0]).toBe('H');
    expect(page.state.inputValues.at(-1)).toBe(MESSAGE);
    // The value went in through HTMLTextAreaElement's own setter, which is the
    // step that leaves React holding the message rather than just the DOM node.
    expect(page.state.viaPrototypeSetter).toBe(true);
  });

  it('waits for the unique Send control to become usable after a reload render', async () => {
    start({ sendUsableAfterMs: 200 });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(199);
    expect(page.state.sentText).toBe(null);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });

  it('still lands the value where the browser has no InputEvent constructor', async () => {
    start(undefined, { inputEvents: false });
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    expect(page.state.sentText).toBe(MESSAGE);
    expect(page.state.beforeInputs).toEqual([]);
    expect(page.state.inputs).toBe([...MESSAGE].length);
  });

  it('refuses to send when the text cannot be read back off the element', async () => {
    start({ deafComposer: true });
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).rejects.toThrow(/did not reach the composer/);
    expect(page.state.sentText).toBe(null);
  });
});

describe('the pauses either side of entering the message', () => {
  const PAUSES = { beforePasteMs: 3000, afterPasteMs: 2000 };

  it('waits before entering and again before arming, honouring what it was handed', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '70000001',
      message: MESSAGE,
      ...PAUSES,
    });

    // The composer is open and empty: the operator is gathering their thoughts.
    await vi.advanceTimersByTimeAsync(2900);
    expect(page.state.inputValues).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    expect(page.state.inputValues.at(-1)).toBe(MESSAGE);
    // Entered, but not sent: this is the glance over it before committing.
    expect(page.state.sentText).toBe(null);

    await vi.advanceTimersByTimeAsync(1800);
    expect(page.state.sentText).toBe(null);
    await vi.advanceTimersByTimeAsync(200);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });

  it('invents no pause of its own when it was handed none', async () => {
    start();
    await driver.openReviewer();
    // The panel owns pacing. A driver that filled in its own numbers would put
    // one concept in two files and drift from the run's own rhythm.
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('feels a stop inside the pause rather than after it, and does not send', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '70000001',
      message: MESSAGE,
      beforePasteMs: 1000,
      afterPasteMs: 30000,
    });
    const settled = expect(pending).rejects.toThrow(/Stopped before the message was sent/);
    await vi.advanceTimersByTimeAsync(1500);
    expect(page.state.inputValues.at(-1)).toBe(MESSAGE);

    await driver.handlers.STOP();
    // One slice, not the remaining twenty-nine seconds. An operator who presses
    // stop is not asked to wait out a pause they interrupted.
    await vi.advanceTimersByTimeAsync(200);
    await settled;
    expect(page.state.sentText).toBe(null);
    expect(page.state.clicks).not.toContain('Accept application & send message');
    // Nothing went out, so this candidate is not burned: the never-retry guard
    // is about messages that may have been delivered, not about attempts.
    expect(driver.sent.has('70000001')).toBe(false);
  });

  it('stops during the first pause without entering anything at all', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '70000001',
      message: MESSAGE,
      beforePasteMs: 30000,
    });
    const settled = expect(pending).rejects.toThrow(/Stopped before the message was entered/);
    await vi.advanceTimersByTimeAsync(300);
    await driver.handlers.STOP();
    await vi.advanceTimersByTimeAsync(200);
    await settled;
    expect(page.state.inputValues).toEqual([]);
  });

  it('clears an earlier stop when the reviewer is opened for a new pass', async () => {
    start();
    await driver.openReviewer();
    await driver.handlers.STOP();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '70000001',
      message: MESSAGE,
      ...PAUSES,
    });
    await vi.advanceTimersByTimeAsync(6000);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });
});

// --- guard: never reject ------------------------------------------------------

describe('the never-reject guard', () => {
  it('refuses to send the reject keys', async () => {
    start();
    await driver.openReviewer();
    for (const key of ['r', 'R', 'x', 'X']) {
      expect(() => driver.sendKey(key)).toThrow(/rejects the candidate/);
    }
    expect(page.state.keys).toEqual([]);
    expect(page.state.rejected).toBe(false);
  });

  it('refuses to click a reject control even when handed one directly', async () => {
    start();
    await driver.openReviewer();
    const reject = page.document.getElementById('reject');
    // The guard sits at the click, not at the call site: this is what protects
    // against a selector that matched the wrong adjacent, enabled button.
    expect(() => driver.clickSafely(reject, 'Accept')).toThrow(/Refusing to click a reject/);
    expect(page.state.rejected).toBe(false);
  });

  it('refuses a control that reads Accept but is labelled reject', async () => {
    start({ acceptAriaLabel: 'Reject application' });
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).rejects.toThrow(/Refusing to click a reject/);
    expect(page.state.clicks).toEqual(['View application']);
  });
});

// --- guard: identity immediately before the click -----------------------------

describe('the identity interlock', () => {
  it('aborts when the page moves on between opening the composer and sending', async () => {
    // The id matched when accept was called. It stops matching while the
    // composer opens - which is exactly the window the re-read exists to cover,
    // and the reason the check cannot live at the top of the function.
    start({
      onAcceptClick: (state) => {
        state.queue.shift();
      },
    });
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).rejects.toThrow(/moved to 70000002 before the send; nothing was sent/);
    expect(page.state.sentText).toBe(null);
    expect(page.state.clicks).not.toContain('Accept application & send message');
  });

  it('blocks Enter when the positional reviewer moves after Send was focused', async () => {
    start({ manualEnter: true });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(100);
    expect(page.document.activeElement?.getAttribute('id')).toBe('send');

    page.state.queue.push(page.state.queue.shift());
    page.render();
    page.pressEnter();
    expect(page.state.sentText).toBe(null);
    await driver.handlers.STOP();
    await expect(pending).rejects.toThrow(/nothing was sent/);
  });

  it('fails closed when identity becomes unreadable at physical Enter', async () => {
    start({ manualEnter: true });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(100);
    page.document.querySelector('a').remove();

    const enter = page.pressEnter();
    expect(enter.defaultPrevented).toBe(true);
    expect(page.state.sentText).toBe(null);
    await driver.handlers.STOP();
    await expect(pending).rejects.toThrow(/nothing was sent/);
  });
});

// --- guard: exactly one match -------------------------------------------------

describe('the exactly-one-control guard', () => {
  // Counted on the live page on 2026-08-12 with the driver's own predicates,
  // and reproduced by the default dialog above. These two rows are the reason
  // ACCEPT_LABEL is anchored, and a harness that could not produce them agreed
  // with any selector it was handed.
  //
  // Counted with the driver's OWN predicate, not with a copy of it: a harness
  // that reimplements the rule it is checking can only ever agree with itself.
  const count = (pattern) => {
    const { matching, usable } = driver.usableControls(
      page.document.querySelector('[role="dialog"]'),
      pattern,
    );
    return { matched: matching.length, usable: usable.length };
  };

  it('presents the same Accept ambiguity the live page was measured to have', async () => {
    start();
    await driver.openReviewer();
    // Anchored: the action button plus the shortcut legend's own button, of
    // which only the action button is rendered.
    expect(count(/^accept$/i)).toEqual({ matched: 2, usable: 1 });
    // Unanchored: both of those, plus the profile header and the "Ideal next
    // opportunity" block, which merely contain the word.
    expect(count(/accept/i)).toEqual({ matched: 4, usable: 3 });
  });

  // Every selector this file carries, counted against the page it drives, in
  // one place. A census run live on 2026-08-12 found six of the seven exactly
  // right and one - Exit - matching a control with no box, which no test could
  // have caught while the harness drew it like an ordinary button.
  it('reproduces the whole measured census, not just the row that was checked', async () => {
    start();
    await driver.openReviewer();
    // With the composer up, so the two controls that only exist then are in it.
    page.state.composer = true;
    page.render();

    const acting = (pattern) => {
      const { matched, usable } = count(pattern);
      return [matched, usable];
    };
    expect({
      accept: acting(/^accept$/i),
      send: acting(/accept application/i),
      next: acting(/^next applicant$/i),
      cancel: acting(/^cancel response$/i),
      reject: acting(/reject/i),
      exit: acting(/^exit$/i),
    }).toEqual({
      accept: [2, 1],
      send: [1, 1],
      next: [1, 1],
      cancel: [1, 1],
      // The legend carries a second `Reject` with no box, as the live page does.
      reject: [2, 1],
      // The row that mattered: present, unique, and invisible to the acting
      // predicate. Leaving asks a different question of the same control.
      exit: [1, 0],
    });
    expect(driver.reachableControls(page.document.querySelector('[role="dialog"]'), /^exit$/i)
      .usable.length).toBe(1);

    // The opener is plural and lives outside the dialog; plurality is the
    // property, not the count, so the live figure of 12 is not reproduced here.
    expect(page.document.querySelectorAll('.open').length).toBeGreaterThan(1);
  });

  it('would abort every accept if the anchor were loosened', async () => {
    start();
    await driver.openReviewer();
    // The mutation, run against the harness rather than against the file: this
    // is what `ACCEPT_LABEL = /accept/i` would hand uniqueControl on the real
    // page. Three usable matches, and the driver does not guess between them.
    expect(() => driver.uniqueControl(page.document.body, /accept/i, 'Accept')).toThrow(
      /Found 3 Accept controls/,
    );
    // The anchored pattern, on the same DOM, finds the one that acts.
    expect(driver.uniqueControl(page.document.body, /^accept$/i, 'Accept').id).toBe('accept');
  });

  it('accepts through the noise, picking the one control that is rendered', async () => {
    start();
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).resolves.toMatchObject({ accepted: true });
    expect(page.state.clicks).toEqual([
      'View application',
      'Accept',
      'Accept application & send message',
    ]);
  });

  it('ignores a matching control the page is not showing', async () => {
    start({ extraMarkup: '<div role="button" id="ghost">Accept</div>' });
    await driver.openReviewer();
    page.document.getElementById('ghost').rect = { width: 0, height: 0 };
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('aborts when two visible, enabled controls match', async () => {
    start({ extraMarkup: '<div role="button">Accept</div>' });
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).rejects.toThrow(/Found 2 Accept controls/);
    expect(page.state.clicks).toEqual(['View application']);
  });

  it('aborts when none match', async () => {
    start();
    await driver.openReviewer();
    page.document.getElementById('accept').remove();
    expect(() => driver.uniqueControl(page.document.body, /^accept$/i, 'Accept')).toThrow(
      /Could not find the Accept control/,
    );
  });

  it('aborts when the only match is disabled', async () => {
    start();
    await driver.openReviewer();
    page.document.getElementById('accept').disabled = true;
    expect(() => driver.uniqueControl(page.document.body, /^accept$/i, 'Accept')).toThrow(
      /none usable/,
    );
  });
});

// --- guard: no token left behind ----------------------------------------------

describe('the unsubstituted-token guard', () => {
  it('refuses a message that still carries a token', async () => {
    start();
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({
        expectedUserId: '70000001',
        message: 'Hey [first_name], thanks for applying.',
      }),
    ).rejects.toThrow(/unsubstituted token/);
    // Nothing was opened, nothing was typed, nothing was sent.
    expect(page.state.clicks).toEqual(['View application']);
    expect(page.state.sentText).toBe(null);
  });

  it('refuses an empty message', async () => {
    start();
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: '   ' }),
    ).rejects.toThrow(/empty message/);
    expect(page.state.clicks).toEqual(['View application']);
  });
});

// --- guard: never retry a send ------------------------------------------------

describe('the never-retry guard', () => {
  it('refuses a second accept for a candidate it has already sent to', async () => {
    start();
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    // The reviewer has moved on, but even if the caller put them back, the
    // answer is the same: a retried accept is a second message to somebody who
    // already received one.
    page.state.queue.unshift('70000001');
    page.render();
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).rejects.toThrow(/Already sent an accept to 70000001/);
    expect(page.state.clicks.filter((c) => c.startsWith('Accept application')).length).toBe(1);
  });

  it('refuses a retry after an unconfirmed send, which is when the temptation is real', async () => {
    // The send click lands but nothing happens: the outcome is unknown, and the
    // message may well have gone.
    start({ onSendClick: () => {} });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(13000);
    await expect(pending).resolves.toMatchObject({ pending: true });
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).rejects.toThrow(/Already sent an accept/);
    expect(page.state.clicks.filter((c) => c.startsWith('Accept application')).length).toBe(1);
  });
});

// --- the completion signal ----------------------------------------------------

describe('confirming the send', () => {
  it('does not accept a changed candidate alone as proof - the bucket must drain', async () => {
    // The person on screen changed but M did not: the reviewer moved, it did
    // not send. Sleeping and assuming would have called this a success.
    start({
      onSendClick: (state) => {
        state.queue.push(state.queue.shift());
        state.composer = false;
      },
    });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    // Reported as pending rather than landed: the fast path refuses to call
    // a half-signal a send, exactly as it refused to before.
    await vi.advanceTimersByTimeAsync(13000);
    await expect(pending).resolves.toMatchObject({ accepted: false, pending: true });
  });

  it('does not accept a drained bucket alone as proof - the candidate must change', async () => {
    start({
      onSendClick: (state) => {
        state.queue.splice(1, 1);
        state.composer = false;
      },
    });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    // Reported as pending rather than landed: the fast path refuses to call
    // a half-signal a send, exactly as it refused to before.
    await vi.advanceTimersByTimeAsync(13000);
    await expect(pending).resolves.toMatchObject({ accepted: false, pending: true });
  });

  it('waits for a send that lands late rather than failing early', async () => {
    let rerender;
    start({
      onSendClick: (state) => {
        state.composer = false;
        setTimeout(() => {
          state.queue.shift();
          rerender();
        }, 4000);
      },
    });
    rerender = page.render;
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });
});

// --- skipping -----------------------------------------------------------------

describe('skipping', () => {
  it('clicks Next applicant, leaving the bucket alone', async () => {
    start();
    await driver.openReviewer();
    const next = await driver.skipCurrent();
    expect(page.state.clicks).toEqual(['View application', 'Next applicant']);
    // Not a key. A synthetic ArrowRight was measured moving the reviewer not at
    // all, so the driver sends no keys anywhere, ever.
    expect(page.state.keys).toEqual([]);
    // They stay in the bucket, so M is unchanged and the index rises.
    expect(next).toEqual({ userId: '70000002', index: 2, total: 3 });
    expect(page.state.rejected).toBe(false);
  });

  it('does not take the accept signal as proof that a skip moved on', async () => {
    // The bucket drained and the person on screen changed - the shape of a
    // send, not of a skip. Reusing the accept's signal here would report
    // "skipped" for somebody who had just been messaged.
    start({
      onNextClick: (state) => {
        state.queue.shift();
      },
    });
    await driver.openReviewer();
    const pending = driver.skipCurrent();
    const settled = expect(pending).rejects.toThrow(/did not move on to the next candidate/);
    await vi.advanceTimersByTimeAsync(41000);
    await settled;
  });

  it('reports rather than hanging when the reviewer does not move', async () => {
    start({ queue: ['70000001'] });
    await driver.openReviewer();
    const pending = driver.skipCurrent();
    const settled = expect(pending).rejects.toThrow(/did not move on to the next candidate/);
    await vi.advanceTimersByTimeAsync(41000);
    await settled;
  });
});

// --- leaving ------------------------------------------------------------------

// The state this driver used to be able to leave behind: the reviewer open, the
// composer expanded, and the operator's message sitting in the textarea one
// click from a real person's inbox - after a stop the operator pressed on
// purpose. Nothing in the file could close it, because nothing in the file
// could close anything.
describe('leaving the page as it was found', () => {
  const dialog = () => page.document.querySelector('[role="dialog"]');
  const composer = () => page.document.querySelector('textarea');

  it('does nothing, and says so, when there is nothing to tear down', async () => {
    start();
    // Never opened. Teardown runs on every exit path, including the ones where
    // the pass touched Wellfound's UI not at all.
    await expect(driver.closeReviewer()).resolves.toEqual({
      cancelled: false,
      closed: true,
      notes: [],
    });
    expect(page.state.clicks).toEqual([]);
  });

  it('closes a reviewer that has no composer open', async () => {
    start();
    await driver.openReviewer();
    const report = await driver.closeReviewer();
    expect(report).toMatchObject({ cancelled: false, closed: true });
    expect(dialog()).toBe(null);
    expect(page.state.clicks).toEqual(['View application', 'Exit']);
  });

  it('cancels the composed message first, then closes what is left', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '70000001',
      message: MESSAGE,
      afterPasteMs: 30000,
    });
    const settled = expect(pending).rejects.toThrow(/Stopped before the message was sent/);
    await vi.advanceTimersByTimeAsync(200);
    await driver.handlers.STOP();
    await vi.advanceTimersByTimeAsync(200);
    await settled;

    // The state the operator would have been left staring at: their message, in
    // the box, on somebody's profile.
    expect(composer().value).toBe(MESSAGE);

    const report = await driver.closeReviewer();
    expect(report).toEqual({ cancelled: true, closed: true, notes: [] });
    expect(composer()).toBe(null);
    expect(dialog()).toBe(null);
    // Cancel before Exit, and no other click of any kind on the way out.
    expect(page.state.clicks.slice(-2)).toEqual(['Cancel response', 'Exit']);
    expect(page.state.sentText).toBe(null);
  });

  it('is safe to call twice', async () => {
    start();
    await driver.openReviewer();
    await driver.closeReviewer();
    await expect(driver.closeReviewer()).resolves.toEqual({
      cancelled: false,
      closed: true,
      notes: [],
    });
  });

  it('refuses to touch the modal while an accept is still unresolved', async () => {
    // The send has been clicked and the outcome is not known yet. Clicking
    // Cancel response next to a message that may already have gone is how a
    // teardown becomes the thing that needed tearing down.
    start({ onSendClick: () => {} });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    const settled = pending.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);

    const before = page.state.clicks.length;
    const report = await driver.closeReviewer();
    expect(report.closed).toBe(false);
    expect(report.notes).toEqual(['an accept is still in flight; left the reviewer alone']);
    expect(page.state.clicks.length).toBe(before);

    await vi.advanceTimersByTimeAsync(41000);
    await settled;
  });

  it('reports a control it cannot find rather than throwing over the run error', async () => {
    start();
    await driver.openReviewer();
    page.document.getElementById('exit').remove();
    const report = await driver.closeReviewer();
    expect(report.closed).toBe(false);
    expect(report.notes[0]).toBe('no usable Exit control (0 matched by text)');
    // Still on the page - but the pass's own error reaches the operator intact,
    // which is the property that matters more.
    expect(dialog()).not.toBe(null);
  });

  it('reports a control that was clicked and did nothing, without waiting long', async () => {
    start({ exitDoesNothing: true });
    await driver.openReviewer();
    const pending = driver.closeReviewer();
    await vi.advanceTimersByTimeAsync(2000);
    const report = await pending;
    expect(report.closed).toBe(false);
    expect(report.notes[0]).toBe('Clicked Exit, but the page did not respond to it');
  });

  it('clicks nothing when two controls could be the way out', async () => {
    start({ extraMarkup: '<div role="button">Exit</div>' });
    await driver.openReviewer();
    const report = await driver.closeReviewer();
    expect(report.closed).toBe(false);
    expect(report.notes[0]).toBe('found 2 Exit controls, so clicked none');
    expect(page.state.clicks).toEqual(['View application']);
  });

  // Exit is best-effort and cancelling is the guarantee, so a teardown that
  // half-worked says which half. Two booleans and a button name are not a thing
  // to hand somebody who needs to know whether a stranger is about to get a
  // message.
  describe('what it says when it could not finish', () => {
    it('says the page is merely untidy when nothing is composed in it', async () => {
      start({ exitDoesNothing: true });
      await driver.openReviewer();
      const pending = driver.closeReviewer();
      await vi.advanceTimersByTimeAsync(2000);
      const report = await pending;
      expect(report.notes.at(-1)).toMatch(/nothing can be sent from it/);
      expect(report.notes.at(-1)).not.toMatch(/COMPOSED MESSAGE/);
    });

    it('raises the alarm when the message is still sitting in the composer', async () => {
      // Both ways out refused. This is the state the whole finding was about,
      // and the operator has to be told in the words that describe it.
      start({ cancelDoesNothing: true, exitDoesNothing: true });
      await driver.openReviewer();
      const accept = driver.acceptCurrent({
        expectedUserId: '70000001',
        message: MESSAGE,
        afterPasteMs: 30000,
      });
      const settled = accept.catch((e) => e);
      await vi.advanceTimersByTimeAsync(200);
      await driver.handlers.STOP();
      await vi.advanceTimersByTimeAsync(200);
      await settled;

      const pending = driver.closeReviewer();
      await vi.advanceTimersByTimeAsync(4000);
      const report = await pending;
      expect(report).toMatchObject({ cancelled: false, closed: false });
      expect(report.notes.at(-1)).toMatch(/WITH A COMPOSED MESSAGE IN IT/);
      // Never sent, whatever else went wrong on the way out.
      expect(report.notes.at(-1)).toMatch(/Nothing was sent/);
      expect(page.state.sentText).toBe(null);
    });

    it('says nothing extra when it left cleanly', async () => {
      start();
      await driver.openReviewer();
      expect((await driver.closeReviewer()).notes).toEqual([]);
    });
  });

  // The census, run with the driver's own two predicates. This is the row that
  // was wrong: judged by the acting predicate the only way out of the reviewer
  // does not exist.
  it('reaches the one Exit control the live page draws at no size', async () => {
    start();
    await driver.openReviewer();
    const scope = page.document.querySelector('[role="dialog"]');
    const acting = driver.usableControls(scope, /^exit$/i);
    const leaving = driver.reachableControls(scope, /^exit$/i);
    // 1 matched by text, 0 usable - exactly what was measured live, and exactly
    // what made teardown decline in silence.
    expect([acting.matching.length, acting.usable.length]).toEqual([1, 0]);
    // The same control, the same page, the question leaving actually asks.
    expect([leaving.matching.length, leaving.usable.length]).toEqual([1, 1]);
    expect(leaving.usable[0].id).toBe('exit');
  });

  it('still refuses a way out the page says is not part of it', async () => {
    // A zero box is a collapsed layout; aria-hidden is the page stating this
    // element is not there. Dropping the box test does not drop that.
    start({ exitAriaHidden: true });
    await driver.openReviewer();
    const report = await driver.closeReviewer();
    expect(report.closed).toBe(false);
    expect(report.notes[0]).toBe('no usable Exit control (1 matched by text)');
    expect(page.state.clicks).toEqual(['View application']);
  });

  it('does not let leaving loosen what acting is allowed to click', async () => {
    // The whole risk of splitting the predicate. Accept is judged by the strict
    // one, and the legend's second exact-`Accept` button is still excluded.
    start();
    await driver.openReviewer();
    const scope = page.document.querySelector('[role="dialog"]');
    expect(driver.usableControls(scope, /^accept$/i).usable.length).toBe(1);
    // Reachable would have found both - which is precisely why the accept path
    // does not ask that question.
    expect(driver.reachableControls(scope, /^accept$/i).usable.length).toBe(2);
    await expect(
      driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('refuses a way out that reads as accept or reject, whatever it is called', async () => {
    // A renamed button, or a page that shifted under the pattern. Teardown is
    // the one path where clicking the wrong thing sends the message it was
    // called to abandon, so it refuses both verbs before clickSafely sees it.
    start();
    await driver.openReviewer();
    const exit = page.document.getElementById('exit');
    exit.setAttribute('aria-label', 'Accept and exit');
    const report = await driver.closeReviewer();
    expect(report.closed).toBe(false);
    expect(report.notes[0]).toMatch(/Refusing to click "Exit Accept and exit" on the way out/);
    expect(page.state.clicks).toEqual(['View application']);
    expect(page.state.sentText).toBe(null);
  });

  it('answers CLOSE_REVIEWER on the wire, and never as a rejection', async () => {
    start();
    const wire = load(page);
    wire.deliver({ source: 'wfx-cs', id: 'c1', type: 'CLOSE_REVIEWER' });
    await vi.advanceTimersByTimeAsync(0);
    const answer = wire.posted.find((m) => m.source === 'wfx-page' && m.id === 'c1');
    expect(answer).toEqual({
      source: 'wfx-page',
      id: 'c1',
      ok: true,
      data: { cancelled: false, closed: true, notes: [] },
    });
  });
});

// --- the budget this driver promises to stay inside ----------------------------

describe('the accept round trip fitting inside the relay budget', () => {
  it('honours no more of a pause than its own stated maximum', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '70000001',
      message: MESSAGE,
      // Far past what the panel samples, which is the point: the bound is this
      // file's promise about how long it may hold the wire, not a request.
      beforePasteMs: 60000,
      afterPasteMs: 60000,
    });
    // The first pause is clamped to 5000, so the message is in the box shortly
    // after that - not sixty seconds later, which is a whole minute past the
    // point the relay would have given up and told the panel the page was quiet
    // while the send was still coming.
    await vi.advanceTimersByTimeAsync(5200);
    expect(page.state.inputValues.at(-1)).toBe(MESSAGE);
    expect(page.state.sentText).toBe(null);
    // And the second to 3000.
    await vi.advanceTimersByTimeAsync(3200);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });

  it('states a worst case that its own constants add up to', async () => {
    start();
    // composer 5000 + before 5000 + after 3000 + confirm 40000 + slack 2000.
    // Named here rather than derived, so a change to any of them has to be a
    // change to this number too - which is what the relay's budget is checked
    // against in tests/bridge.test.js.
    expect(driver.ACCEPT_WORST_CASE_MS).toBe(27000);
  });

  // What the fast path is for: the healthy band, measured at 5-9 s, answered
  // inside the round trip with nothing else involved.
  const landsAfter = (ms) => {
    let rerender;
    start({
      onSendClick: (state) => {
        state.composer = false;
        setTimeout(() => {
          state.queue.shift();
          rerender();
        }, ms);
      },
    });
    rerender = page.render;
  };

  it('confirms a send in the healthy band without anybody else being asked', async () => {
    landsAfter(9000);
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(9500);
    await expect(pending).resolves.toMatchObject({ accepted: true });
  });

  // And what it deliberately no longer tries to do. A 46 s accept is ordinary
  // on a 101-applicant role - measured on freshly reloaded documents, so no
  // constant here could cover it - and the driver says `pending` rather than
  // spending the alarm on it. The panel keeps watching; see the accept pass.
  it('hands a slower one back as pending rather than failing it', async () => {
    landsAfter(46000);
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '70000001', message: MESSAGE });
    await vi.advanceTimersByTimeAsync(13000);
    const result = await pending;
    expect(result).toMatchObject({ accepted: false, pending: true, total: 3 });
    // And it has not clicked anything a second time on the way to saying so.
    expect(page.state.clicks.filter((c) => c.startsWith('Accept application')).length).toBe(1);
  });
});

// --- the wire -----------------------------------------------------------------

describe('the message handlers', () => {
  it('answers the four reviewer types and ignores everything else', async () => {
    start();
    const wire = load(page);
    const answers = () => wire.posted.filter((m) => m.source === 'wfx-page');

    wire.deliver({ source: 'wfx-cs', id: 'a1', type: 'OPEN_REVIEWER' });
    wire.deliver({ source: 'wfx-cs', id: 'a2', type: 'READ_CANDIDATE' });
    await vi.advanceTimersByTimeAsync(0);
    // Looked up by id rather than by position: two requests in flight settle in
    // whatever order their reads finish, which is the bridge's problem to pair
    // up and not something this file should quietly depend on.
    const byId = (id) => wire.posted.find((m) => m.source === 'wfx-page' && m.id === id);
    expect(byId('a1')).toEqual({
      source: 'wfx-page',
      id: 'a1',
      ok: true,
      data: { opened: true, userId: '70000001', index: 1, total: 3 },
    });
    expect(byId('a2')).toEqual({
      source: 'wfx-page',
      id: 'a2',
      ok: true,
      data: { userId: '70000001', index: 1, total: 3 },
    });
    expect(answers().length).toBe(2);

    // Anything else on the wire belongs to collector.js, which shares this
    // window. Answering it would settle the bridge's request with the wrong
    // script's answer.
    wire.deliver({ source: 'wfx-cs', id: 'a3', type: 'FETCH_PAGE' });
    wire.deliver({ source: 'wfx-page', id: 'a4', type: 'READ_CANDIDATE' });
    await vi.advanceTimersByTimeAsync(0);
    expect(answers().length).toBe(2);
  });

  it('reports a refusal as an answer, not as a rejection', async () => {
    start();
    const wire = load(page);
    wire.deliver({
      source: 'wfx-cs',
      id: 'b1',
      type: 'ACCEPT_CANDIDATE',
      payload: { expectedUserId: '70000001', message: 'Hey [first_name]' },
    });
    await vi.advanceTimersByTimeAsync(0);
    const answer = wire.posted.find((m) => m.id === 'b1');
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/unsubstituted token/);
  });
});
