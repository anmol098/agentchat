/**
 * The permission matrix, tested as a decision table.
 *
 * `authorization.ts` splits each rule into a pure decision over a small bag of
 * facts and a query that gathers them. This suite is about the decisions: it
 * can enumerate every combination of facts, including the ones that are awkward
 * to arrange in a database — an agent whose owner left the project between the
 * send and the check, for instance — and it runs in milliseconds, so the
 * negative cases can be exhaustive rather than representative.
 *
 * `./authorization.integration.test.ts` covers the other half: that the queries
 * actually gather the facts these rules are decided on.
 *
 * Two properties are asserted over the *whole* fact space rather than for named
 * scenarios, because they are the claims the module makes about itself and a
 * counterexample anywhere breaks them:
 *
 *  - a caller who is not a member of the project learns nothing but `NOT_FOUND`;
 *  - a soft-deleted agent passes no rule at all.
 */

import { ErrorCode } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS_BY_ERROR_CODE } from '../errors.js';
import {
  AGENT_FAILURE_MESSAGES,
  type AgentFacts,
  type AgentInProjectFacts,
  agentInProjectFailureCode,
  agentOwnershipFailureCode,
  ownAgentInProjectFailureCode,
  PROJECT_FAILURE_MESSAGES,
  projectFailureCode,
  projectLeaveFailureCode,
} from './authorization.js';

/** Every combination of the three facts an ownership decision reads. */
function everyAgentFacts(): AgentFacts[] {
  const combinations: AgentFacts[] = [];
  for (const exists of [true, false]) {
    for (const ownedByCaller of [true, false]) {
      for (const deleted of [true, false]) {
        combinations.push({ exists, ownedByCaller, deleted });
      }
    }
  }
  return combinations;
}

/** Every combination of the six facts a project-scoped agent decision reads. */
function everyAgentInProjectFacts(): AgentInProjectFacts[] {
  const combinations: AgentInProjectFacts[] = [];
  for (const base of everyAgentFacts()) {
    for (const callerIsProjectMember of [true, false]) {
      for (const participates of [true, false]) {
        for (const ownerIsProjectMember of [true, false]) {
          combinations.push({
            ...base,
            callerIsProjectMember,
            participates,
            ownerIsProjectMember,
          });
        }
      }
    }
  }
  return combinations;
}

/** The two project-scoped rules, so a property can be asserted about both. */
const PROJECT_SCOPED_AGENT_RULES = [
  { name: 'assertAgentInProject', decide: agentInProjectFailureCode },
  { name: 'assertOwnAgentInProject', decide: ownAgentInProjectFailureCode },
] as const;

describe('project membership', () => {
  it('admits a member', () => {
    expect(projectFailureCode({ role: 'member' }, 'member')).toBeUndefined();
    expect(projectFailureCode({ role: 'owner' }, 'member')).toBeUndefined();
  });

  it('answers NOT_FOUND to a non-member rather than FORBIDDEN', () => {
    // The whole point of the rule. FORBIDDEN would confirm the project id.
    expect(projectFailureCode({ role: undefined }, 'member')).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('project ownership', () => {
  it('admits an owner', () => {
    expect(projectFailureCode({ role: 'owner' }, 'owner')).toBeUndefined();
  });

  it('answers FORBIDDEN to a member, who already knows the project exists', () => {
    expect(projectFailureCode({ role: 'member' }, 'owner')).toBe(ErrorCode.FORBIDDEN);
  });

  it('answers NOT_FOUND to a non-member, who does not', () => {
    // Same input to both rules, two different codes: the owner-only rule must
    // not become a way to probe for projects the caller is not in.
    expect(projectFailureCode({ role: undefined }, 'owner')).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('leaving a project', () => {
  it('lets an ordinary member leave, whoever else is left', () => {
    expect(projectLeaveFailureCode({ role: 'member', ownerCount: 1 })).toBeUndefined();
  });

  it('lets an owner leave while another owner remains', () => {
    expect(projectLeaveFailureCode({ role: 'owner', ownerCount: 2 })).toBeUndefined();
  });

  it('refuses the last owner with CONFLICT, not FORBIDDEN', () => {
    // Not a permissions failure: the caller may leave projects in general. It
    // is a state the project may not be put into — an ownerless project can
    // never be renamed or deleted again.
    expect(projectLeaveFailureCode({ role: 'owner', ownerCount: 1 })).toBe(ErrorCode.CONFLICT);
  });

  it('refuses a non-member with NOT_FOUND', () => {
    expect(projectLeaveFailureCode({ role: undefined, ownerCount: 3 })).toBe(ErrorCode.NOT_FOUND);
  });
});

describe('agent ownership', () => {
  it('admits the owner of a live agent', () => {
    expect(
      agentOwnershipFailureCode({ exists: true, ownedByCaller: true, deleted: false }),
    ).toBeUndefined();
  });

  it('refuses an agent that does not exist', () => {
    expect(agentOwnershipFailureCode({ exists: false, ownedByCaller: false, deleted: false })).toBe(
      ErrorCode.NOT_FOUND,
    );
  });

  it("gives somebody else's agent the same answer as one that never existed", () => {
    // Byte-identical answers, so the route cannot be used to test whether an
    // agent id is real.
    const stranger = agentOwnershipFailureCode({
      exists: true,
      ownedByCaller: false,
      deleted: false,
    });
    const missing = agentOwnershipFailureCode({
      exists: false,
      ownedByCaller: false,
      deleted: false,
    });

    expect(stranger).toBe(ErrorCode.NOT_FOUND);
    expect(stranger).toBe(missing);
  });

  it("refuses a stranger's deleted agent without admitting it was deleted", () => {
    expect(agentOwnershipFailureCode({ exists: true, ownedByCaller: false, deleted: true })).toBe(
      ErrorCode.NOT_FOUND,
    );
  });

  it('tells an owner their own agent is deleted, because their id is merely stale', () => {
    expect(agentOwnershipFailureCode({ exists: true, ownedByCaller: true, deleted: true })).toBe(
      ErrorCode.AGENT_DELETED,
    );
  });
});

describe('addressing an agent in a project', () => {
  /** A live agent of a co-member, participating in the project. */
  const addressable: AgentInProjectFacts = {
    exists: true,
    ownedByCaller: false,
    deleted: false,
    callerIsProjectMember: true,
    participates: true,
    ownerIsProjectMember: true,
  };

  it("admits a co-member's participating agent", () => {
    expect(agentInProjectFailureCode(addressable)).toBeUndefined();
  });

  it('admits the caller’s own participating agent', () => {
    expect(agentInProjectFailureCode({ ...addressable, ownedByCaller: true })).toBeUndefined();
  });

  it('refuses a caller who is not in the project, before reading the agent', () => {
    expect(agentInProjectFailureCode({ ...addressable, callerIsProjectMember: false })).toBe(
      ErrorCode.NOT_FOUND,
    );
  });

  it('offers the join remedy for the caller’s own agent that is outside the project', () => {
    expect(
      agentInProjectFailureCode({
        ...addressable,
        ownedByCaller: true,
        participates: false,
      }),
    ).toBe(ErrorCode.AGENT_NOT_IN_PROJECT);
  });

  it('offers it for a co-member’s agent, whose existence the caller could already see', () => {
    expect(agentInProjectFailureCode({ ...addressable, participates: false })).toBe(
      ErrorCode.AGENT_NOT_IN_PROJECT,
    );
  });

  it('hides a stranger’s agent instead, since the caller could not have seen it', () => {
    // The owner is in no project with the caller. AGENT_NOT_IN_PROJECT here
    // would confirm that `agt_...` belongs to a live agent somewhere on the
    // server, and its remedy — `agentchat agent join` — is not one the caller
    // could carry out anyway.
    expect(
      agentInProjectFailureCode({
        ...addressable,
        participates: false,
        ownerIsProjectMember: false,
      }),
    ).toBe(ErrorCode.NOT_FOUND);
  });

  it('reports the caller’s own deleted agent as deleted', () => {
    expect(
      agentInProjectFailureCode({
        ...addressable,
        ownedByCaller: true,
        deleted: true,
        participates: false,
      }),
    ).toBe(ErrorCode.AGENT_DELETED);
  });

  it('reports somebody else’s deleted agent as missing', () => {
    // Soft deletion removes the agent_projects rows, so after the fact nothing
    // proves this caller was ever entitled to know the agent existed.
    expect(agentInProjectFailureCode({ ...addressable, deleted: true, participates: false })).toBe(
      ErrorCode.NOT_FOUND,
    );
  });
});

describe('acting as an agent in a project', () => {
  /** The caller's own live agent, participating in a project they are in. */
  const sender: AgentInProjectFacts = {
    exists: true,
    ownedByCaller: true,
    deleted: false,
    callerIsProjectMember: true,
    participates: true,
    ownerIsProjectMember: true,
  };

  it('admits an owned, live, participating agent', () => {
    expect(ownAgentInProjectFailureCode(sender)).toBeUndefined();
  });

  it('refuses an agent the caller does not own, even when it is in the project', () => {
    // Owning an agent and that agent being in a project are two facts, and
    // neither implies the other. This is the one that would let a member send
    // as a colleague's agent if the rule only checked participation.
    expect(ownAgentInProjectFailureCode({ ...sender, ownedByCaller: false })).toBe(
      ErrorCode.NOT_FOUND,
    );
  });

  it('refuses an owned agent that is not in the project', () => {
    expect(ownAgentInProjectFailureCode({ ...sender, participates: false })).toBe(
      ErrorCode.AGENT_NOT_IN_PROJECT,
    );
  });

  it('refuses an owned, participating agent when the caller left the project', () => {
    expect(ownAgentInProjectFailureCode({ ...sender, callerIsProjectMember: false })).toBe(
      ErrorCode.NOT_FOUND,
    );
  });

  it('refuses a soft-deleted agent the caller owns', () => {
    expect(ownAgentInProjectFailureCode({ ...sender, deleted: true })).toBe(
      ErrorCode.AGENT_DELETED,
    );
  });
});

describe('properties over the whole fact space', () => {
  it('tells a caller outside the project nothing but NOT_FOUND', () => {
    const leaks = everyAgentInProjectFacts()
      .filter((facts) => !facts.callerIsProjectMember)
      .flatMap((facts) =>
        PROJECT_SCOPED_AGENT_RULES.filter(
          ({ decide }) => decide(facts) !== ErrorCode.NOT_FOUND,
        ).map(({ name }) => ({ rule: name, facts })),
      );

    expect(leaks).toEqual([]);
  });

  it('lets no soft-deleted agent pass any rule', () => {
    const passed = everyAgentInProjectFacts()
      .filter((facts) => facts.exists && facts.deleted)
      .flatMap((facts) => {
        const rules = PROJECT_SCOPED_AGENT_RULES.filter(
          ({ decide }) => decide(facts) === undefined,
        );
        const ownership =
          agentOwnershipFailureCode(facts) === undefined
            ? [{ rule: 'assertAgentOwner', facts }]
            : [];
        return [...rules.map(({ name }) => ({ rule: name, facts })), ...ownership];
      });

    expect(passed).toEqual([]);
  });

  it('never answers an agent rule with a code outside its declared set', () => {
    const declared = new Set(Object.keys(AGENT_FAILURE_MESSAGES));
    const unexpected = everyAgentInProjectFacts().flatMap((facts) =>
      [
        ...PROJECT_SCOPED_AGENT_RULES.map(({ decide }) => decide(facts)),
        agentOwnershipFailureCode(facts),
      ].filter((code) => code !== undefined && !declared.has(code)),
    );

    expect(unexpected).toEqual([]);
  });
});

describe('what the caller is told', () => {
  it('gives every project failure code exactly one message', () => {
    // The message is looked up from the code alone, so two causes of one code
    // cannot drift apart. This asserts the table is total.
    expect(Object.keys(PROJECT_FAILURE_MESSAGES).sort()).toEqual(
      [ErrorCode.NOT_FOUND, ErrorCode.FORBIDDEN, ErrorCode.CONFLICT].sort(),
    );
    for (const message of Object.values(PROJECT_FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('gives every agent failure code exactly one message', () => {
    expect(Object.keys(AGENT_FAILURE_MESSAGES).sort()).toEqual(
      [ErrorCode.NOT_FOUND, ErrorCode.AGENT_DELETED, ErrorCode.AGENT_NOT_IN_PROJECT].sort(),
    );
    for (const message of Object.values(AGENT_FAILURE_MESSAGES)) {
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('never names the resource it is hiding', () => {
    // A message that said "project prj_..." would undo the code choice.
    expect(PROJECT_FAILURE_MESSAGES[ErrorCode.NOT_FOUND]).not.toMatch(/prj_|usr_|agt_/);
    expect(AGENT_FAILURE_MESSAGES[ErrorCode.NOT_FOUND]).not.toMatch(/prj_|usr_|agt_/);
  });

  it('maps each choice to the status the contract documents', () => {
    // The wire consequence of the matrix, in one place: a hidden resource is a
    // 404, an admitted one a 403, a stale agent id a 410.
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.NOT_FOUND]).toBe(404);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.FORBIDDEN]).toBe(403);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.CONFLICT]).toBe(409);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.AGENT_DELETED]).toBe(410);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.AGENT_NOT_IN_PROJECT]).toBe(403);
  });
});
