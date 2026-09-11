/**
 * `docs/cli.md` is checked against the built binary.
 *
 * The CLI reference went stale five times in its first two days: a wrong
 * install command, a missing `setup` section, a wrong claim that two message
 * shapes match, a stale protocol version, and a stale agent-name grammar. Nobody
 * was careless. The file had no mechanism, so it drifted every time a command
 * or a constant moved, while `docs/protocol.md`, which has a test behind it,
 * never did. This file is that mechanism for the CLI reference.
 *
 * Two comparisons, both against the shipped tool rather than against a source
 * constant, so the test fails when the document and the binary a user installs
 * disagree, not when two source files do:
 *
 * - Every `### agentchat <command>` heading names a command the binary lists in
 *   `agentchat --help --json`, and every command the binary lists has a
 *   heading. Subcommands are held to the same rule under their group's
 *   heading. This alone would have caught the missing `setup` section.
 * - Every `--json` transcript the binary can reproduce offline is reproduced:
 *   the command is run in an empty directory with an empty configuration and
 *   no server, and the key set of what it printed is compared with the key set
 *   the document shows, along with the error code and the exit code where the
 *   transcript records them. This would have caught a renamed field in the
 *   failure envelope or in `version`.
 *
 * ## What this check cannot see
 *
 * A wrong *sentence* about a shape whose keys are right. The claim that the
 * streamed and listed message shapes match field for field was exactly that,
 * and so was the stale grammar: prose, correct in every key it named. Nor can it
 * reproduce a transcript that needs a server or a project, which is most of
 * them; those examples are checked by the end-to-end suite against the code
 * that produces them, not against the document. A green run here means the
 * command list and the offline shapes are current. It does not mean the
 * document is correct.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildPackage, PACKAGE_ROOT, parseNdjson, runCli } from './spawn.js';

/** The document under test. */
const DOCUMENT = join(PACKAGE_ROOT, '..', '..', 'docs', 'cli.md');

const lines = readFileSync(DOCUMENT, 'utf8').split('\n');

/** One entry of `agentchat --help --json`, as much of it as this file reads. */
interface HelpEntry {
  readonly kind: 'command' | 'group';
  readonly name: string;
  readonly commands?: readonly HelpEntry[];
}

function isHelpEntry(value: unknown): value is HelpEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  if (entry['kind'] !== 'command' && entry['kind'] !== 'group') {
    return false;
  }
  if (typeof entry['name'] !== 'string') {
    return false;
  }
  return entry['commands'] === undefined || Array.isArray(entry['commands']);
}

/**
 * The command tree the binary reports.
 *
 * @returns The top-level entries of `agentchat --help --json`.
 * @throws If stdout is not the documented capability probe.
 */
async function helpTree(): Promise<readonly HelpEntry[]> {
  const run = await runCli(['--help', '--json']);
  expect(run.code).toBe(0);
  const [document] = parseNdjson(run.stdout);
  if (typeof document !== 'object' || document === null) {
    throw new Error('`agentchat --help --json` did not print an object.');
  }
  const commands = (document as Record<string, unknown>)['commands'];
  if (!Array.isArray(commands) || !commands.every(isHelpEntry)) {
    throw new Error('`agentchat --help --json` did not print a `commands` array of entries.');
  }
  return commands;
}

/**
 * The command headings in the document.
 *
 * `### \`agentchat <name>\`` introduces a top-level command or group, and a
 * `#### \`<group> <name>\`` heading that follows a group's heading introduces
 * one of its subcommands. Any other level-four heading (an option such as
 * `--runtime`, a sub-topic) is not a command and is ignored, which is what lets
 * the document explain a command in several parts without this test reading
 * each part as a claim that another command exists.
 *
 * @returns Top-level names, and subcommand names by group.
 */
function documentedCommands(): {
  readonly top: ReadonlySet<string>;
  readonly subcommands: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const top = new Set<string>();
  const subcommands = new Map<string, Set<string>>();
  let currentGroup: string | null = null;

  for (const line of lines) {
    const topLevel = /^### `agentchat ([a-z-]+)`\s*$/.exec(line);
    if (topLevel?.[1] !== undefined) {
      top.add(topLevel[1]);
      currentGroup = topLevel[1];
      continue;
    }
    if (/^#{1,3} /.test(line)) {
      currentGroup = null;
      continue;
    }
    const nested = /^#### `([a-z-]+) ([a-z-]+)`\s*$/.exec(line);
    if (nested?.[1] !== undefined && nested[2] !== undefined && nested[1] === currentGroup) {
      let set = subcommands.get(currentGroup);
      if (set === undefined) {
        set = new Set<string>();
        subcommands.set(currentGroup, set);
      }
      set.add(nested[2]);
    }
  }
  return { top, subcommands };
}

/** A `--json` transcript in the document that the binary can reproduce offline. */
interface OfflineTranscript {
  /** The arguments after `agentchat`, exactly as the transcript shows them. */
  readonly argv: readonly string[];
  /** The first line of stdout the transcript shows, parsed. */
  readonly shown: Record<string, unknown>;
  /** The exit code the transcript records, when it records one. */
  readonly exit: number | null;
  /** Where in the document it is, for the failure message. */
  readonly line: number;
}

/**
 * The transcripts this test reproduces, keyed by their exact argument list.
 *
 * Each runs with an empty configuration directory, in an empty working
 * directory, and with no server named, so it needs no network and no project.
 * A transcript whose arguments are not listed here is not checked; the module
 * note says why.
 */
const OFFLINE: ReadonlySet<string> = new Set([
  '--json version',
  '--json --json version',
  '--json project current',
  '--json setup',
]);

/**
 * The reproducible `--json` transcripts in the document.
 *
 * A transcript is a fenced `console` block in which a `$ agentchat …` line is
 * followed by a line that is a JSON object. A trailing `; echo "exit=$?"` on
 * the command line is stripped, and the `exit=N` line that follows the output
 * is read as the exit code the transcript records.
 *
 * @returns Every transcript whose arguments are in {@link OFFLINE}.
 */
function offlineTranscripts(): OfflineTranscript[] {
  const found: OfflineTranscript[] = [];
  let inConsole = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('```')) {
      inConsole = line.trim() === '```console';
      continue;
    }
    if (!inConsole) {
      continue;
    }
    const command = /^\$ agentchat (.*?)(?:\s*;\s*echo "exit=\$\?")?\s*$/.exec(line);
    const output = lines[index + 1] ?? '';
    if (command?.[1] === undefined || !output.startsWith('{')) {
      continue;
    }
    if (!OFFLINE.has(command[1])) {
      continue;
    }
    const exitLine = /^exit=(\d+)$/.exec(lines[index + 2] ?? '');
    let shown: unknown;
    try {
      shown = JSON.parse(output);
    } catch (cause) {
      throw new Error(
        `docs/cli.md line ${String(index + 2)} is shown as JSON output and does not parse.`,
        {
          cause,
        },
      );
    }
    if (typeof shown !== 'object' || shown === null || Array.isArray(shown)) {
      throw new Error(
        `docs/cli.md line ${String(index + 2)} is shown as JSON output and is not an object.`,
      );
    }
    found.push({
      argv: command[1].split(' '),
      shown: shown as Record<string, unknown>,
      exit: exitLine?.[1] === undefined ? null : Number(exitLine[1]),
      line: index + 1,
    });
  }
  return found;
}

/**
 * Gives the working directory the repository file a transcript assumes.
 *
 * `project current` reaches no network, so a transcript that shows a project
 * resolved from the repository is reproducible offline once the directory holds
 * the `.agentchat/config.json` the document's worked example describes. The
 * identifier and slug are taken from the transcript itself, so the file is the
 * one the document claims produced that output.
 *
 * @param cwd - The empty directory the command will run in.
 * @param shown - The output the transcript shows.
 */
function linkRepository(cwd: string, shown: Record<string, unknown>): void {
  const project = shown['project'];
  if (typeof project !== 'object' || project === null) {
    return;
  }
  const { id, slug, source } = project as Record<string, unknown>;
  if (source !== 'repository' || typeof id !== 'string' || typeof slug !== 'string') {
    return;
  }
  // The document elides long identifiers to `prj_…` in most transcripts. The
  // file needs a real one, and the keys are what is compared, so any valid
  // identifier serves; this is the one the worked example spells out in full.
  const projectId = id.includes('…') ? 'prj_0199a1f0-1c2a-7c9c-9d40-1f3a0e5b7c21' : id;
  mkdirSync(join(cwd, '.agentchat'));
  writeFileSync(
    join(cwd, '.agentchat', 'config.json'),
    `${JSON.stringify({ projectId, projectSlug: slug }, null, 2)}\n`,
  );
}

/** The sorted key set of an object, or `null` for anything that is not one. */
function keysOf(value: unknown): readonly string[] | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.keys(value).sort();
}

beforeAll(async () => {
  await buildPackage();
});

describe('docs/cli.md names the commands the binary has', () => {
  it('has a heading for every top-level command and group, and no heading for anything else', async () => {
    const tree = await helpTree();
    const listed = tree.map((entry) => entry.name).sort();
    const documented = [...documentedCommands().top].sort();
    expect(
      documented,
      'Every `### `agentchat <name>`` heading must name a command the binary lists, and every listed command needs a heading.',
    ).toEqual(listed);
  });

  it('documents every subcommand of every group under that group, and nothing more', async () => {
    const tree = await helpTree();
    const { subcommands } = documentedCommands();
    for (const group of tree.filter((entry) => entry.kind === 'group')) {
      const listed = (group.commands ?? []).map((entry) => entry.name).sort();
      const documented = [...(subcommands.get(group.name) ?? [])].sort();
      expect(
        documented,
        `Under \`### agentchat ${group.name}\`, the \`#### \`${group.name} <name>\`\` headings must match the subcommands the binary lists.`,
      ).toEqual(listed);
    }
  });
});

describe('docs/cli.md shows the shapes the binary prints', () => {
  it('finds the transcripts it expects to reproduce', () => {
    const argv = new Set(offlineTranscripts().map((transcript) => transcript.argv.join(' ')));
    expect(
      argv,
      'Each of these transcripts is in the document and reproduced here. One missing means the document lost an example, or the block is no longer a `console` fence with a `$ agentchat` line followed by its JSON output.',
    ).toEqual(OFFLINE);
  });

  for (const transcript of offlineTranscripts()) {
    it(`reproduces \`agentchat ${transcript.argv.join(' ')}\` (line ${String(transcript.line)})`, async () => {
      const configHome = mkdtempSync(join(tmpdir(), 'agentchat-cli-doc-config-'));
      const cwd = mkdtempSync(join(tmpdir(), 'agentchat-cli-doc-cwd-'));
      linkRepository(cwd, transcript.shown);
      const run = await runCli(transcript.argv, {
        cwd,
        env: { XDG_CONFIG_HOME: configHome, HOME: cwd },
      });

      const [printed] = parseNdjson(run.stdout);
      expect(keysOf(printed), 'the keys of the first JSON line on stdout').toEqual(
        keysOf(transcript.shown),
      );

      const printedError = (printed as Record<string, unknown>)['error'];
      const shownError = transcript.shown['error'];
      if (shownError !== undefined) {
        expect(keysOf(printedError), 'the keys of the error envelope').toEqual(keysOf(shownError));
        expect((printedError as Record<string, unknown>)['code'], 'the error code').toBe(
          (shownError as Record<string, unknown>)['code'],
        );
      }

      if (transcript.exit !== null) {
        expect(run.code, 'the exit code the transcript records').toBe(transcript.exit);
      }
    });
  }
});
