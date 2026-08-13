import { describe, it, expect } from 'vitest';
import { summarize, storableSummary, listNames } from '../src/panel/summary.js';

const done = (overrides = {}) => ({
  type: 'done',
  downloaded: 0,
  failed: 0,
  previewed: 0,
  skippedNoResume: 0,
  skippedNoId: 0,
  masked: 0,
  stoppedBecause: 'finished',
  jobs: [],
  failedNames: [],
  notWalked: [],
  ...overrides,
});

describe('the headline', () => {
  it('names the reason a run stopped before the counts', () => {
    const s = summarize(done({ downloaded: 12, stoppedBecause: 'aborted' }));
    expect(s.headline).toBe('Stopped by you \u00b7 12 downloaded');
  });

  // A4: the running screen counted "38 downloaded - 4 skipped" for twelve
  // minutes and the summary then said "2 with no resume - 2 not identifiable".
  it('counts the run in the same words the running screen used', () => {
    const event = done({ downloaded: 38, skippedNoResume: 2, skippedNoId: 1, masked: 1 });
    expect(summarize(event).headline).toBe('38 downloaded \u00b7 4 skipped');
  });

  it('still names the causes, as a note under the one number', () => {
    const s = summarize(done({ downloaded: 38, skippedNoResume: 2, skippedNoId: 1, masked: 1 }));
    expect(s.notes).toContain(
      'The 4 skipped: 2 with no resume, 1 not identifiable, 1 locked.',
    );
  });
});

// A2: a preview counts nobody into `downloaded` by design, so the summary of a
// preview over 400 people used to read "0 downloaded" and stop there.
describe('a run with downloads off', () => {
  it('says how many it listed', () => {
    const s = summarize(done({ actions: { download: false }, previewed: 400 }));
    expect(s.headline).toBe('0 downloaded \u00b7 400 previewed');
  });

  it('says that nothing was downloaded on purpose, and how to fetch them', () => {
    const s = summarize(done({ actions: { download: false }, previewed: 400 }));
    expect(s.notes[0]).toContain('Preview only');
    expect(s.notes[0]).toContain('these 400 resumes');
  });

  it('says it in the singular for one applicant', () => {
    expect(summarize(done({ actions: { download: false }, previewed: 1 })).notes[0]).toContain('this resume');
  });

  it('says nothing about previewing on a live run', () => {
    const s = summarize(done({ actions: { download: true }, downloaded: 3 }));
    expect(s.notes.join(' ')).not.toContain('Preview only');
  });
});

describe('the notes', () => {
  it('names the role that hit its limit and the number it was asked for', () => {
    const s = summarize(
      done({
        downloaded: 25,
        jobs: [{ jobId: '1', jobTitle: 'Backend', limit: 25, stoppedBecause: 'limit' }],
      }),
    );
    expect(s.notes).toContain(
      'Backend: got the first 25 you asked for. Run again for the rest.',
    );
  });

  it('names a role that stopped early having downloaded nothing', () => {
    const s = summarize(
      done({
        jobs: [
          { jobId: '1', jobTitle: 'Backend', pages: 3, downloaded: 0, stoppedBecause: 'early-stop' },
        ],
      }),
    );
    expect(s.notes.join(' ')).toContain('stopped early after 3 already-downloaded pages');
  });

  // I2: a job that exported nothing said so only through `job_note`, into the
  // live region, which the next event overwrote within seconds and this screen
  // then replaced wholesale. Two roles, one with nothing new, and the summary
  // said "38 downloaded" while the user hunted for a second CSV that was never
  // written, with nothing anywhere saying why.
  describe('a role that produced no CSV', () => {
    it('names the role whose file was never written', () => {
      const s = summarize(
        done({
          downloaded: 38,
          jobs: [
            { jobId: '1', jobTitle: 'Backend', downloaded: 38, pages: 4, wroteCsv: true },
            { jobId: '2', jobTitle: 'Frontend', downloaded: 0, pages: 1, wroteCsv: false },
          ],
        }),
      );
      expect(s.notes).toContain('No CSV for Frontend: that role had no applicants to export.');
    });

    it('names every such role, in the plural', () => {
      const s = summarize(
        done({
          jobs: [
            { jobId: '1', jobTitle: 'Backend', wroteCsv: false },
            { jobId: '2', jobTitle: 'Frontend', wroteCsv: false },
          ],
        }),
      );
      expect(s.notes).toContain(
        'No CSV for Backend, Frontend: those roles had no applicants to export.',
      );
    });

    // A summary stored by an older build has no `wroteCsv` at all. Absent is not
    // false: claiming a file was never written when nothing knows either way is
    // worse than staying quiet.
    it('says nothing when the run did not report either way', () => {
      const s = summarize(done({ jobs: [{ jobId: '1', jobTitle: 'Backend', downloaded: 0 }] }));
      expect(s.notes.join(' ')).not.toContain('No CSV');
    });
  });

  it('names the roles the run never reached', () => {
    expect(summarize(done({ notWalked: ['Backend', 'Frontend'] })).notes).toContain(
      'Never started: Backend, Frontend.',
    );
  });

  it('carries the error and the trace it was handed', () => {
    const trace = [{ t: 0, step: 'run_start' }];
    const s = summarize(done({ stoppedBecause: 'error', error: 'boom' }), trace);
    expect(s.error).toBe('boom');
    expect(s.trace).toBe(trace);
  });
});

describe('listNames', () => {
  it('counts the rest beyond the fifth', () => {
    expect(listNames(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e and 2 more');
  });
});

// A3: naming who failed on screen is the point of the note. Persisting those
// names in chrome.storage.local until the next run overwrites them is not, and
// the trace beside them promises "no names and no links".
describe('what may be written to storage', () => {
  const withNames = () =>
    summarize(done({ downloaded: 1, failed: 2, failedNames: ['Jane Doe', 'John Roe'] }));

  it('names who failed in the summary on screen', () => {
    expect(withNames().notes.join(' ')).toContain('Jane Doe, John Roe');
  });

  it('counts them instead in the copy that is stored', () => {
    const stored = storableSummary(withNames());
    expect(JSON.stringify(stored)).not.toContain('Jane Doe');
    expect(stored.notes.join(' ')).toContain('Could not download 2 applicants');
  });

  it('keeps every other note word for word', () => {
    const s = summarize(done({ notWalked: ['Backend'] }));
    expect(storableSummary(s).notes).toEqual(s.notes);
  });

  it('leaves no scrubbing scaffolding behind in the stored object', () => {
    expect('safeNotes' in storableSummary(withNames())).toBe(false);
  });

  it('says one applicant in the singular', () => {
    const s = summarize(done({ failed: 1, failedNames: ['Jane Doe'] }));
    expect(storableSummary(s).notes.join(' ')).toContain('Could not download 1 applicant.');
  });
});

// The one thrown message that interpolates a signed resume link is
// "Resume link is not a full URL: <link>", and this object is written to
// chrome.storage.local.
describe('a fatal error carrying a URL', () => {
  const withUrl = {
    type: 'done',
    downloaded: 0,
    stoppedBecause: 'error',
    error:
      'Resume link is not a full URL: https://s3.amazonaws.com/attachments/a.pdf?X-Amz-Signature=abc',
  };

  it('is scrubbed of the link before it is anywhere', () => {
    const s = summarize(withUrl);
    expect(s.error).toBe('Resume link is not a full URL: [url]');
    expect(s.error).not.toContain('X-Amz-Signature');
  });

  it('leaves an error with no URL in it alone', () => {
    expect(summarize({ type: 'done', stoppedBecause: 'error', error: 'tab closed' }).error).toBe(
      'tab closed',
    );
  });

  it('is still null when nothing went wrong', () => {
    expect(summarize({ type: 'done', downloaded: 1 }).error).toBe(null);
  });
});

// What the run says about accepting once it is over. Every cause is kept apart
// from every other because they have different remedies, and one of them has
// none at all.
describe('the accept pass, afterwards', () => {
  const accepting = (over = {}) =>
    done({ actions: { download: true, accept: true }, accepted: 0, ...over });

  it('counts the accepted on the headline, beside the downloads', () => {
    const s = summarize(accepting({ downloaded: 12, accepted: 12 }));
    expect(s.headline).toBe('12 downloaded \u00b7 12 accepted');
  });

  it('says the accepts cannot be undone', () => {
    expect(summarize(accepting({ accepted: 12 })).notes.join('\n')).toContain('cannot be undone');
  });

  // The home screen's counts drop, possibly to zero, because the queue drained.
  // Unsaid, that reads as the extension having lost the applicants.
  it('explains why the roles screen will show fewer applicants now', () => {
    const notes = summarize(accepting({ accepted: 12 })).notes.join('\n');
    expect(notes).toContain('lower now, perhaps zero');
    expect(notes).toContain('not lost');
  });

  it('keeps refused, already-accepted and failed apart', () => {
    const notes = summarize(
      accepting({ accepted: 3, acceptRefused: 4, acceptAlready: 5, acceptFailed: 2 }),
    ).notes.join('\n');
    expect(notes).toContain('4 refused: no resume was captured');
    expect(notes).toContain('5 were accepted on an earlier run');
    expect(notes).toContain('2 could not be accepted');
  });

  it('names the role whose accepting stopped short, and by how much', () => {
    const notes = summarize(
      accepting({
        accepted: 3,
        jobs: [
          {
            jobId: '1',
            jobTitle: 'Platform Engineer',
            accepted: 3,
            acceptIntended: 40,
            acceptStoppedBecause: 'aborted',
          },
        ],
      }),
    ).notes.join('\n');
    expect(notes).toContain('Platform Engineer: accepting stopped after 3 of 40');
  });

  // The one outcome that needs the operator's hands. The message may have gone
  // out, nothing was retried, and nothing here can tell which - so it is lifted
  // above the headline rather than left among the notes.
  //
  // Counted per role from the pass's own figure, not inferred from the stop
  // reason: a role can now leave somebody unresolved and still have finished
  // everybody else, which is the whole point of deferring them.
  it('puts an unresolved send above the headline, and names the remedy', () => {
    const s = summarize(
      accepting({
        accepted: 3,
        acceptUnresolved: 1,
        jobs: [
          { jobId: '1', jobTitle: 'Platform Engineer', acceptUnresolved: 1 },
        ],
      }),
    );
    expect(s.alert).toContain('1 accept in Platform Engineer could not be confirmed');
    expect(s.alert).toContain('may have gone out');
    expect(s.alert).toContain('nothing was retried');
    expect(s.alert).toContain('Check them in Wellfound');
  });

  // What the alert can promise, now that a held question is temporary: nothing
  // reaches this person while it stands, and the next run over the role asks
  // about them again rather than leaving them to the operator forever.
  it('says a held question will be asked again rather than left', () => {
    const s = summarize(
      accepting({
        accepted: 3,
        acceptUnresolved: 1,
        jobs: [{ jobId: '1', jobTitle: 'Platform Engineer', acceptUnresolved: 1 }],
      }),
    );
    expect(s.alert).toContain('held rather than counted either way');
    expect(s.alert).toContain('will ask about them again');
  });

  // The contradiction the review found: the alert said the message may or may
  // not have gone out, and the notes below said "Nothing was sent to them"
  // about the same person. Whichever the operator read second, they discounted.
  it('never says nothing was sent about a send nobody can vouch for', () => {
    const s = summarize(
      accepting({
        accepted: 3,
        acceptUnresolved: 1,
        stoppedBecause: 'unclear',
        jobs: [{ jobId: '1', jobTitle: 'Platform Engineer', acceptUnresolved: 1 }],
      }),
    );
    const notes = s.notes.join('\n');
    expect(notes).not.toContain('Nothing was sent to them');
    expect(notes).toContain('could not be confirmed');
    expect(notes).toContain('may have gone out');
    // And the two surfaces agree, because they are now saying one thing.
    expect(s.alert).toContain('may have gone out');
    // A run that stopped there does not open as though it finished.
    expect(s.headline).toContain('Stopped: an accept did not confirm');
  });

  // The certain failures still read as certain: they are the ones the driver
  // refused before the click, and "nothing was sent to them" is true of those.
  // They are now their own count all the way back from the pass, so the note no
  // longer has to subtract one number from another to know which is which.
  it('keeps a certain failure apart from the unresolved one in the same run', () => {
    const notes = summarize(
      accepting({
        accepted: 3,
        acceptFailed: 2,
        acceptUnresolved: 1,
        jobs: [{ jobId: '1', jobTitle: 'Platform Engineer', acceptUnresolved: 1 }],
      }),
    ).notes.join('\n');
    expect(notes).toContain('2 could not be accepted. Nothing was sent to them');
    expect(notes).toContain('running this role again will try them');
    expect(notes).toContain('1 accept could not be confirmed');
  });

  // A message that went out and could not be written down. Neither of the two
  // above: the send is a fact, and the record of it is what failed.
  it('says plainly when a message went out and could not be recorded', () => {
    const s = summarize(
      accepting({
        accepted: 3,
        stoppedBecause: 'unrecorded',
        jobs: [{ jobId: '1', jobTitle: 'Platform Engineer', acceptStoppedBecause: 'unrecorded' }],
      }),
    );
    expect(s.alert).toContain('could not be recorded');
    expect(s.alert).toContain('messaged a second time');
    expect(s.notes.join('\n')).toContain('went out and could not be recorded');
    expect(s.headline).toContain('Stopped: a message was sent and could not be recorded');
  });

  it('has no alert when every accept confirmed', () => {
    expect(summarize(accepting({ accepted: 3 })).alert).toBe(null);
  });

  // A run that never accepted says nothing about accepting at all.
  it('is silent on a run that was not accepting', () => {
    const s = summarize(done({ downloaded: 4, actions: { download: true, accept: false } }));
    expect(s.headline).toBe('4 downloaded');
    expect(s.notes.join('\n')).not.toContain('accepted');
  });

  // Counts and job titles only, so all of it is safe to write to storage.
  it('stores every accept note as it stands', () => {
    const s = summarize(accepting({ accepted: 3, acceptRefused: 1 }));
    expect(storableSummary(s).notes).toEqual(s.safeNotes);
    expect(s.safeNotes.join('\n')).toContain('1 refused');
  });
});
