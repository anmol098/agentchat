import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ProtocolError } from "./errors.js";
import {
  AgentId,
  ConversationId,
  ID_KINDS,
  ID_PREFIXES,
  type IdKind,
  InviteId,
  MachineId,
  MessageId,
  ProjectId,
  SessionId,
  UserId,
  isAnyId,
} from "./ids.js";
import { uuidv7 } from "./uuidv7.js";

const KINDS: ReadonlyArray<readonly [string, IdKind<string>]> =
  Object.entries(ID_KINDS);

describe("ID_PREFIXES", () => {
  it("pins the prefixes named in the implementation plan", () => {
    // These strings are stored in every row and printed in every --json
    // payload. If this test fails, the change is a breaking one.
    expect(ID_PREFIXES).toStrictEqual({
      user: "usr_",
      project: "prj_",
      agent: "agt_",
      machine: "mch_",
      session: "ses_",
      conversation: "cnv_",
      message: "msg_",
      invite: "inv_",
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ID_PREFIXES)).toBe(true);
    // @ts-expect-error - the prefixes are readonly at compile time too.
    expect(() => (ID_PREFIXES.user = "nope_")).toThrow(TypeError);
  });

  it("gives every kind a distinct four-character prefix", () => {
    const prefixes = Object.values(ID_PREFIXES);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    for (const prefix of prefixes) {
      expect(prefix).toMatch(/^[a-z]{3}_$/);
    }
  });

  it("covers exactly the kinds in ID_KINDS", () => {
    expect(Object.keys(ID_KINDS)).toStrictEqual(Object.keys(ID_PREFIXES));
    for (const [name, kind] of KINDS) {
      expect(kind.prefix).toBe(
        ID_PREFIXES[name as keyof typeof ID_PREFIXES],
      );
    }
  });
});

describe("identifier round-trips", () => {
  it.each(KINDS)("%s ids survive generate → is → parse", (_name, kind) => {
    const id = kind.generate();
    expect(id.startsWith(kind.prefix)).toBe(true);
    expect(id).toHaveLength(kind.prefix.length + 36);
    expect(kind.is(id)).toBe(true);
    expect(kind.parse(id)).toBe(id);
    // Parsing is idempotent: the value out is the value in, not a copy.
    expect(kind.parse(kind.parse(id))).toBe(id);
  });

  it.each(KINDS)("%s ids embed their creation time", (_name, kind) => {
    const before = Date.now();
    const id = kind.generate();
    expect(kind.timestamp(id)).toBeGreaterThanOrEqual(before);
    expect(kind.timestamp(id)).toBeLessThanOrEqual(Date.now());
  });

  it.each(KINDS)("%s ids are unique", (_name, kind) => {
    const ids = new Set(Array.from({ length: 1000 }, () => kind.generate()));
    expect(ids.size).toBe(1000);
  });

  it("sorts message ids chronologically as plain strings", () => {
    // The inbox and conversation replay depend on this; it is why the ids are
    // UUIDv7 and not UUIDv4.
    const ids = Array.from({ length: 5000 }, () => MessageId.generate());
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    expect([...shuffled].sort()).toStrictEqual(ids);
  });
});

describe("prefix rejection", () => {
  it("rejects every other kind's identifier", () => {
    for (const [name, kind] of KINDS) {
      const foreign = KINDS.filter(([otherName]) => otherName !== name);
      for (const [otherName, otherKind] of foreign) {
        const otherId = otherKind.generate();
        expect(kind.is(otherId)).toBe(false);
        expect(() => kind.parse(otherId)).toThrow(ProtocolError);
        expect(kind.schema.safeParse(otherId).success).toBe(false);
        expect(otherName).not.toBe(name);
      }
    }
  });

  it.each(KINDS)("%s rejects malformed input", (_name, kind) => {
    const body = uuidv7();
    const bad = [
      "",
      body, // bare uuid, no prefix
      kind.prefix, // prefix, no uuid
      `${kind.prefix}${body.toUpperCase()}`, // uppercase uuid
      `${kind.prefix}${body.replaceAll("-", "")}`, // unhyphenated
      `${kind.prefix}${body}extra`,
      ` ${kind.prefix}${body}`,
      `${kind.prefix}${body} `,
      `${kind.prefix}${body}\n`,
      `x${kind.prefix}${body}`,
      // A v4 uuid: right shape, wrong version nibble.
      `${kind.prefix}9f1e2d3c-4b5a-4c7d-8e9f-0a1b2c3d4e5f`,
    ];
    for (const value of bad) {
      expect(kind.is(value)).toBe(false);
      expect(() => kind.parse(value)).toThrow(ProtocolError);
    }
  });

  it.each(KINDS)("%s rejects non-strings", (_name, kind) => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(kind.is(value)).toBe(false);
      expect(() => kind.parse(value)).toThrow(ProtocolError);
    }
  });

  it("reports a BAD_REQUEST naming the expected prefix", () => {
    try {
      AgentId.parse(ProjectId.generate());
      expect.unreachable("a project id is not an agent id");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe("BAD_REQUEST");
      expect((error as ProtocolError).message).toContain("agt_");
    }
  });

  it("truncates the offending value in the error message", () => {
    const huge = `agt_${"a".repeat(5000)}`;
    try {
      AgentId.parse(huge);
      expect.unreachable("padding is not a uuid");
    } catch (error) {
      expect((error as ProtocolError).message.length).toBeLessThan(200);
      expect((error as ProtocolError).message).toContain("…");
    }
  });

  it("describes the type of a non-string", () => {
    try {
      AgentId.parse(null);
      expect.unreachable("null is not an id");
    } catch (error) {
      expect((error as ProtocolError).message).toContain("null");
    }
  });
});

describe("schemas", () => {
  it("compose into an object schema", () => {
    const SendSchema = z.object({
      projectId: ProjectId.schema,
      senderAgentId: AgentId.schema,
    });
    const projectId = ProjectId.generate();
    const senderAgentId = AgentId.generate();

    expect(SendSchema.parse({ projectId, senderAgentId })).toStrictEqual({
      projectId,
      senderAgentId,
    });
    expect(
      SendSchema.safeParse({ projectId: senderAgentId, senderAgentId }).success,
    ).toBe(false);
  });

  it.each(KINDS)("%s schema accepts its own ids only", (_name, kind) => {
    expect(kind.schema.safeParse(kind.generate()).success).toBe(true);
    expect(kind.schema.safeParse(uuidv7()).success).toBe(false);
    expect(kind.schema.safeParse(7).success).toBe(false);
  });
});

describe("unsafeCast", () => {
  it("brands without validating, as documented", () => {
    // Recorded deliberately: this is the escape hatch for values already known
    // good, and its lack of validation is the whole reason it is named badly.
    expect(AgentId.unsafeCast("not-an-id")).toBe("not-an-id");
  });
});

describe("isAnyId", () => {
  it.each(KINDS)("accepts a %s id", (_name, kind) => {
    expect(isAnyId(kind.generate())).toBe(true);
  });

  it("rejects unknown prefixes and malformed bodies", () => {
    expect(isAnyId(`xyz_${uuidv7()}`)).toBe(false);
    expect(isAnyId(uuidv7())).toBe(false);
    expect(isAnyId("agt_nope")).toBe(false);
    expect(isAnyId("")).toBe(false);
    expect(isAnyId(null)).toBe(false);
  });
});

/**
 * Compile-time proof that the brands are load-bearing.
 *
 * These assertions are checked by `pnpm typecheck` (which runs
 * `tsconfig.test.json` over this file), not at runtime: vitest strips types
 * without checking them. Every `@ts-expect-error` below fails the build if the
 * line it precedes ever starts compiling — which is exactly what would happen
 * if the branding were weakened to a plain `type AgentId = string`.
 */
describe("branding (checked by tsc, not at runtime)", () => {
  it("keeps one kind of id out of another's slot", () => {
    const agentId = AgentId.generate();
    const projectId = ProjectId.generate();

    const takesAgent = (value: AgentId): string => value;
    const takesProject = (value: ProjectId): string => value;

    // Sanity: the right ids go in the right slots.
    expect(takesAgent(agentId)).toBe(agentId);
    expect(takesProject(projectId)).toBe(projectId);

    // @ts-expect-error - a ProjectId is not an AgentId.
    expect(takesAgent(projectId)).toBe(projectId);
    // @ts-expect-error - an AgentId is not a ProjectId.
    expect(takesProject(agentId)).toBe(agentId);
    // @ts-expect-error - a bare string is not an AgentId; parse it first.
    expect(takesAgent(`agt_${uuidv7()}`)).toBeTypeOf("string");
    // @ts-expect-error - not even a string literal of the right shape.
    expect(takesAgent("agt_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b")).toBeTypeOf(
      "string",
    );

    // The other direction is fine on purpose: a branded id is still a string.
    const raw: string = agentId;
    expect(raw).toBe(agentId);
  });

  it("keeps every kind mutually exclusive", () => {
    const user: UserId = UserId.generate();
    const project: ProjectId = ProjectId.generate();
    const agent: AgentId = AgentId.generate();
    const machine: MachineId = MachineId.generate();
    const session: SessionId = SessionId.generate();
    const conversation: ConversationId = ConversationId.generate();
    const message: MessageId = MessageId.generate();
    const invite: InviteId = InviteId.generate();

    // @ts-expect-error - UserId is not MachineId.
    const wrongMachine: MachineId = user;
    // @ts-expect-error - SessionId is not ConversationId.
    const wrongConversation: ConversationId = session;
    // @ts-expect-error - MessageId is not InviteId.
    const wrongInvite: InviteId = message;

    expect([
      user,
      project,
      agent,
      machine,
      conversation,
      invite,
      wrongMachine,
      wrongConversation,
      wrongInvite,
    ]).toHaveLength(9);
  });
});
