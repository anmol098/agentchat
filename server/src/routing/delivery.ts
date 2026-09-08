/**
 * The two arrows the product is made of: push a new message to everyone
 * listening, and replay everything still owed when a listener says hello
 * (Plan §4.3, §4.4, decisions D2 and D3).
 *
 * Everything else in this repository exists to make these two reliable.
 * `./router.ts` knows *how* to reach a socket, `../services/inbox.ts` knows
 * *what* is still owed, and `../services/messages.ts` knows what is committed.
 * This module is the only thing that knows the order they go in.
 *
 * ## At-least-once, and why duplicates are the design
 *
 * A message is owed until its `message_inbox` row says `acked`. Nothing else —
 * not a successful `send`, not a `deliveries` row, not a socket that was open a
 * moment ago — reduces that debt. Every consequence people expect to be
 * separate features falls out of that one sentence:
 *
 * - **Recipient offline.** {@link DeliveryService.deliver} reaches nobody and
 *   returns an empty report. The inbox row stays `pending`, so the next
 *   {@link DeliveryService.bound} replays it. That is not an error path; it is
 *   the replay case working, and this module logs it at `info` rather than
 *   treating it as a failure.
 * - **Socket dropped mid-delivery.** Same row, same replay.
 * - **Listener crashed before acknowledging.** Same row, same replay.
 *
 * The price is duplicates, and they are deliberate (Plan §4.4, PRD §24). A
 * listener that reconnects between a send and its acknowledgement is replayed a
 * message it already has; a listener registered during its own replay receives
 * a concurrent send twice. **Nothing here tries to prevent that.** The client
 * deduplicates by `messageId`, which is the only place the question can be
 * answered correctly, and machinery here to suppress a second copy would trade
 * a harmless duplicate for a possible loss.
 *
 * ## Strictly after the commit
 *
 * {@link DeliveryService.deliver} takes a message that already exists. It is
 * called *after* `MessageService.send` resolves, never inside it, because a row
 * that is not committed is not visible on the connection a peer would re-read
 * it from and would vanish if the process died between the write and the
 * write's confirmation. T-303 made that ordering structural — the message
 * service takes no registry, no router and no callback, so there is no way to
 * deliver from inside it — and this module keeps its half of that bargain by
 * accepting a {@link DeliverableMessage} rather than a request to send one.
 *
 * The target is read off the message, not passed alongside it, so a caller
 * cannot deliver a message to an agent it was not addressed to.
 *
 * ## Replay, then ready
 *
 * `ready` means "you are caught up", so it cannot precede the catch-up.
 * {@link ConnectionObserver.bound} returns the number of messages it replayed
 * and the handshake module sends `{type:'ready', pending:n}` afterwards; that
 * ordering is enforced by the seam rather than remembered here (see
 * `../websocket/handler.ts`).
 *
 * The socket is registered **before** the replay reads anything, in the order
 * Plan §4.3 writes it. The other order looks tidier and loses messages: a send
 * landing between the replay's snapshot and the registration would reach no
 * socket *and* not be in the page just read, so it would sit pending until some
 * later reconnect that may never come. Registering first can only cause a
 * duplicate, which costs nothing.
 *
 * Replay is paged rather than read whole. The queue has no upper bound — an
 * agent offline for a week owes whatever accumulated — and D10 allows a
 * megabyte per message, so a single unpaged read is an unbounded allocation
 * driven by a stranger's sending. Each page is written to the socket before the
 * next is read, so resident memory is one page (a hundred messages) whatever
 * the backlog. There is no ceiling on the *number* of pages: stopping early
 * would strand the remainder until a reconnect nobody has a reason to make.
 * What a stalled reader costs from there is a socket-buffer question, and it
 * belongs to T-032.
 *
 * ## One socket's failure is nobody else's
 *
 * A fan-out writes to sockets that are closing while it writes to them.
 * `./router.ts` gives every recipient its own `try` over a snapshot taken
 * before the first write, so a throwing socket is deregistered and reported
 * while every other recipient still receives. This module carries the same rule
 * into the two places the router does not reach.
 *
 * **The bookkeeping is per-socket too.** One session's `deliveries` row failing
 * to write does not abandon the others, and no bookkeeping failure anywhere
 * fails the delivery, because `deliveries` is diagnostic and the inbox is what
 * makes delivery at-least-once.
 *
 * **A replay that cannot be written is a departed peer, not a server fault.**
 * The handshake's `send` is documented as swallowing a write to a closed socket,
 * but a transport that throws instead would otherwise make the replay throw,
 * which makes `bound` throw, which closes the socket with an *internal error* —
 * the server blaming itself for a listener that quit mid-handshake. So a
 * throwing replay drops that socket and returns what it managed to write. Not
 * one of the messages was acknowledged, so every one of them is still pending;
 * the peer gets exactly what it would have got by disconnecting a microsecond
 * earlier.
 *
 * @module
 */

import {
  AgentId,
  type ConversationId,
  ErrorCode,
  MessageId,
  type ProjectId,
  ProtocolError,
  type SessionId,
} from '@agentchat/protocol';
import { eq, inArray } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { agents } from '../db/schema/agents.js';
import { users } from '../db/schema/identity.js';
import { DEFAULT_PENDING_LIMIT, type InboxService } from '../services/inbox.js';
import type { ServerFrame } from '../websocket/frames.js';
import type { ConnectionObserver, SocketBinding, SocketLogger } from '../websocket/handler.js';
import type { Registration, SocketRegistry } from '../websocket/registry.js';
import type { Router } from './router.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many messages one replay reads at a time.
 *
 * {@link DEFAULT_PENDING_LIMIT} rather than a number of this module's own: the
 * inbox chose it against the *size* of a page rather than the count of rows in
 * it, and a second constant here would be the same decision made twice and
 * changed once. Overridable per service only so a test can prove the paging
 * loop with three messages instead of three hundred.
 */
export const REPLAY_PAGE_SIZE = DEFAULT_PENDING_LIMIT;

// ---------------------------------------------------------------------------
// The wire shape of a delivered message
// ---------------------------------------------------------------------------

/**
 * A message as a `message` frame carries it (Plan §4.2).
 *
 * `../websocket/frames.ts` types {@link ServerFrame}'s payload as `unknown` on
 * purpose, so that the envelope and its contents are owned separately. This is
 * the contents, and it lives here because delivery is the only thing that ever
 * builds one: the same shape goes out whether a message was accepted a
 * millisecond ago or replayed an hour later, and two builders would be two
 * shapes the first time either changed.
 *
 * Field names follow §4.2 and are **not** the column names —
 * {@link MessageEnvelope.messageId} is the row's `id`. A wire contract that
 * renamed itself whenever a column was renamed would not be a contract.
 */
export interface MessageEnvelope {
  /** The message's identifier, and the client's deduplication key. */
  readonly messageId: MessageId;

  /** The project it was sent in. */
  readonly projectId: ProjectId;

  /** The thread it belongs to. */
  readonly conversationId: ConversationId;

  /**
   * The message it replies to.
   *
   * `undefined` for a thread root, and omitted from the JSON entirely rather
   * than sent as `null`, which the additive-only rule (Plan §12.4) makes
   * indistinguishable to a reader that does not know the field.
   */
  readonly parentMessageId: MessageId | undefined;

  /** The agent that sent it. */
  readonly senderAgentId: AgentId;

  /**
   * The sender as a human reads it: `@alice/backend`.
   *
   * `undefined` when the handle could not be resolved. It is a display
   * convenience joined from two other tables, and a message is not held back
   * because a cosmetic lookup failed — see {@link SenderDirectory}.
   */
  readonly sender: string | undefined;

  /** The agent it is addressed to. Always the recipient of this delivery. */
  readonly recipientAgentId: AgentId;

  /** The content, uninterpreted. */
  readonly content: string;

  /**
   * When the server accepted it, as an ISO 8601 instant in UTC.
   *
   * A string rather than a `Date` because this type describes what crosses the
   * wire, and leaving the conversion to `JSON.stringify` would mean the
   * declared type and the transmitted type disagreed.
   */
  readonly createdAt: string;
}

/**
 * A committed message, as the two things that produce one describe it.
 *
 * `MessageService.send`'s `MessageRecord` and `InboxService.listPending`'s
 * `PendingMessage` both satisfy this structurally and neither knows about it,
 * which is the point: a freshly accepted message and a replayed one reach this
 * module by the same door and leave it as the same frame.
 */
export interface DeliverableMessage {
  /** The message's identifier (`msg_`). */
  readonly id: MessageId;
  /** The project it was sent in. */
  readonly projectId: ProjectId;
  /** The thread it belongs to. */
  readonly conversationId: ConversationId;
  /** The message it replies to, or `undefined` for a thread root. */
  readonly parentMessageId: MessageId | undefined;
  /** The agent that sent it. */
  readonly senderAgentId: AgentId;
  /** The agent that owes an acknowledgement for it. */
  readonly recipientAgentId: AgentId;
  /** The content, uninterpreted. */
  readonly content: string;
  /** When the row was written. */
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Sender handles
// ---------------------------------------------------------------------------

/**
 * Turns sender agent identifiers into `@user/agent` handles.
 *
 * A port rather than a query inlined into the replay loop, because T-304 left
 * the handle out of `PendingMessage` deliberately: it is a join against `users`
 * that only a frame builder needs, and putting it on the pending read would pay
 * for it on every reconnect whether or not anything was owed.
 *
 * Resolution is **batched and best-effort**. One lookup covers a whole page, so
 * a hundred replayed messages cost one round trip and not a hundred; and an id
 * missing from the result — a deleted agent, a lookup that failed outright —
 * costs that frame its {@link MessageEnvelope.sender} and nothing more. A
 * delivery that could be prevented by a cosmetic join would be a way to lose
 * messages by breaking the `users` table.
 */
export interface SenderDirectory {
  /**
   * Looks up handles for a set of agents.
   *
   * @param agentIds - The senders to resolve. May contain duplicates.
   * @returns A handle per agent that has one. Ids with no handle are absent
   *   from the map rather than present with a placeholder.
   */
  handlesFor(agentIds: readonly AgentId[]): Promise<ReadonlyMap<AgentId, string>>;
}

/** The one verb {@link createSenderDirectory} issues. */
export type SenderQueryRunner = Pick<PgDatabase<PgQueryResultHKT>, 'select'>;

/**
 * Builds the database-backed {@link SenderDirectory}.
 *
 * Soft-deleted agents are included on purpose (D13): a message sent by an agent
 * that has since been deleted still has to say who sent it, and rendering a
 * year-old message as having no sender because its author was tidied up would
 * be a worse answer than the truth.
 *
 * @param db - A handle that can read `agents` and `users`.
 * @returns A directory that resolves handles in one statement per call.
 */
export function createSenderDirectory(db: SenderQueryRunner): SenderDirectory {
  return {
    async handlesFor(agentIds: readonly AgentId[]): Promise<ReadonlyMap<AgentId, string>> {
      const wanted = [...new Set(agentIds)];
      if (wanted.length === 0) {
        // No statement at all. A delivery to a single recipient is one message
        // from one sender, so this is worth not paying for.
        return new Map();
      }

      const rows = await db
        .select({ agentId: agents.id, username: users.username, agentName: agents.name })
        .from(agents)
        .innerJoin(users, eq(users.id, agents.userId))
        .where(inArray(agents.id, wanted));

      const handles = new Map<AgentId, string>();
      for (const row of rows) {
        // The column is `text`, so the brand is restored here. The value came
        // back from a `WHERE id IN (…)` over ids that were already `AgentId`s,
        // so this cast cannot invent one.
        handles.set(AgentId.unsafeCast(row.agentId), `@${row.username}/${row.agentName}`);
      }

      return handles;
    },
  };
}

// ---------------------------------------------------------------------------
// What a delivery achieved
// ---------------------------------------------------------------------------

/**
 * What one call to {@link DeliveryService.deliver} did, on this instance.
 *
 * Reported for the caller's logs and for tests. **Not** a durability answer: a
 * report with nothing in `delivered` means the recipient was not listening
 * here, which the pending inbox row already covers. A route that turned an
 * empty report into an error would fail sends to offline agents, which is the
 * case this whole system is built around.
 */
export interface DeliveryReport {
  /** The message that was fanned out. */
  readonly messageId: MessageId;

  /** The sessions whose sockets took the frame. */
  readonly delivered: readonly SessionId[];

  /**
   * The sessions whose sockets threw and were dropped.
   *
   * Their inbox row is untouched, so they are replayed on reconnect.
   */
  readonly failed: readonly SessionId[];
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The inbox, reduced to what delivery does with it.
 *
 * A `Pick` so that a test double is three functions rather than a database, and
 * so that the read of this module says exactly which of the inbox's promises it
 * leans on.
 */
export type DeliveryInbox = Pick<InboxService, 'listPending' | 'acknowledge' | 'recordDelivery'>;

/** What {@link createDeliveryService} needs. */
export interface DeliveryServiceOptions {
  /** How frames reach sockets. See `./router.ts`. */
  readonly router: Router;

  /**
   * Where a bound socket is filed and from where it is removed.
   *
   * The registry is held at the wiring site and reaches the handshake only
   * through these hooks (T-033); this module registers in
   * {@link ConnectionObserver.bound} and releases in
   * {@link ConnectionObserver.closed}, and does nothing else with it.
   */
  readonly registry: SocketRegistry;

  /** The pending queue and the acknowledgement that clears it. */
  readonly inbox: DeliveryInbox;

  /** How `@user/agent` handles are resolved for outgoing frames. */
  readonly senders: SenderDirectory;

  /** Where delivery, replay and acknowledgement events go. */
  readonly logger: SocketLogger;

  /**
   * Messages per replay page. Defaults to {@link REPLAY_PAGE_SIZE}.
   *
   * For tests that want to prove the paging loop without three hundred rows.
   * Clamped by the inbox itself, which is where the real bound lives.
   */
  readonly replayPageSize?: number | undefined;
}

/**
 * Delivery and replay, as one object.
 *
 * It *is* the {@link ConnectionObserver} the handshake takes, rather than
 * exposing one, because the hooks and {@link DeliveryService.deliver} share the
 * bookkeeping that makes a delivery at-least-once and splitting them would mean
 * two objects that are only correct together.
 */
export interface DeliveryService extends ConnectionObserver {
  /**
   * Fans a committed message out to every socket serving its recipient.
   *
   * Call this **after** `MessageService.send` has resolved, never before and
   * never inside it: the row has to be committed and visible to other
   * connections, because a listener may re-read or acknowledge it the
   * microsecond after the frame lands.
   *
   * Never rejects. A recipient that is offline, a socket that throws, and a
   * `deliveries` row that fails to write are all outcomes rather than faults —
   * every one of them leaves the message pending and therefore replayed.
   *
   * @param message - The committed message. Its own `recipientAgentId` and
   *   `projectId` are the delivery target.
   * @returns Which sessions took it and which were dropped.
   */
  deliver(message: DeliverableMessage): Promise<DeliveryReport>;

  /**
   * Registers the socket and replays everything its agent is still owed.
   *
   * @param binding - The socket that has just completed its handshake.
   * @returns How many messages were replayed, for the `ready` frame.
   */
  bound(binding: SocketBinding): Promise<number>;

  /**
   * Clears one message from the agent's queue (D3).
   *
   * @param binding - The socket the acknowledgement arrived on.
   * @param messageId - The message being acknowledged, already validated
   *   against `MessageId.schema` by the frame decoder.
   */
  acked(binding: SocketBinding, messageId: string): Promise<void>;

  /**
   * Deregisters the socket.
   *
   * @param binding - The socket that closed.
   */
  closed(binding: SocketBinding): Promise<void>;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** What this module remembers about one bound socket. */
interface BoundSocket {
  /** The handle that removes it from the registry. */
  readonly registration: Registration;

  /**
   * Whether the socket is still worth writing to.
   *
   * Read between replay pages. `disconnected` is not chained onto the frame
   * queue, so a socket can be reported gone while its own `hello` is still
   * paging through a backlog, and continuing to read pages for a peer that has
   * left is a database round trip per hundred messages spent on nobody.
   */
  open: boolean;
}

/**
 * Builds the delivery service.
 *
 * @param options - The router, registry, inbox, handle directory and logger.
 * @returns The service, which is also the handshake's connection observer.
 */
export function createDeliveryService(options: DeliveryServiceOptions): DeliveryService {
  const { router, registry, inbox, senders, logger } = options;
  const pageSize = options.replayPageSize ?? REPLAY_PAGE_SIZE;

  /**
   * The sockets this service has bound, by binding.
   *
   * Weak because the handshake owns a binding's lifetime: if `closed` somehow
   * never ran, a strong map would hold the socket, its session and its identity
   * for the life of the process. Nothing here needs to enumerate them.
   */
  const bindings = new WeakMap<SocketBinding, BoundSocket>();

  /** The fields every line about a socket carries. */
  function socketContext(binding: SocketBinding): Record<string, unknown> {
    const { sessionId, agentId, projectId } = binding.identity;
    return { sessionId, agentId, projectId };
  }

  /**
   * Resolves handles for a batch of messages, never failing the delivery.
   *
   * @param batch - The messages about to be framed.
   * @returns A handle per sender that has one; empty if the lookup failed.
   */
  async function handlesFor(
    batch: readonly DeliverableMessage[],
  ): Promise<ReadonlyMap<AgentId, string>> {
    try {
      return await senders.handlesFor(batch.map((message) => message.senderAgentId));
    } catch (error: unknown) {
      // Cosmetic, so it is a warning and not a refusal. The frames go out
      // without a `sender` and the messages are still delivered, acknowledged
      // and cleared; a client that renders the handle shows the agent id.
      logger.warn({ err: error, messages: batch.length }, 'sender handle lookup failed');
      return new Map();
    }
  }

  /**
   * Builds the frame for one message.
   *
   * @param message - The committed message.
   * @param handles - Handles resolved for this batch.
   * @returns The `message` frame to write.
   */
  function frameFor(
    message: DeliverableMessage,
    handles: ReadonlyMap<AgentId, string>,
  ): ServerFrame {
    const envelope: MessageEnvelope = {
      messageId: message.id,
      projectId: message.projectId,
      conversationId: message.conversationId,
      parentMessageId: message.parentMessageId,
      senderAgentId: message.senderAgentId,
      sender: handles.get(message.senderAgentId),
      recipientAgentId: message.recipientAgentId,
      content: message.content,
      createdAt: message.createdAt.toISOString(),
    };

    return { type: 'message', message: envelope };
  }

  /**
   * Records one delivery attempt, swallowing whatever goes wrong.
   *
   * `deliveries` is diagnostic (Plan §11, T-304): it answers "the server says
   * delivered, so why did the harness never see it?" and nothing in replay or
   * acknowledgement reads it. A write that fails costs an audit trail, so it
   * must not cost the delivery — and it must not cost the *other* recipients'
   * audit trails either, which is why each attempt is recorded on its own
   * rather than in one statement that a single bad row could take down.
   *
   * @param messageId - The message written out.
   * @param sessionId - The session it was written to.
   */
  async function record(messageId: MessageId, sessionId: SessionId): Promise<void> {
    try {
      await inbox.recordDelivery({ messageId, sessionId });
    } catch (error: unknown) {
      logger.warn({ err: error, messageId, sessionId }, 'recording a delivery failed');
    }
  }

  /**
   * Records every attempt of one fan-out or one replay page, concurrently.
   *
   * Concurrent because these are independent single-row upserts and a replay
   * page is a hundred of them: run in sequence they would be a hundred round
   * trips between the last frame and the `ready` that follows it.
   *
   * @param attempts - The message-and-session pairs to record.
   */
  async function recordAll(
    attempts: readonly { messageId: MessageId; sessionId: SessionId }[],
  ): Promise<void> {
    await Promise.all(attempts.map((attempt) => record(attempt.messageId, attempt.sessionId)));
  }

  /**
   * Replays the pending queue onto one socket, oldest first.
   *
   * Paged, and each page is written before the next is read; see the module
   * note for why there is no ceiling on the number of pages and why memory is
   * bounded anyway.
   *
   * @param binding - The socket to write to.
   * @param state - Its bookkeeping, consulted so a socket that goes away
   *   mid-replay stops costing queries.
   * @returns How many messages were written.
   */
  async function replay(binding: SocketBinding, state: BoundSocket): Promise<number> {
    const { userId, sessionId, agentId, projectId } = binding.identity;

    let replayed = 0;
    let after: MessageId | undefined;

    while (state.open) {
      const page = await inbox.listPending({
        userId,
        agentId,
        projectId,
        limit: pageSize,
        ...(after === undefined ? {} : { after }),
      });

      if (page.messages.length === 0) {
        break;
      }

      const handles = await handlesFor(page.messages);

      // Frames first, bookkeeping after. The listener is waiting on these and
      // `deliveries` is nobody's dependency.
      const written: MessageId[] = [];
      for (const message of page.messages) {
        try {
          binding.send(frameFor(message, handles));
        } catch (error: unknown) {
          // The same rule `./router.ts` applies to a fan-out, applied to a
          // replay: a `send` that throws means the peer is gone, and a departed
          // peer is an outcome rather than a fault. Letting it out of here would
          // make `bound` throw, which closes the socket with an *internal error*
          // — the server blaming itself for a listener that quit mid-handshake.
          //
          // Nothing is lost by stopping. Not one of these messages has been
          // acknowledged, so every one of them is still pending and replays on
          // the next handshake. That is the same guarantee the peer would have
          // had if it had disconnected a microsecond earlier.
          logger.info(
            { ...socketContext(binding), err: error, replayed },
            'websocket replay failed; dropping socket',
          );
          state.open = false;
          registry.remove(binding);
          break;
        }
        written.push(message.id);
        replayed += 1;
      }

      await recordAll(written.map((messageId) => ({ messageId, sessionId })));

      if (!state.open || page.nextCursor === undefined) {
        break;
      }
      after = page.nextCursor;
    }

    if (replayed > 0) {
      logger.info({ ...socketContext(binding), replayed }, 'replayed the pending inbox');
    }

    return replayed;
  }

  return {
    async deliver(message: DeliverableMessage): Promise<DeliveryReport> {
      const target = { agentId: message.recipientAgentId, projectId: message.projectId };
      const handles = await handlesFor([message]);

      // The router never rejects: a socket that throws is dropped and reported,
      // and the ones behind it in the snapshot still receive. See `./router.ts`.
      const outcome = await router.deliver(target, frameFor(message, handles));

      if (outcome.delivered.length === 0) {
        // Not a failure. The inbox row stays `pending` and the next handshake
        // replays it, which is the entire offline story (Plan §4.4).
        logger.info(
          { messageId: message.id, ...target, failed: outcome.failed.length },
          'message delivered to no live socket; it stays pending',
        );
      }

      await recordAll(
        outcome.delivered.map((session) => ({ messageId: message.id, sessionId: session })),
      );

      return {
        messageId: message.id,
        delivered: outcome.delivered,
        failed: outcome.failed,
      };
    },

    async bound(binding: SocketBinding): Promise<number> {
      // Registered before a single row is read, per Plan §4.3. A message that
      // lands during the replay then reaches this socket twice, which the
      // client's deduplication absorbs; the other order would let it reach the
      // socket not at all. See the module note.
      const state: BoundSocket = { registration: registry.register(binding), open: true };
      bindings.set(binding, state);

      return await replay(binding, state);
    },

    async acked(binding: SocketBinding, messageId: string): Promise<void> {
      const { userId, sessionId, agentId, projectId } = binding.identity;

      // Already validated against `MessageId.schema` by the frame decoder; this
      // is the brand the decoder's result lost passing through the observer
      // seam, which types the id as a plain string.
      const id = MessageId.unsafeCast(messageId);

      try {
        const result = await inbox.acknowledge({
          userId,
          agentId,
          projectId,
          messageId: id,
          sessionId,
        });

        if (result.alreadyAcknowledged) {
          // The ordinary outcome of a duplicate: this agent's other listener
          // acknowledged it, or this one did and its frame was replayed anyway.
          // A success, and D3 in action.
          logger.info(
            { ...socketContext(binding), messageId: id },
            'acknowledgement for a message already cleared',
          );
        }
      } catch (error: unknown) {
        if (error instanceof ProtocolError && error.code === ErrorCode.NOT_FOUND) {
          // There is no queue row. The agent does not owe this message — it
          // never did, or the row is gone — and an acknowledgement for a debt
          // that does not exist has already achieved what it wanted. Refusing
          // it would close a socket over the harmless end of at-least-once: a
          // client replaying its own unsent acknowledgements after a restart.
          logger.info(
            { ...socketContext(binding), messageId: id },
            'acknowledgement for a message this agent does not owe; ignoring',
          );
          return;
        }

        // Anything else — the agent deleted, removed from the project, the
        // database gone — is not this module's to absorb. The handshake closes
        // the socket, and a listener whose agent no longer exists should not go
        // on quietly failing to clear its queue.
        throw error;
      }
    },

    async closed(binding: SocketBinding): Promise<void> {
      const state = bindings.get(binding);
      if (state === undefined) {
        // `closed` runs only if `bound` ran, so this is a socket bound by
        // somebody else's observer. Releasing nothing is the right answer.
        return;
      }

      state.open = false;
      bindings.delete(binding);

      // Idempotent, and safe after the registry was cleared by a shutdown.
      state.registration.release();

      await Promise.resolve();
    },
  };
}
