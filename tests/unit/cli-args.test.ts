import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';

describe('parseArgs', () => {
  it('extracts the command as the first positional', () => {
    expect(parseArgs(['inspect']).command).toBe('inspect');
  });
  it('parses --key value', () => {
    expect(parseArgs(['start', '--port', '8788']).flags.port).toBe('8788');
  });
  it('parses --key=value', () => {
    expect(parseArgs(['bench', '--requests=10']).flags.requests).toBe('10');
  });
  it('parses --flag as boolean true', () => {
    expect(parseArgs(['start', '--help']).flags.help).toBe(true);
  });
  it('parses short -k value', () => {
    expect(parseArgs(['bench', '-p', '5']).flags.p).toBe('5');
  });
  it('keeps additional positional arguments', () => {
    expect(parseArgs(['bench', 'first', 'second']).positional).toEqual(['first', 'second']);
  });
  it('returns undefined command on empty argv', () => {
    expect(parseArgs([]).command).toBeUndefined();
  });
});
