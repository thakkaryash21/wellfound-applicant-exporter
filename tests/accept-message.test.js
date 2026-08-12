import { describe, it, expect } from 'vitest';
import { DEFAULT_MESSAGE, composeMessage, TOKENS } from '../src/lib/accept-message.js';

describe('DEFAULT_MESSAGE', () => {
  it('matches the operator-supplied wording byte for byte', () => {
    expect(DEFAULT_MESSAGE).toContain('Hey [first_name],');
    expect(DEFAULT_MESSAGE).toContain(
      'Thanks so much for applying for the [role_name] role, really appreciate you taking the time to apply.'
    );
    expect(DEFAULT_MESSAGE).toContain('We’ve added you to our network');
    expect(DEFAULT_MESSAGE).toContain('We’re helping some of the fastest-growing startups');
    expect(DEFAULT_MESSAGE).toContain('we’d love to connect you');
    expect(DEFAULT_MESSAGE).toContain("We'll be in touch soon, cheers!");
  });
});

describe('composeMessage', () => {
  it('substitutes [first_name] and [role_name]', () => {
    const out = composeMessage({
      template: 'Hey [first_name], re: [role_name].',
      firstName: 'Jane',
      roleName: 'Platform Engineer',
    });
    expect(out).toBe('Hey Jane, re: Platform Engineer.');
  });

  it('drops the name and the stranded space when first name is missing', () => {
    const out = composeMessage({
      template: 'Hey [first_name], welcome.',
      firstName: undefined,
      roleName: 'Engineer',
    });
    expect(out).toBe('Hey, welcome.');
    expect(out).not.toContain('Hey ,');
  });

  it('drops the name for an empty string', () => {
    const out = composeMessage({ template: 'Hey [first_name], hi.', firstName: '', roleName: 'Engineer' });
    expect(out).toBe('Hey, hi.');
  });

  it('drops the name for whitespace-only input', () => {
    const out = composeMessage({ template: 'Hey [first_name], hi.', firstName: '   ', roleName: 'Engineer' });
    expect(out).toBe('Hey, hi.');
  });

  it('composes the real default message with a missing name, never stranding the space', () => {
    const out = composeMessage({ firstName: '', roleName: 'Platform Engineer' });
    expect(out.startsWith('Hey,')).toBe(true);
    expect(out).not.toMatch(/Hey +,/);
  });

  it('throws if a bracket token survives substitution', () => {
    expect(() =>
      composeMessage({ template: 'Hey [first_name], [unknown_token] here.', firstName: 'Jane', roleName: 'Eng' })
    ).toThrow();
  });

  it('does not let a candidate name that looks like a token get re-substituted', () => {
    // If substitution ran in two passes (role first, then first name), the
    // literal text "[role_name]" arriving via firstName would itself be
    // replaced by the second pass. A single combined pass must leave it as
    // plain candidate-supplied text instead.
    const out = composeMessage({
      template: 'Hey [first_name] ([role_name]).',
      firstName: '[role_name]',
      roleName: 'Engineer',
    });
    expect(out).toBe('Hey [role_name] (Engineer).');
  });

  it('is not vulnerable to a candidate name containing a first_name token either', () => {
    const out = composeMessage({
      template: 'Hey [first_name] ([role_name]).',
      firstName: '[first_name]',
      roleName: 'Engineer',
    });
    expect(out).toBe('Hey [first_name] (Engineer).');
  });
});

describe('TOKENS', () => {
  it('maps every bracket token to the record field that resolves it', () => {
    expect(TOKENS.first_name).toBe('firstName');
    expect(TOKENS.role_name).toBe('roleName');
  });
});
