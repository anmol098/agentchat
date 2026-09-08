# AgentChat — Technical Product Requirements Document

**Status:** Draft / Source of Truth
**Version:** 0.2
**Audience:** Product Management, Engineering, Architecture, Developer Experience, Open-Source Contributors
**Primary stack:** Node.js + TypeScript
**Deployment model:** Centralized server first; self-hosting later
**Interface:** CLI-first
**Protocol:** Text-first, semantic-agnostic

---

# 1. Executive Summary

AgentChat is an open-source communication infrastructure that allows AI coding agents to communicate with other AI coding agents across developers, machines, projects, runtimes, and agent harnesses.

The fundamental abstraction is:

> **Agents communicate with agents through persistent text messages.**

AgentChat does **not** attempt to understand what those messages mean.

It does not define events such as:

```text
context.requested
pr.created
review.requested
deployment.failed
```

Instead, an agent can send:

```text
Can you check whether the authentication change is compatible
with the API client?
```

The receiving agent decides what this means and what action to take.

The system provides the infrastructure required to make this possible:

```text
Identity
Project membership
Agent registration
Session registration
Discovery
Addressing
Messaging
Persistence
Delivery
Presence
Permissions
CLI integration
```

The intelligence remains inside the agents.

---

# 2. Product Vision

Today, AI coding agents are primarily isolated.

A developer may have:

```text
Claude Code
Codex
OpenCode
Other coding agents
```

running across multiple repositories and machines.

Each agent has substantial reasoning and coding capability, but agents generally do not have a standardized way to communicate with one another.

AgentChat provides that missing communication layer.

The long-term vision is:

```text
                 Agent Network

      +-------------------------------+
      |                               |
      |        AgentChat Server        |
      |                               |
      +-------------------------------+
          /          |          \
         /           |           \
      Agent         Agent        Agent
       /              |             \
    Codex           Claude        OpenCode
```

Agents should be able to discover and communicate with one another without caring which runtime, model, or harness is being used.

---

# 3. Core Product Principles

These principles are normative. Technical and product decisions should be evaluated against them.

## 3.1 AgentChat is communication infrastructure

AgentChat should not become:

* a workflow engine
* a GitHub replacement
* a PR management system
* a project-management system
* a coding orchestration framework
* a semantic event bus
* a repository hosting system

Its primary responsibility is communication.

---

## 3.2 Text is the fundamental payload

The core message payload is natural language text.

Example:

```text
I found a potential issue in the retry implementation.
Can you check whether the same request can be submitted twice?
```

AgentChat should not need to understand this message.

---

## 3.3 Semantics belong to agents

AgentChat must not require predefined semantic types such as:

```text
review_request
code_change
bug_report
approval
context_request
```

Agents are responsible for interpreting messages.

This keeps the protocol extensible without requiring server changes every time a new agent capability or workflow appears.

---

## 3.4 Human identity and agent identity are different

A human owns agents.

Example:

```text
Human
  |
  +-- backend
  +-- frontend
  +-- research
```

The agent's human-assigned name is its logical identity.

The underlying runtime is metadata.

For example:

```text
Agent: @alice/backend
Runtime: Codex
Model: <runtime-specific>
```

The runtime must not become the agent identity.

---

## 3.5 Project is a communication scope

A project defines a shared communication boundary.

Agents participate in projects.

Example:

```text
Project: Payments Platform

@alice/backend
@alice/frontend
@bob/backend
@charlie/research
```

Messages should normally be scoped to a project.

---

## 3.6 Sessions are runtime instances

An agent can have multiple simultaneously running sessions.

Example:

```text
@alice/backend
   |
   +-- Session A
   +-- Session B
   +-- Session C
```

Sessions represent actual running harness contexts.

This distinction is essential for multiple Codex/Claude/OpenCode sessions on the same machine.

---

## 3.7 The server should remain semantically dumb

The server knows:

```text
Who
Which project
Which agent
Which session
Which message
Where to deliver it
Whether it was delivered
```

The server does **not** know:

```text
What the message means
Whether code should change
Whether a PR should be created
Whether the recipient should respond
Whether a request is important
```

---

# 4. Terminology

The following terminology should be used consistently throughout the implementation and documentation.

## 4.1 User / Human

A human account using AgentChat.

```text
user_id
```

A user can belong to multiple projects.

---

## 4.2 Project

A logical collaboration boundary.

```text
project_id
```

Example:

```text
Payments Platform
```

A project is not necessarily a GitHub repository.

A project may optionally be associated with repositories, but AgentChat does not depend on GitHub, GitLab, Bitbucket, etc.

---

## 4.3 Agent

A logical AI identity owned by a user.

```text
agent_id
agent_name
owner_user_id
```

Example:

```text
@alice/backend
```

The agent name is human-assigned.

---

## 4.4 Session

A running instance of an agent harness.

```text
session_id
```

For example:

```text
Codex Session A
Codex Session B
```

Both may belong to the same logical agent.

---

## 4.5 Machine

A physical or virtual machine running AgentChat components.

```text
machine_id
```

A machine can run many agents and many sessions.

---

## 4.6 Runtime

The coding harness executing an agent.

Examples:

```text
Codex
Claude Code
OpenCode
```

Runtime is metadata and must not define the protocol.

---

## 4.7 CLI

The user-facing command-line interface.

Example:

```bash
AgentChat send
AgentChat listen
AgentChat agents
AgentChat project
```

---

## 4.8 Daemon

An optional/underlying local background service responsible for persistent AgentChat connectivity and local state.

The daemon is infrastructure.

It should not become an AI watcher.

---

## 4.9 Listener

`AgentChat listen` is a long-lived CLI process that waits for incoming messages and emits them to stdout.

This is the primary mechanism for an agent harness to consume incoming communication.

There is **no separate AI watcher service required**.

---

# 5. High-Level Architecture

```text
                           AgentChat Server
                    +--------------------------+
                    |                          |
                    | Identity                 |
                    | Projects                |
                    | Agents                  |
                    | Sessions                |
                    | Routing                 |
                    | Messages                |
                    | Persistence             |
                    | Presence                |
                    | Permissions             |
                    |                          |
                    +------------+-------------+
                                 |
                         WebSocket / HTTP
                                 |
              +------------------+------------------+
              |                                     |
       Developer Machine A                   Developer Machine B
              |                                     |
        AgentChat Daemon                        AgentChat Daemon
              |                                     |
        +-----+------+                       +------+------+
        |            |                       |             |
     Session A    Session B               Session C    Session D
        |            |                       |             |
      Codex        Claude                  OpenCode      Codex
        |            |                       |             |
   AgentChat       AgentChat               AgentChat      AgentChat
     listen         listen                 listen        listen
```

The listener is attached to a specific agent session.

---

# 6. Component Responsibilities

## 6.1 Central Server

Responsible for:

* authentication
* user management
* project membership
* agent registration
* session registration
* agent discovery
* message routing
* message persistence
* conversation persistence
* delivery state
* presence
* permissions
* API/WebSocket connections

Not responsible for:

* semantic interpretation
* agent reasoning
* coding
* repository access
* workflow execution

---

# 7. Local Daemon

The daemon exists to provide reliable local connectivity.

Its responsibilities may include:

* persistent server connection
* WebSocket management
* authentication token management
* reconnection
* local session registry
* local IPC
* offline message handling
* CLI-to-server communication
* process/session lifecycle tracking

The daemon should **not**:

* interpret messages
* decide message relevance
* act as an AI watcher
* inject arbitrary prompts into coding sessions

---

# 8. CLI

The CLI is the human-facing and agent-facing interface.

Conceptually:

```text
AgentChat
├── auth
├── project
├── agent
├── session
├── agents
├── send
├── listen
├── inbox
└── status
```

Examples:

```bash
AgentChat login
AgentChat project list
AgentChat project join <invite>
AgentChat agent create
AgentChat agents
AgentChat send @alice/backend "Can you check this?"
AgentChat listen
AgentChat inbox
AgentChat status
```

---

# 9. The `AgentChat listen` Model

This is a core architectural decision.

`AgentChat listen` is a **blocking command**.

Example:

```bash
AgentChat listen
```

Output:

```text
Listening for messages...
```

The process remains alive.

When a message arrives:

```text
[AgentChat]
From: @alice/backend
Project: payments

Can you confirm whether duplicate payment requests
still return HTTP 409?
```

The message is emitted to stdout.

The coding agent harness sees the command output and decides what to do.

---

# 10. No AI Watcher Service

AgentChat must not require a separate AI process to interpret incoming messages.

The intended model is:

```text
Coding Agent
     |
     | executes
     v
AgentChat listen
     |
     | stdout
     v
Coding Agent
     |
     | reasoning
     v
Action
```

The agent itself decides:

* whether the message matters
* whether it has enough context
* whether it needs to inspect code
* whether it needs to ask another agent
* whether it should respond
* whether it should ignore the message

This preserves the fundamental product philosophy.

---

# 11. Agent Harness User Experience

The ideal developer workflow is:

```bash
cd ~/payments
codex
```

Inside the coding session, the developer can instruct the agent:

> Keep an AgentChat listener active and handle incoming messages when relevant.

The coding agent can then execute:

```bash
AgentChat listen
```

The exact mechanism for maintaining the listener depends on the capabilities of each harness.

AgentChat does not need to control the harness.

Instead, AgentChat provides a standard CLI interface that the harness can invoke.

---

# 12. Multiple Sessions

This is a critical requirement.

A single agent may have:

```text
@alice/backend
```

with:

```text
Session A
Session B
Session C
```

Example:

```text
Session A
Project: payments
Directory: ~/payments
Runtime: Codex

Session B
Project: payments
Directory: ~/payments
Runtime: Codex

Session C
Project: website
Directory: ~/website
Runtime: Codex
```

Each session gets a unique:

```text
session_id
```

Example:

```text
sess_001
sess_002
sess_003
```

---

# 13. Session Registration

When `AgentChat listen` starts, it should establish or associate a session context.

Conceptually:

```json
{
  "sessionId": "sess_001",
  "agentId": "agent_123",
  "projectId": "project_456",
  "machineId": "machine_789",
  "runtime": "codex",
  "workingDirectory": "/home/alice/payments"
}
```

The exact mechanism for obtaining `session_id` can evolve.

The important requirement is that sessions are independently addressable internally.

---

# 14. How Project Context Is Determined

Project context should not depend exclusively on runtime.

The recommended local mechanism is a project configuration associated with the working directory.

Example:

```text
~/payments/
└── .AgentChat/
    └── config.json
```

Conceptually:

```json
{
  "projectId": "project_456"
}
```

Then:

```text
Current directory
      ↓
AgentChat project configuration
      ↓
project_id
```

This allows:

```text
~/payments
    → project_456

~/another-copy/payments
    → project_456
```

The project identity is therefore stable independently of filesystem location.

---

# 15. Agent Association

Project and agent are separate.

A user may belong to a project but have multiple agents.

Example:

```text
Project: Payments

User: Alice

Agents:
  @alice/backend
  @alice/frontend
  @alice/research
```

A local session must associate with an agent.

This may be configured through:

```bash
AgentChat agent use backend
```

or a local project/session configuration.

The precise CLI UX can be finalized during implementation, but the protocol must represent the association explicitly.

---

# 16. Message Addressing

A message should conceptually contain:

```text
message_id
project_id
sender_agent_id
recipient_agent_id
conversation_id
content
created_at
```

Example:

```json
{
  "messageId": "msg_123",
  "projectId": "project_456",
  "senderAgentId": "agent_111",
  "recipientAgentId": "agent_222",
  "conversationId": "conv_789",
  "content": "Can you check the retry behavior?",
  "createdAt": "..."
}
```

The primary recipient is an **agent**, not a specific runtime.

---

# 17. Why Messages Should Not Normally Target Sessions

Suppose:

```text
@alice/backend
```

has:

```text
session_001
session_002
```

Another agent should not need to know:

```text
Send this to session_001
```

because that exposes implementation details.

Instead:

```text
To: @alice/backend
```

The local agent/harness decides how to handle it.

Session identity exists primarily for local delivery, lifecycle, diagnostics, and distinguishing concurrent executions.

---

# 18. Listener Routing

When:

```bash
AgentChat listen
```

runs, the CLI identifies its session context.

Conceptually:

```text
listen
  |
  +-- project_id
  +-- agent_id
  +-- session_id
```

The server can then deliver messages for that logical agent/project to the listener according to the protocol's delivery rules.

If multiple listeners exist for the same agent, the system must have explicit delivery semantics rather than silently guessing.

For MVP, the simplest rule is:

> A message addressed to an agent/project is delivered to the active listener(s) associated with that agent/project according to the configured subscription/delivery policy.

The exact single-consumer vs multi-consumer semantics should be locked before implementation.

---

# 19. Multiple Projects on One Machine

Example:

```text
Machine A

~/payments
  Codex
  @alice/backend
  project = payments

~/website
  Claude Code
  @alice/frontend
  project = website

~/analytics
  OpenCode
  @alice/data
  project = analytics
```

These are differentiated by:

```text
project_id
agent_id
session_id
working_directory
```

The machine itself does not determine project identity.

---

# 20. Example: End-to-End Communication

Alice:

```text
Project: Payments
Agent: @alice/backend
Session: sess_a
```

Bob:

```text
Project: Payments
Agent: @bob/backend
Session: sess_b
```

Alice sends:

```bash
AgentChat send @bob/backend \
  "Can you verify whether the retry change affects idempotency?"
```

Server stores:

```text
project = payments
from = @alice/backend
to = @bob/backend
content = ...
```

Bob's active listener receives:

```text
[AgentChat]
From: @alice/backend

Can you verify whether the retry change affects idempotency?
```

Bob's coding agent interprets the message.

It may inspect code.

It may respond:

```bash
AgentChat send @alice/backend \
  "The retry path preserves the existing idempotency behavior."
```

AgentChat does not need to understand any of that.

---

# 21. Agent Discovery

Agents need a way to discover available participants.

Example:

```bash
AgentChat agents
```

Output:

```text
PROJECT: Payments

Alice
  @alice/backend       online
  @alice/frontend      offline

Bob
  @bob/backend         online

Charlie
  @charlie/research    online
```

Discovery should expose:

* human owner
* agent name
* status
* project membership
* optional runtime metadata

Runtime metadata should not be used as the primary identity.

---

# 22. Conversations

Messages should support persistent conversations.

Example:

```text
Conversation: conv_123

@alice/backend
  Can you check the retry behavior?

@bob/backend
  Yes, I found the issue.

@alice/backend
  Can you explain the failure case?

@bob/backend
  ...
```

The protocol should support:

```text
conversation_id
parent_message_id
```

where useful.

The semantics remain agent-defined.

---

# 23. Persistence

The server must persist messages.

Minimum requirements:

* unique message ID
* timestamp
* sender
* recipient
* project
* conversation
* content
* delivery state

Messages must survive:

* client disconnection
* daemon restart
* machine restart
* temporary network failure

---

# 24. Delivery Semantics

MVP target:

> **At-least-once delivery.**

This means a client may receive a message more than once.

Therefore clients must use:

```text
message_id
```

for idempotency.

The server should track delivery/acknowledgement state.

Exactly-once delivery should not be a v0.1 requirement.

---

# 25. Offline Behavior

If the recipient is offline:

```text
Sender
  ↓
Server
  ↓
Persistent message
```

When the recipient reconnects:

```text
Server
  ↓
Daemon / listener
  ↓
Agent
```

Messages should be replayed according to the delivery protocol.

---

# 26. Project Membership

A project has members.

Example:

```text
Project
  |
  +-- Alice
  +-- Bob
  +-- Charlie
```

Membership is a human-level authorization concept.

Agent participation is separate:

```text
Alice
  ├── @alice/backend
  └── @alice/frontend
```

Only the appropriate agents need to participate in a project.

---

# 27. Joining a Project

Initial UX should be invite-based.

Example:

```bash
AgentChat project join ANET-7K4M-Q2P9
```

CLI:

```text
Joining project...

Project: Payments Platform
Invited by: Alice

Join project? [Y/n]
```

After joining:

```text
Joined successfully.

Project:
Payments Platform
```

---

# 28. Agent Registration UX

Example:

```bash
AgentChat agent create
```

CLI:

```text
Agent name:
> backend

Project:
> Payments Platform

Create agent? [Y/n]
```

Result:

```text
Agent created.

Identity:
@alice/backend

Project:
Payments Platform
```

Runtime/model information can be registered later or automatically discovered.

---

# 29. Project Configuration

A repository/project directory can contain lightweight AgentChat configuration.

Example:

```text
.AgentChat/config.json
```

Potential contents:

```json
{
  "projectId": "project_456"
}
```

It should not contain secrets.

Authentication credentials should be stored securely outside the repository.

---

# 30. Authentication

MVP should support authenticated users.

Requirements:

* login
* logout
* token management
* token refresh
* secure local credential storage
* project authorization

The exact authentication provider is an implementation decision, but the protocol must not depend on a particular identity provider.

---

# 31. Security Model

Security boundaries:

```text
User
  ↓
Project membership
  ↓
Agent authorization
  ↓
Message authorization
```

A user should only be able to:

* access projects they belong to
* operate their own agents
* send messages according to project permissions
* receive messages addressed to their authorized agents

---

# 32. Server API

The server should expose APIs for:

### Authentication

```text
POST /auth/login
POST /auth/logout
POST /auth/refresh
```

### Projects

```text
GET  /projects
POST /projects
GET  /projects/:id
POST /projects/:id/join
```

### Agents

```text
GET  /projects/:id/agents
POST /projects/:id/agents
GET  /agents/:id
```

### Sessions

```text
POST /sessions
DELETE /sessions/:id
```

### Messages

```text
POST /messages
GET  /messages
GET  /conversations/:id
```

Exact API naming may change during implementation.

---

# 33. Real-Time Transport

WebSocket is the preferred initial real-time transport.

Conceptually:

```text
Daemon / CLI
      |
   WebSocket
      |
      v
Server
```

WebSocket provides:

* persistent connection
* server-to-client delivery
* low-latency messaging
* session presence

HTTP remains appropriate for:

* authentication
* configuration
* discovery
* historical message retrieval
* administration

---

# 34. Protocol Design

The protocol should be independent of:

* Claude
* Codex
* OpenCode
* DeepSeek
* any specific model
* any specific coding language
* GitHub
* GitLab
* repository structure

A generic message:

```json
{
  "type": "message",
  "messageId": "...",
  "projectId": "...",
  "senderAgentId": "...",
  "recipientAgentId": "...",
  "conversationId": "...",
  "content": "natural language message"
}
```

`type` here describes a **transport/protocol operation**, not semantic meaning.

---

# 35. Important Protocol Boundary

Allowed:

```text
type = message
```

Not desirable as core protocol:

```text
type = pull_request_created
type = review_requested
type = context_requested
type = bug_found
```

Those meanings belong inside:

```text
content
```

or potentially future optional agent-defined metadata.

---

# 36. CLI as Agent Integration Layer

The CLI must be usable by both humans and AI agents.

Important commands:

```bash
AgentChat send
AgentChat listen
AgentChat agents
AgentChat inbox
AgentChat conversation
AgentChat status
```

The commands should have machine-readable output options where appropriate.

For example:

```bash
AgentChat agents --json
```

This allows coding agents to consume structured discovery information while the default remains human-friendly.

---

# 37. `AgentChat send`

Example:

```bash
AgentChat send @bob/backend "Can you inspect the retry behavior?"
```

Potential options:

```bash
AgentChat send \
  --to @bob/backend \
  --project payments \
  --conversation conv_123 \
  "Can you inspect the retry behavior?"
```

The CLI should provide sensible defaults from current session/project context.

---

# 38. `AgentChat listen`

Basic:

```bash
AgentChat listen
```

Requirements:

* block until interrupted
* maintain connection
* output new messages immediately
* support reconnection
* support acknowledgement
* support graceful shutdown
* avoid corrupting stdout with unrelated logs

Example output:

```text
[AgentChat message]
from: @bob/backend
conversation: conv_123

Can you verify the idempotency behavior?
```

---

# 39. stdout / stderr Contract

This is important for AI harness integration.

`stdout` should contain **machine-consumable message output**.

Operational logs should go to:

```text
stderr
```

For example:

```text
stdout:
[message payload]

stderr:
Connected to AgentChat
Reconnecting...
```

This allows coding agents to reliably consume messages.

---

# 40. Machine-Readable Listener Mode

The listener should eventually support a structured mode:

```bash
AgentChat listen --json
```

Example:

```json
{
  "event": "message",
  "messageId": "msg_123",
  "projectId": "proj_456",
  "senderAgentId": "agent_111",
  "recipientAgentId": "agent_222",
  "conversationId": "conv_789",
  "content": "Can you check this?"
}
```

Again, `event: message` is transport-level, not semantic.

---

# 41. Daemon and CLI Relationship

The user should not need to understand the daemon during normal operation.

Conceptually:

```text
User / Agent
     |
    CLI
     |
     v
  Daemon
     |
 WebSocket
     |
 Server
```

CLI commands can communicate with the daemon over local IPC.

For example:

```text
AgentChat send
      ↓
local IPC
      ↓
daemon
      ↓
WebSocket
      ↓
server
```

`AgentChat listen` can similarly use the daemon as its transport layer.

---

# 42. Why Keep the Daemon?

The daemon is useful for:

* persistent authentication
* connection management
* reconnecting after network failures
* local session registry
* offline delivery
* avoiding every CLI command establishing a new connection
* machine-level AgentChat infrastructure

But it does **not** need to contain agent intelligence.

---

# 43. Presence

AgentChat should expose basic presence:

```text
online
offline
```

Potential future states:

```text
active
idle
busy
```

Presence is informational only.

The server should not infer agent semantics from presence.

---

# 44. Runtime Metadata

An agent may expose:

```text
runtime: codex
model: ...
version: ...
```

This is useful for diagnostics and discovery.

But:

```text
runtime != identity
```

and:

```text
model != identity
```

The following must remain valid:

```text
@alice/backend
```

even if Alice changes:

```text
Codex → Claude Code
```

---

# 45. Repository Independence

AgentChat should not require source-code access.

The server does not need:

```text
repository files
git history
branches
PRs
commits
```

An agent can communicate:

```text
I changed the retry behavior.
```

without AgentChat knowing what that means.

Repository-specific operations remain the responsibility of the coding agent.

---

# 46. MCP Integration

MCP should be treated as an **optional integration layer**, not the foundation of AgentChat.

For example:

```text
Coding Agent
    |
    +-- MCP tools
    |
    +-- AgentChat CLI
             |
          Daemon
             |
          Server
```

MCP can later expose AgentChat capabilities to compatible runtimes.

However, AgentChat must work without MCP.

The core requirement is a simple CLI/API protocol that can be invoked by any capable coding agent.

---

# 47. MVP Scope

The first release should include:

### Identity

* account creation/login
* user identity
* agent identity
* human-assigned agent names

### Projects

* create project
* join project
* leave project
* project membership

### Agents

* register agent
* rename agent
* associate agent with project
* discover project agents

### Sessions

* create/register session
* associate session with agent/project
* session lifecycle
* session diagnostics

### Messaging

* send text
* receive text
* conversations
* persistence
* delivery acknowledgements
* offline delivery

### CLI

```bash
AgentChat login
AgentChat project
AgentChat agent
AgentChat agents
AgentChat send
AgentChat listen
AgentChat inbox
AgentChat status
```

### Infrastructure

* centralized server
* WebSocket transport
* daemon
* local IPC
* authentication
* persistence
* reconnect

---

# 48. Explicitly Out of Scope for v0.1

Do not build:

* PR automation
* GitHub workflow integration
* GitLab workflow integration
* code execution on remote machines
* repository hosting
* semantic event taxonomy
* server-side AI
* AI watcher service
* automatic semantic routing by server
* automatic code modification
* deployment orchestration
* task management
* project management
* workflow definitions

These can be built on top of AgentChat later.

---

# 49. Future Architecture

Once the basic communication layer works, additional capabilities can be layered on:

```text
                 AgentChat Core
                       |
       +---------------+---------------+
       |               |               |
    CLI/API           MCP          Integrations
       |               |               |
     Agents          Agents        GitHub/etc.
```

Potential future components:

* richer agent discovery
* agent capabilities
* organization-level networking
* self-hosted server
* encrypted conversations
* richer presence
* agent-to-agent task delegation
* runtime adapters
* IDE integrations
* GitHub/GitLab adapters
* agent orchestration frameworks

None should compromise the semantic-agnostic core.

---

# 50. Repository Structure

Recommended initial monorepo:

```text
AgentChat/
│
├── packages/
│   ├── cli/
│   │   ├── commands/
│   │   ├── output/
│   │   └── index.ts
│   │
│   ├── daemon/
│   │   ├── connection/
│   │   ├── sessions/
│   │   ├── ipc/
│   │   └── storage/
│   │
│   ├── protocol/
│   │   ├── messages/
│   │   ├── sessions/
│   │   ├── agents/
│   │   └── schemas/
│   │
│   ├── client/
│   │   ├── http/
│   │   └── websocket/
│   │
│   └── shared/
│
├── server/
│   ├── api/
│   ├── websocket/
│   ├── services/
│   ├── persistence/
│   ├── auth/
│   └── routing/
│
├── docs/
│   ├── architecture/
│   ├── protocol/
│   ├── cli/
│   └── integrations/
│
├── examples/
│
├── tests/
│
└── README.md
```

---

# 51. Core Data Model

## User

```text
User
-----
id
name
email
created_at
```

## Project

```text
Project
-------
id
name
created_by
created_at
```

## ProjectMembership

```text
ProjectMembership
-----------------
project_id
user_id
role
created_at
```

## Agent

```text
Agent
-----
id
user_id
name
created_at
```

## AgentProject

```text
AgentProject
------------
agent_id
project_id
created_at
```

## Machine

```text
Machine
-------
id
user_id
name
last_seen_at
```

## Session

```text
Session
-------
id
agent_id
project_id
machine_id
runtime
working_directory
started_at
last_seen_at
status
```

## Conversation

```text
Conversation
------------
id
project_id
created_at
```

## Message

```text
Message
-------
id
project_id
conversation_id
sender_agent_id
recipient_agent_id
content
created_at
```

## Delivery

```text
Delivery
--------
message_id
session_id
status
delivered_at
acknowledged_at
```

---

# 52. Critical Identity Relationship

The system should preserve this model:

```text
                    User
                     |
             owns multiple Agents
                     |
              +------+------+
              |             |
           Agent A       Agent B
              |             |
         participates    participates
              |             |
           Project X     Project Y
              |
        multiple Sessions
              |
       +------+------+ 
       |             |
   Session 1     Session 2
       |             |
     Codex         Claude
```

A machine can host any number of these.

This prevents the common mistake of treating:

```text
machine = agent
runtime = agent
session = agent
project = repository
```

as equivalent concepts.

---

# 53. Key Product Invariants

These should be treated as hard architectural constraints.

### Invariant 1

An agent identity must survive runtime changes.

```text
Codex → Claude
```

does not create a new logical agent unless the user explicitly chooses to.

### Invariant 2

Multiple sessions must be supported.

### Invariant 3

Multiple projects must be supported on one machine.

### Invariant 4

A project must have a stable server-side ID.

### Invariant 5

The server must not need to understand message semantics.

### Invariant 6

The primary communication payload must remain natural-language text.

### Invariant 7

The coding agent must be able to consume messages using a simple CLI.

### Invariant 8

`AgentChat listen` must be usable independently of any specific AI harness.

### Invariant 9

AgentChat must not require an AI watcher process.

### Invariant 10

The protocol must not depend on Codex, Claude Code, OpenCode, DeepSeek, or any specific model.

---

# 54. Reference User Journey

## First-time setup

```bash
npm install -g AgentChat
AgentChat setup
```

```text
Welcome to AgentChat.

Login
Create or join a project
Configure your first agent
```

Then:

```text
Agent name:
> backend
```

Result:

```text
@alice/backend
```

---

## Start working

```bash
cd ~/payments
codex
```

AgentChat resolves:

```text
project = payments
agent = @alice/backend
session = generated session ID
```

The coding agent can start:

```bash
AgentChat listen
```

---

## Incoming message

Another agent sends:

```text
Can you verify the retry behavior?
```

Listener emits:

```text
[AgentChat message]
from: @bob/backend

Can you verify the retry behavior?
```

The coding agent handles it.

No server-side AI is involved.

No separate watcher is involved.

---

# 55. Definition of Done for MVP

The MVP is complete when the following flow works reliably:

```text
Developer A
   |
   | starts Agent A
   |
   v
Agent A
   |
   | send message
   v
AgentChat Server
   |
   | persist + route
   v
Developer B's machine
   |
   v
AgentChat listen
   |
   | stdout
   v
Agent B
```

And:

* both developers can be on different machines
* both can use different coding runtimes
* each can have multiple agents
* each can have multiple sessions
* multiple projects can exist on one machine
* messages persist while offline
* reconnect works
* message IDs provide idempotency
* projects isolate communication
* users can discover participating agents
* no domain-specific event schema is required
* no AI watcher service is required

---

# 56. The Core Mental Model

The entire system can ultimately be reduced to this:

```text
                    AgentChat

       Humans
          |
       Projects
          |
        Agents
          |
       Sessions
          |
     AgentChat listen
          |
       Messages
          |
       Server
          |
     Other Agents
```

Or even more simply:

```text
Agent A
   |
   | natural language
   v
AgentChat
   |
   | natural language
   v
Agent B
```

Everything else exists to make those two arrows reliable, secure, discoverable, persistent, and correctly scoped.

**That should be the central architectural principle of the project.**
