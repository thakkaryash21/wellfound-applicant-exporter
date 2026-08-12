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
    queue: options.queue ?? ['21527289', '21373701', '21200000'],
    index: 1,
    open: false,
    composer: false,
    clicks: [],
    keys: [],
    sentText: null,
    rejected: false,
    focused: false,
    pasted: [],
    inputs: 0,
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
        '<button id="send">Accept application &amp; send message</button>'
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
          // The keyboard-shortcut legend. On the real page a query for buttons
          // whose text is exactly `Accept` returns this as well as the action
          // button; here it is markup rather than a control, which is the half
          // of the disambiguation this harness can honestly represent. The
          // visibility half gets its own test below.
          '<div class="legend"><kbd>A</kbd><span>Accept</span></div>' +
          (options.extraMarkup ?? '') +
          composer +
          '</div>'
        : '');
    wire();
  }

  function wire() {
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
      state.composer = true;
      render();
    });
    document.getElementById('reject')?.addEventListener('click', () => {
      state.rejected = true;
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
    // The composer, watched the way a page watches its own field: what got
    // focus, what was pasted into it, and what it was told about afterwards.
    const box = document.getElementById('msg');
    if (box) {
      // A composer that silently keeps nothing, which is the one failure that
      // would otherwise send an empty message to a real person.
      if (options.deafComposer) {
        Object.defineProperty(box, '_value', { get: () => '', set() {}, configurable: true });
      }
      box.focus = () => {
        state.focused = true;
        state.order.push('focus');
      };
      box.addEventListener('paste', (event) => {
        state.order.push('paste');
        state.pasted.push(event.clipboardData?.getData('text/plain'));
      });
      box.addEventListener('input', () => {
        state.order.push('input');
        state.inputs += 1;
      });
    }
    document.getElementById('send')?.addEventListener('click', () => {
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
  return { dom, document, state, render, currentId };
}

class FakeKeyboardEvent {
  constructor(type, init) {
    this.type = type;
    this.key = init?.key;
  }
}

class FakeEvent {
  constructor(type) {
    this.type = type;
  }
}

class FakeDataTransfer {
  constructor() {
    this.data = new Map();
  }

  setData(type, value) {
    this.data.set(type, String(value));
  }

  getData(type) {
    return this.data.get(type) ?? '';
  }
}

class FakeClipboardEvent {
  constructor(type, init) {
    this.type = type;
    this.clipboardData = init?.clipboardData ?? null;
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

// `clipboard: false` is the browser that has no ClipboardEvent or DataTransfer.
// The paste is decoration; the value must land regardless.
function load(page, { clipboard = true } = {}) {
  const fakeWindow = createFakeWindow();
  const { exposed } = loadClassicScript('src/content/reviewer.js', {
    globals: {
      window: fakeWindow.window,
      document: page.document,
      KeyboardEvent: FakeKeyboardEvent,
      Event: FakeEvent,
      HTMLTextAreaElement: FakeHTMLTextAreaElement,
      ...(clipboard ? { ClipboardEvent: FakeClipboardEvent, DataTransfer: FakeDataTransfer } : {}),
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
    expect(at).toEqual({ opened: true, userId: '21527289', index: 1, total: 3 });
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
    expect(driver.readCurrent()).toEqual({ userId: '21527289', index: 1, total: 3 });
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
  it('types the message, sends once, and confirms by the bucket draining', async () => {
    start();
    await driver.openReviewer();
    const result = await driver.acceptCurrent({
      expectedUserId: '21527289',
      message: MESSAGE,
    });

    expect(page.state.sentText).toBe(MESSAGE);
    expect(page.state.clicks).toEqual([
      'View application',
      'Accept',
      'Accept application & send message',
    ]);
    // Confirming auto-advances: the next person is already at index 1 and the
    // denominator dropped. A caller that pressed Next after this would skip
    // somebody, so the driver reports the new position rather than moving.
    expect(result).toEqual({
      userId: '21527289',
      accepted: true,
      next: { userId: '21373701', index: 1, total: 2 },
    });
    expect(page.state.keys).toEqual([]);
  });

  it('refuses when the reviewer is showing somebody else', async () => {
    start();
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '21373701', message: MESSAGE }),
    ).rejects.toThrow(/showing 21527289, not 21373701/);
    expect(page.state.clicks).toEqual(['View application']);
  });

  it('refuses without an expected id at all', async () => {
    start();
    await driver.openReviewer();
    await expect(driver.acceptCurrent({ message: MESSAGE })).rejects.toThrow(/expected candidate/i);
  });
});

// --- how the message goes in --------------------------------------------------

// Every letter the reviewer binds a shortcut to, at document level: `a` is
// Accept, `r` is Reject, `x` is Quick Reject. The real message is full of all
// three, which is the reason the entry is a paste and not a typing simulation.
const RISKY_MESSAGE = 'Hey Amara,\n\nRegarding your excellent application - warm regards!';

describe('entering the message', () => {
  it('dispatches no key event of any kind, whatever the message contains', async () => {
    start();
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '21527289', message: RISKY_MESSAGE });
    // Not "no key that rejects" - no key at all. Typing this message out would
    // have pressed `a`, `r` and `x` dozens of times against a page that binds
    // all three, and the only thing standing between that and a rejected
    // candidate would be a measurement continuing to hold.
    expect(page.state.keys).toEqual([]);
    expect(page.state.rejected).toBe(false);
    expect(page.state.sentText).toBe(RISKY_MESSAGE);
  });

  it('focuses, pastes, sets the value through the prototype setter, then says input', async () => {
    start();
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE });
    // The order a browser does a paste in. Focus first because a real paste
    // needs it; input last because that is what React reads the value on.
    expect(page.state.order).toEqual(['focus', 'paste', 'input']);
    expect(page.state.pasted).toEqual([MESSAGE]);
    expect(page.state.inputs).toBe(1);
    // The value went in through HTMLTextAreaElement's own setter, which is the
    // step that leaves React holding the message rather than just the DOM node.
    expect(page.state.viaPrototypeSetter).toBe(true);
  });

  it('still lands the value where the browser has no ClipboardEvent', async () => {
    start(undefined, { clipboard: false });
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE });
    expect(page.state.pasted).toEqual([]);
    // The paste is decoration. Skipping it must not cost the send.
    expect(page.state.sentText).toBe(MESSAGE);
    expect(page.state.order).toEqual(['focus', 'input']);
  });

  it('refuses to send when the text cannot be read back off the element', async () => {
    start({ deafComposer: true });
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
    ).rejects.toThrow(/did not reach the composer/);
    expect(page.state.sentText).toBe(null);
  });
});

describe('the pauses either side of the paste', () => {
  const PAUSES = { beforePasteMs: 3000, afterPasteMs: 2000 };

  it('waits before pasting and again before sending, honouring what it was handed', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '21527289',
      message: MESSAGE,
      ...PAUSES,
    });

    // The composer is open and empty: the operator is gathering their thoughts.
    await vi.advanceTimersByTimeAsync(2900);
    expect(page.state.pasted).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    expect(page.state.pasted).toEqual([MESSAGE]);
    // Pasted, but not sent: this is the glance over it before committing.
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
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('feels a stop inside the pause rather than after it, and does not send', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '21527289',
      message: MESSAGE,
      beforePasteMs: 1000,
      afterPasteMs: 30000,
    });
    const settled = expect(pending).rejects.toThrow(/Stopped before the message was sent/);
    await vi.advanceTimersByTimeAsync(1500);
    expect(page.state.pasted).toEqual([MESSAGE]);

    await driver.handlers.STOP();
    // One slice, not the remaining twenty-nine seconds. An operator who presses
    // stop is not asked to wait out a pause they interrupted.
    await vi.advanceTimersByTimeAsync(200);
    await settled;
    expect(page.state.sentText).toBe(null);
    expect(page.state.clicks).not.toContain('Accept application & send message');
    // Nothing went out, so this candidate is not burned: the never-retry guard
    // is about messages that may have been delivered, not about attempts.
    expect(driver.sent.has('21527289')).toBe(false);
  });

  it('stops during the first pause without entering anything at all', async () => {
    start();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '21527289',
      message: MESSAGE,
      beforePasteMs: 30000,
    });
    const settled = expect(pending).rejects.toThrow(/Stopped before the message was entered/);
    await vi.advanceTimersByTimeAsync(300);
    await driver.handlers.STOP();
    await vi.advanceTimersByTimeAsync(200);
    await settled;
    expect(page.state.pasted).toEqual([]);
  });

  it('clears an earlier stop when the reviewer is opened for a new pass', async () => {
    start();
    await driver.openReviewer();
    await driver.handlers.STOP();
    await driver.openReviewer();
    const pending = driver.acceptCurrent({
      expectedUserId: '21527289',
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
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
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
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
    ).rejects.toThrow(/moved to 21373701 before the send; nothing was sent/);
    expect(page.state.sentText).toBe(null);
    expect(page.state.clicks).not.toContain('Accept application & send message');
  });
});

// --- guard: exactly one match -------------------------------------------------

describe('the exactly-one-control guard', () => {
  it('ignores a shortcut legend that is not a control', async () => {
    start();
    await driver.openReviewer();
    // The legend reads `Accept` too. Role is what separates them.
    await expect(
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('ignores a matching control the page is not showing', async () => {
    start({ extraMarkup: '<div role="button" id="ghost">Accept</div>' });
    await driver.openReviewer();
    page.document.getElementById('ghost').rect = { width: 0, height: 0 };
    await expect(
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
    ).resolves.toMatchObject({ accepted: true });
  });

  it('aborts when two visible, enabled controls match', async () => {
    start({ extraMarkup: '<div role="button">Accept</div>' });
    await driver.openReviewer();
    await expect(
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
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
        expectedUserId: '21527289',
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
      driver.acceptCurrent({ expectedUserId: '21527289', message: '   ' }),
    ).rejects.toThrow(/empty message/);
    expect(page.state.clicks).toEqual(['View application']);
  });
});

// --- guard: never retry a send ------------------------------------------------

describe('the never-retry guard', () => {
  it('refuses a second accept for a candidate it has already sent to', async () => {
    start();
    await driver.openReviewer();
    await driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE });
    // The reviewer has moved on, but even if the caller put them back, the
    // answer is the same: a retried accept is a second message to somebody who
    // already received one.
    page.state.queue.unshift('21527289');
    page.render();
    await expect(
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
    ).rejects.toThrow(/Already sent an accept to 21527289/);
    expect(page.state.clicks.filter((c) => c.startsWith('Accept application')).length).toBe(1);
  });

  it('refuses a retry after an unconfirmed send, which is when the temptation is real', async () => {
    // The send click lands but nothing happens: the outcome is unknown, and the
    // message may well have gone.
    start({ onSendClick: () => {} });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE });
    const settled = expect(pending).rejects.toThrow(/Could not confirm the accept for 21527289/);
    await vi.advanceTimersByTimeAsync(15000);
    await settled;
    await expect(
      driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE }),
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
    const pending = driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE });
    const settled = expect(pending).rejects.toThrow(/may or may not have been sent/);
    await vi.advanceTimersByTimeAsync(15000);
    await settled;
  });

  it('does not accept a drained bucket alone as proof - the candidate must change', async () => {
    start({
      onSendClick: (state) => {
        state.queue.splice(1, 1);
        state.composer = false;
      },
    });
    await driver.openReviewer();
    const pending = driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE });
    const settled = expect(pending).rejects.toThrow(/Nothing was retried/);
    await vi.advanceTimersByTimeAsync(15000);
    await settled;
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
    const pending = driver.acceptCurrent({ expectedUserId: '21527289', message: MESSAGE });
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
    expect(next).toEqual({ userId: '21373701', index: 2, total: 3 });
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
    await vi.advanceTimersByTimeAsync(15000);
    await settled;
  });

  it('reports rather than hanging when the reviewer does not move', async () => {
    start({ queue: ['21527289'] });
    await driver.openReviewer();
    const pending = driver.skipCurrent();
    const settled = expect(pending).rejects.toThrow(/did not move on to the next candidate/);
    await vi.advanceTimersByTimeAsync(15000);
    await settled;
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
      data: { opened: true, userId: '21527289', index: 1, total: 3 },
    });
    expect(byId('a2')).toEqual({
      source: 'wfx-page',
      id: 'a2',
      ok: true,
      data: { userId: '21527289', index: 1, total: 3 },
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
      payload: { expectedUserId: '21527289', message: 'Hey [first_name]' },
    });
    await vi.advanceTimersByTimeAsync(0);
    const answer = wire.posted.find((m) => m.id === 'b1');
    expect(answer.ok).toBe(false);
    expect(answer.error).toMatch(/unsubstituted token/);
  });
});
