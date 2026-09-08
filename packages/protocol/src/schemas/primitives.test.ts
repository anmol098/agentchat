import { describe, expect, it } from 'vitest';

import {
  AGENT_NAME_PATTERN,
  AgentNameSchema,
  CountSchema,
  DisplayNameSchema,
  DurationSecondsSchema,
  EmptyRequestSchema,
  EmptyResponseSchema,
  INVITE_CODE_PATTERN,
  InviteCodeSchema,
  OpaqueTokenSchema,
  PROJECT_SLUG_PATTERN,
  ProjectNameSchema,
  ProjectSlugSchema,
  SEMVER_PATTERN_SOURCE,
  SemanticVersionSchema,
  TimestampSchema,
  USERNAME_PATTERN,
  UserCodeSchema,
  UsernameSchema,
} from './primitives.js';

describe('TimestampSchema', () => {
  it('round-trips an ISO 8601 instant in UTC', () => {
    for (const value of [
      '2026-09-08T12:34:56Z',
      '2026-09-08T12:34:56.789Z',
      '2026-09-08T00:00:00.000Z',
    ]) {
      expect(TimestampSchema.parse(value)).toBe(value);
    }
  });

  it('rejects an offset, so one instant has exactly one encoding', () => {
    // Allowing +01:00 would mean two strings for the same moment that no longer
    // compare as strings; see the schema note.
    expect(TimestampSchema.safeParse('2026-09-08T13:34:56+01:00').success).toBe(false);
  });

  it('rejects a date without a time, a local time, and free text', () => {
    for (const value of ['2026-09-08', '2026-09-08T12:34:56', 'yesterday', '']) {
      expect(TimestampSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('SemanticVersionSchema', () => {
  it('round-trips releases and pre-releases', () => {
    for (const value of ['0.1.0', '1.4.0', '10.20.30', '0.1.0-rc.1', '1.0.0+build.5']) {
      expect(SemanticVersionSchema.parse(value)).toBe(value);
    }
  });

  it('rejects a v prefix, a range operator, and a partial version', () => {
    // The CLI prints this verbatim in "Server requires agentchat >= X.Y.Z" and
    // compares against it; a range operator would make that comparison a lie.
    for (const value of ['v1.4.0', '>=1.4.0', '1.4', '1', '1.4.0.0', '']) {
      expect(SemanticVersionSchema.safeParse(value).success).toBe(false);
    }
  });

  it('is built from the exported pattern source, so the two cannot drift', () => {
    const pattern = new RegExp(`^${SEMVER_PATTERN_SOURCE}$`);
    expect(pattern.test('0.1.0')).toBe(true);
    expect(pattern.test('v0.1.0')).toBe(false);
  });
});

describe('AgentNameSchema', () => {
  it('accepts the grammar plan section 2 states', () => {
    for (const value of ['backend', 'a', '0', 'code-reviewer', 'agent-1', 'a'.repeat(32)]) {
      expect(AgentNameSchema.parse(value)).toBe(value);
    }
  });

  it('rejects uppercase, so a name means one thing everywhere', () => {
    for (const value of ['Backend', 'BACKEND', 'backEnd']) {
      expect(AgentNameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects a leading hyphen and an empty name', () => {
    for (const value of ['-backend', '-', '']) {
      expect(AgentNameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects 33 characters and accepts 32', () => {
    expect(AgentNameSchema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(AgentNameSchema.safeParse('a'.repeat(33)).success).toBe(false);
  });

  it('rejects the characters that would make @alice/backend ambiguous', () => {
    for (const value of ['back/end', '@backend', 'back end', 'back_end', 'back.end']) {
      expect(AgentNameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('pins the pattern the plan states verbatim', () => {
    expect(AGENT_NAME_PATTERN.source).toBe('^[a-z0-9][a-z0-9-]{0,31}$');
  });
});

describe('ProjectSlugSchema', () => {
  it('accepts a handle of up to 32 characters', () => {
    for (const value of ['payments', 'payments-platform', 'p', '2026-migration', 'a'.repeat(32)]) {
      expect(ProjectSlugSchema.parse(value)).toBe(value);
    }
  });

  it('rejects uppercase, spaces, a leading hyphen, and 33 characters', () => {
    for (const value of ['Payments', 'payments platform', '-payments', '', 'a'.repeat(33)]) {
      expect(ProjectSlugSchema.safeParse(value).success).toBe(false);
    }
  });

  // The two shapes T-025 narrowed the pattern to exclude. Both used to pass
  // here and be refused by `projects_slug_format`, so a caller who sent one got
  // a constraint violation instead of a validation error — the same defect
  // T-016 fixed for usernames, hit for real by T-107.
  it('rejects a trailing hyphen, which the database has always refused', () => {
    for (const value of ['payments-', 'a-', 'payments-platform-']) {
      expect(ProjectSlugSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects consecutive hyphens, which the database has always refused', () => {
    for (const value of ['a--b', 'payments--platform', 'a---b', '--', 'a--']) {
      expect(ProjectSlugSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects 33 characters and accepts 32, hyphenated or not', () => {
    expect(ProjectSlugSchema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(ProjectSlugSchema.safeParse('a'.repeat(33)).success).toBe(false);
    // The ceiling counts hyphens: 15 pairs plus a trailing `ab` is 32.
    expect(ProjectSlugSchema.safeParse(`${'a-'.repeat(15)}ab`).success).toBe(true);
    expect(ProjectSlugSchema.safeParse(`${'a-'.repeat(16)}ab`).success).toBe(false);
  });

  it('pins its pattern', () => {
    expect(PROJECT_SLUG_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,31}$');
  });

  // T-025 decoupled this from the agent-name grammar: they were equal only
  // because the slug was modelled on the name before anybody wrote a slug rule
  // down, and they answer to different database constraints. What the old
  // coupling was worth is kept as an invariant instead of as an equality —
  // every slug is still a valid agent name, so the looser of the two never
  // surprises somebody who learned the stricter one.
  it('accepts a strict subset of the agent-name grammar', () => {
    expect(PROJECT_SLUG_PATTERN.source).not.toBe(AGENT_NAME_PATTERN.source);

    const alphabet = ['a', '9', '-'];
    let candidates = [''];
    for (let length = 1; length <= 5; length += 1) {
      candidates = candidates.flatMap((prefix) => alphabet.map((char) => prefix + char));
      for (const candidate of candidates) {
        if (PROJECT_SLUG_PATTERN.test(candidate)) {
          expect({ candidate, isAgentName: AGENT_NAME_PATTERN.test(candidate) }).toEqual({
            candidate,
            isAgentName: true,
          });
        }
      }
    }

    // And strictly: the shapes an agent name allows that a slug no longer does.
    for (const value of ['backend--api', 'backend-']) {
      expect(AGENT_NAME_PATTERN.test(value)).toBe(true);
      expect(PROJECT_SLUG_PATTERN.test(value)).toBe(false);
    }
  });

  // The database states the same grammar a different way — `^[a-z0-9]+(-[a-z0-9]+)*$`
  // with a separate `char_length(...) <= 64` — because a CHECK constraint is
  // compiled into the database when the migration runs and cannot import this
  // constant. Two spellings of one grammar is how the two drifted apart in the
  // first place, so the containment is asserted rather than argued.
  //
  // Note this is containment, not equality, and deliberately so: the caps
  // differ (32 here against the column's 64), and the direction that matters is
  // that everything the protocol accepts the database will store.
  it('accepts only what the database CHECK constraint accepts', () => {
    const databaseGrammar = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const databaseLengthCap = 64;
    const alphabet = ['a', '9', '-'];

    let candidates = [''];
    for (let length = 1; length <= 5; length += 1) {
      candidates = candidates.flatMap((prefix) => alphabet.map((char) => prefix + char));
      for (const candidate of candidates) {
        if (!PROJECT_SLUG_PATTERN.test(candidate)) continue;
        expect({ candidate, storable: true }).toEqual({
          candidate,
          storable: databaseGrammar.test(candidate) && candidate.length <= databaseLengthCap,
        });
      }
    }

    // Exhaustive enumeration stops well short of either ceiling, so the
    // boundary is checked separately. 32 is inside the column's 64 by
    // construction; what is worth pinning is that the protocol stops first.
    expect(PROJECT_SLUG_PATTERN.test('a'.repeat(32))).toBe(true);
    expect(PROJECT_SLUG_PATTERN.test('a'.repeat(33))).toBe(false);
    for (const value of ['a'.repeat(33), 'a'.repeat(64)]) {
      expect(databaseGrammar.test(value) && value.length <= databaseLengthCap).toBe(true);
    }
  });
});

describe('UsernameSchema', () => {
  it('accepts a lowercase login of up to 39 characters', () => {
    for (const value of ['alice', 'a', 'anmol098', 'some-user', 'a-b-1', 'a'.repeat(39)]) {
      expect(UsernameSchema.parse(value)).toBe(value);
    }
  });

  it('rejects anything that would make a handle ambiguous', () => {
    for (const value of ['Alice', 'alice/bob', '@alice', 'alice bob', '', 'a'.repeat(40)]) {
      expect(UsernameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects a leading hyphen', () => {
    for (const value of ['-alice', '-', '-a']) {
      expect(UsernameSchema.safeParse(value).success).toBe(false);
    }
  });

  // The two shapes T-016 narrowed the pattern to exclude. Both used to pass
  // here and be refused by `users_username_format`, so a client that sent one
  // got a constraint violation instead of a validation error.
  it('rejects a trailing hyphen, which the database has always refused', () => {
    for (const value of ['alice-', 'a-', 'alice-bob-']) {
      expect(UsernameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects consecutive hyphens, which the database has always refused', () => {
    for (const value of ['alice--bob', 'a--b', 'a---b', '--', 'a--']) {
      expect(UsernameSchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects 40 characters and accepts 39, hyphenated or not', () => {
    expect(UsernameSchema.safeParse('a'.repeat(39)).success).toBe(true);
    expect(UsernameSchema.safeParse('a'.repeat(40)).success).toBe(false);
    // The length ceiling counts hyphens: 19 pairs plus a trailing `a` is 39.
    expect(UsernameSchema.safeParse(`${'a-'.repeat(19)}a`).success).toBe(true);
    expect(UsernameSchema.safeParse(`${'a-'.repeat(20)}a`).success).toBe(false);
  });

  it('pins its pattern', () => {
    expect(USERNAME_PATTERN.source).toBe('^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$');
  });

  // The database states the same grammar a different way — `^[a-z0-9]+(-[a-z0-9]+)*$`
  // with a separate `char_length(...) <= 39` — because a CHECK constraint is
  // compiled into the database when the migration runs and cannot import this
  // constant (see the module note in `server/src/db/schema/identity.ts`). Two
  // spellings of one grammar is exactly how the two drifted apart in the first
  // place, so the equivalence is asserted rather than argued: every string over
  // the alphabet that matters, up to a length where every interesting shape
  // (leading, trailing, doubled and tripled hyphens) has already appeared.
  it('accepts exactly what the database CHECK constraint accepts', () => {
    const databaseGrammar = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    const databaseLengthCap = 39;
    const alphabet = ['a', '9', '-'];

    let candidates = [''];
    for (let length = 1; length <= 5; length += 1) {
      candidates = candidates.flatMap((prefix) => alphabet.map((char) => prefix + char));
      for (const candidate of candidates) {
        const database = databaseGrammar.test(candidate) && candidate.length <= databaseLengthCap;
        expect({ candidate, accepted: USERNAME_PATTERN.test(candidate) }).toEqual({
          candidate,
          accepted: database,
        });
      }
    }

    // Exhaustive enumeration stops well short of the length ceiling, so the
    // boundary is checked separately: the two spellings must also agree about
    // where 39 characters ends.
    for (const value of ['a'.repeat(39), 'a'.repeat(40), `${'a-'.repeat(19)}a`]) {
      const database = databaseGrammar.test(value) && value.length <= databaseLengthCap;
      expect(USERNAME_PATTERN.test(value)).toBe(database);
    }
  });
});

describe('ProjectNameSchema', () => {
  it('round-trips free text within the bound', () => {
    for (const value of ['Payments Platform', 'x', 'a'.repeat(100)]) {
      expect(ProjectNameSchema.parse(value)).toBe(value);
    }
  });

  it('rejects an empty name and one past the bound', () => {
    expect(ProjectNameSchema.safeParse('').success).toBe(false);
    expect(ProjectNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
  });
});

describe('DisplayNameSchema', () => {
  it('round-trips free text, including non-ASCII', () => {
    for (const value of ['Alice', 'Ana Lúcia', '张伟']) {
      expect(DisplayNameSchema.parse(value)).toBe(value);
    }
  });

  it('rejects an empty display name', () => {
    expect(DisplayNameSchema.safeParse('').success).toBe(false);
  });
});

describe('InviteCodeSchema', () => {
  it('accepts the shape the plan uses as an example', () => {
    expect(InviteCodeSchema.parse('ANET-7K4M-Q2P9')).toBe('ANET-7K4M-Q2P9');
  });

  it('does not freeze that example as the format', () => {
    // Plan section 2 says "e.g.", so minting is the server's business. The
    // protocol only guarantees the code survives a URL path segment.
    for (const value of ['abc', 'A1', '0123456789', 'a-b-c-d-e-f']) {
      expect(InviteCodeSchema.parse(value)).toBe(value);
    }
  });

  it('rejects what a path segment cannot carry safely', () => {
    for (const value of ['', 'ANET/7K4M', 'ANET 7K4M', 'ANET?x=1', '../etc', 'a'.repeat(65)]) {
      expect(InviteCodeSchema.safeParse(value).success).toBe(false);
    }
  });

  it('pins its pattern', () => {
    expect(INVITE_CODE_PATTERN.source).toBe('^[A-Za-z0-9-]{1,64}$');
  });
});

describe('OpaqueTokenSchema', () => {
  it('accepts a JWT-shaped token and an opaque random one alike', () => {
    for (const value of ['header.payload.signature', 'deadbeef'.repeat(8), 'x']) {
      expect(OpaqueTokenSchema.parse(value)).toBe(value);
    }
  });

  it('rejects an empty token and an unbounded one', () => {
    expect(OpaqueTokenSchema.safeParse('').success).toBe(false);
    expect(OpaqueTokenSchema.safeParse('a'.repeat(4097)).success).toBe(false);
  });
});

describe('UserCodeSchema', () => {
  it('round-trips the code a user types in the browser', () => {
    expect(UserCodeSchema.parse('ABCD-1234')).toBe('ABCD-1234');
  });

  it('rejects an empty code', () => {
    expect(UserCodeSchema.safeParse('').success).toBe(false);
  });
});

describe('DurationSecondsSchema', () => {
  it('accepts a positive whole number of seconds', () => {
    expect(DurationSecondsSchema.parse(5)).toBe(5);
    expect(DurationSecondsSchema.parse(900)).toBe(900);
  });

  it('rejects zero, negatives, fractions, and numeric strings', () => {
    for (const value of [0, -1, 1.5, '5', Number.NaN]) {
      expect(DurationSecondsSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('CountSchema', () => {
  it('accepts zero, because an agent with no sessions is a normal answer', () => {
    expect(CountSchema.parse(0)).toBe(0);
    expect(CountSchema.parse(3)).toBe(3);
  });

  it('rejects negatives and fractions', () => {
    for (const value of [-1, 0.5]) {
      expect(CountSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('EmptyRequestSchema and EmptyResponseSchema', () => {
  it('round-trip an empty object', () => {
    expect(EmptyRequestSchema.parse({})).toStrictEqual({});
    expect(EmptyResponseSchema.parse({})).toStrictEqual({});
  });

  it('strip unknown properties instead of rejecting them', () => {
    // This is what makes adding a field additive under plan section 12.4: an
    // older peer drops what it does not know rather than failing.
    expect(EmptyResponseSchema.parse({ addedInAFutureRelease: true })).toStrictEqual({});
  });

  it('reject a non-object body', () => {
    for (const value of [null, undefined, 'x', 1, []]) {
      expect(EmptyRequestSchema.safeParse(value).success).toBe(false);
    }
  });
});
