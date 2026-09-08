#!/usr/bin/env node
/**
 * AgentChat licence boundary check.
 *
 * This repository is split-licensed. `packages/`, `examples/` and `scripts/`
 * are MIT; `server/` and `deploy/` are AGPL-3.0-or-later. See LICENSE.
 *
 * Licence compatibility runs one way. MIT code may be absorbed into an AGPL
 * work; AGPL code may not be absorbed into an MIT one. So the direction of
 * every dependency edge between those two halves is a legal constraint, not an
 * architectural preference, and a single import in the wrong direction
 * relicenses the permissive half of the project by accident. The people harmed
 * are the ones who embedded the MIT half in good faith: their remedy after a
 * release is a relicence, not a patch.
 *
 * That is why this is a machine check and not a line in a review checklist.
 *
 * Four things are enforced:
 *
 *   1. No file under a permissive root imports, requires, re-exports, or
 *      dynamically loads anything under a copyleft root — directly, through a
 *      workspace package name, or through a TypeScript path alias.
 *   2. No package manifest under a permissive root depends on a package that
 *      lives under a copyleft root. A dependency edge does not need a source
 *      import to have legal effect.
 *   3. Every package manifest declares the `license` its path actually carries.
 *   4. Every dependency reachable from `packages/` is permissively licensed.
 *
 * Usage: node scripts/check-licenses.mjs [check|selftest] [--verbose]
 * Run with --help for the full list.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// The licence map, transcribed from LICENSE
// ---------------------------------------------------------------------------

/**
 * Which licence each top-level directory carries, and which side of the
 * one-way boundary it sits on. `permissive` may never depend on `copyleft`.
 *
 * Keep this table in step with the table in LICENSE. If they disagree, LICENSE
 * is the document with legal effect and this file is the bug.
 */
const AREAS = [
  { dir: 'packages', spdx: 'MIT', side: 'permissive' },
  { dir: 'examples', spdx: 'MIT', side: 'permissive' },
  { dir: 'scripts', spdx: 'MIT', side: 'permissive' },
  { dir: 'server', spdx: 'AGPL-3.0-or-later', side: 'copyleft' },
  { dir: 'deploy', spdx: 'AGPL-3.0-or-later', side: 'copyleft' },
  { dir: 'docs', spdx: 'CC-BY-4.0', side: 'docs' },
];

/**
 * The root manifest is private and covers a tree with two licences, so it
 * points at the file rather than naming one identifier.
 */
const ROOT_MANIFEST_LICENCE = 'SEE LICENSE IN LICENSE';

/**
 * Licences a dependency of an MIT package may carry.
 *
 * LICENSE states the rule as "MIT, ISC, BSD, or Apache-2.0"; these are the
 * SPDX identifiers in those four families. Adding an entry here is a licensing
 * decision about what this project is willing to redistribute under MIT, not a
 * maintenance chore — a bare "BSD" is deliberately absent, because it does not
 * say which BSD variant is meant and the four-clause one carries an
 * advertising requirement MIT does not.
 */
const PERMISSIVE_DEPENDENCY_LICENCES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'MIT-0',
]);

/** Source files worth scanning for module specifiers. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Directories that are build output, dependencies, or version control. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo']);

// ---------------------------------------------------------------------------
// Why each failure matters
// ---------------------------------------------------------------------------

/**
 * The explanation printed with each finding.
 *
 * These are long on purpose. Someone hits this check at 2am, having done
 * something that looks entirely reasonable, and needs to understand that the
 * problem is a licence and not a lint rule — otherwise the next move is to
 * find the flag that turns the check off.
 */
const WHY = {
  'boundary-import': [
    'The importing file is MIT. The file it reaches into is AGPL-3.0-or-later.',
    'An MIT file that imports AGPL code forms a combined work that may only be',
    'distributed under the AGPL, so this edge silently relicenses the permissive',
    'half of the project. Everyone who embedded it in a closed product on the',
    'strength of the MIT licence would then be distributing AGPL code without',
    'knowing it, and once that has shipped the remedy is a relicence and a',
    'recall, not a patch. Compatibility runs one way only: MIT may be absorbed',
    'into an AGPL work, never the reverse.',
  ],
  'boundary-alias': [
    'A path alias that points from the MIT half into the AGPL half is a loaded',
    'gun even before anybody fires it: the next contributor sees a short,',
    'blessed-looking specifier with no ../.. in it and has no way to tell that',
    'using it changes the licence of what they are writing. The boundary has to',
    'be visible in the code, not hidden behind a mapping in a config file.',
  ],
  'boundary-reference': [
    'A TypeScript project reference is a build dependency: it makes the AGPL',
    'project an input to compiling the MIT one, and it makes every type in it',
    'reachable. Types are source code and carry the licence of the file they',
    'were written in, so this is the same relicensing problem as an import with',
    'an extra step.',
  ],
  'boundary-dependency': [
    'A manifest dependency has legal effect on its own, with no source import',
    'anywhere. The manifest is what a package manager resolves and what a',
    'downstream consumer installs, so declaring the AGPL server package as a',
    'dependency of an MIT package means anyone installing the MIT package pulls',
    'AGPL code into the tree they distribute, and the licence of the whole they',
    'ship becomes AGPL.',
  ],
  'manifest-license': [
    'The `license` field is the machine-readable claim this project makes to',
    'everyone downstream; scanners, corporate approval processes and lawyers',
    'read it rather than the LICENSE file. A package under the MIT half that',
    'claims AGPL turns away exactly the embedders that half exists to serve. A',
    'package under the AGPL half that claims MIT is worse and is not reversible:',
    'anyone who relied on that grant keeps it, and the reciprocity the AGPL was',
    'chosen to protect is gone for good.',
  ],
  'dependency-license': [
    'Everything under packages/ is redistributed under MIT, and its dependency',
    'tree is redistributed with it. A dependency that is not MIT-compatible',
    'imposes its own terms on that combined work — or, when nobody can tell what',
    'its terms are, grants no permission to redistribute it at all. Either way,',
    'anyone shipping this package inside a closed product would be relying on a',
    'grant that does not exist, and this project would be the reason. Copyleft',
    'dependencies are fine under server/, which is already AGPL and already',
    'promises reciprocity.',
  ],
};

/** The concrete way out, printed under the explanation. */
const FIX = {
  'boundary-import': [
    'Move the shared code down into packages/protocol, which is MIT and which',
    'server/ is allowed to depend on, and import it from both sides. If the code',
    'genuinely belongs to the server, then so does the caller: move the caller',
    'under server/ instead.',
  ],
  'boundary-alias': ['Delete the alias. If the target is shared code, move it under packages/.'],
  'boundary-reference': [
    'Remove the reference. A package under packages/ must be buildable without',
    'server/ present at all.',
  ],
  'boundary-dependency': [
    'Remove the dependency and depend on packages/protocol instead. The server',
    'may depend on packages/; packages/ may never depend on the server.',
  ],
  'manifest-license': ['Set the `license` field to the identifier LICENSE gives for this path.'],
  'dependency-license': [
    'Replace the dependency with a permissively licensed equivalent, or move the',
    'code that needs it under server/ and reach it over the wire instead.',
  ],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Path relative to the tree being analysed, with forward slashes. */
function rel(root, path) {
  return relative(root, path).split(sep).join('/');
}

/** True when `path` is inside `dir` (or is `dir` itself). */
function isInside(dir, path) {
  const r = relative(dir, path);
  return r === '' || (!r.startsWith('..') && !r.startsWith(`${sep}..`) && !r.startsWith('/'));
}

/** The area of the licence map a path belongs to, or undefined. */
function areaOf(root, path) {
  return AREAS.find((area) => isInside(join(root, area.dir), path));
}

/**
 * Parse JSON with comments and trailing commas, as tsconfig files use.
 *
 * The comment stripping is a character scanner rather than a pair of regular
 * expressions, because a tsconfig is full of strings that look like comments:
 * `"src/**\/*.ts"` closes a block comment and `"https://…"` opens a line one.
 * The regex version of this function silently ate the `paths` block of every
 * tsconfig in this repository, which is exactly the kind of quiet failure a
 * licence check must not have — it looked green because it had stopped
 * looking. JSON strings have no regular-expression-literal ambiguity, so a
 * scanner here is short and exactly correct.
 */
function parseJsonc(text, file) {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') {
        index += text[index] === '\\' ? 2 : 1;
      }
      out += text.slice(start, ++index);
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
    } else if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index += 2;
    } else {
      out += char;
      index++;
    }
  }

  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${error instanceof Error ? error.message : error})`);
  }
}

/** Every file under `dir` with one of `extensions`, skipping build output. */
function collectFiles(dir, extensions) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      out.push(...collectFiles(path, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(path);
    }
  }
  return out;
}

/** 1-based line number of a character offset. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * True when the match at `index` sits inside a comment.
 *
 * Deliberately a heuristic rather than a parser. A real tokenizer has to know
 * regular-expression literals from division, and getting that wrong in this
 * particular script means a missed violation, which is the one outcome that
 * must not happen. This errs the other way: it only forgives a match on a line
 * that is visibly commentary, so its failure mode is a false alarm somebody can
 * read and fix in ten seconds.
 */
function looksLikeComment(text, index) {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const before = text.slice(lineStart, index);
  const trimmed = before.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return true;
  // A trailing comment on an otherwise ordinary line. `://` is excluded so a
  // URL in a string does not hide the rest of the line from the check.
  const slashes = before.search(/(^|\s)\/\//);
  return slashes !== -1;
}

// ---------------------------------------------------------------------------
// Module specifiers
// ---------------------------------------------------------------------------

/**
 * Every way one module can name another, as far as this check is concerned.
 *
 * Backticks are accepted as a quote character so that a template literal with
 * an interpolated tail — `import(`../../server/${name}.js`)` — is still read as
 * a specifier: the constant prefix is enough to place it on the wrong side of
 * the boundary.
 */
const SPECIFIER_PATTERNS = [
  // import x from '…' / export { x } from '…' / export * from '…'
  { kind: 'import', re: /\b(?:import|export)\b[^;'"`()]*?\bfrom\s*(['"`])([^'"`]+)\1/g },
  // import '…' — side-effect only
  { kind: 'import', re: /\bimport\s+(['"`])([^'"`]+)\1/g },
  // await import('…')
  { kind: 'dynamic import', re: /\bimport\s*\(\s*(['"`])([^'"`]+)\1/g },
  // require('…')
  { kind: 'require', re: /\brequire\s*\(\s*(['"`])([^'"`]+)\1/g },
  // import.meta.resolve('…')
  { kind: 'import.meta.resolve', re: /\bimport\.meta\.resolve\s*\(\s*(['"`])([^'"`]+)\1/g },
];

/** A dynamic load whose target is computed, and so cannot be checked here. */
const OPAQUE_LOAD = /\b(?:import|require)\s*\(\s*(?!['"`])[^)\s]/g;

/** Pull every literal module specifier out of a source file. */
function specifiersIn(text) {
  const found = [];
  for (const { kind, re } of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let match = re.exec(text);
    while (match !== null) {
      if (!looksLikeComment(text, match.index)) {
        found.push({ kind, specifier: match[2], line: lineOf(text, match.index) });
      }
      match = re.exec(text);
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

// ---------------------------------------------------------------------------
// The workspace, as this check understands it
// ---------------------------------------------------------------------------

/**
 * Read every package manifest in the tree, along with the area it sits in.
 * The root manifest is included and marked, because it has its own rule.
 */
function readManifests(root) {
  const files = [join(root, 'package.json')];
  for (const area of AREAS) {
    const areaDir = join(root, area.dir);
    files.push(join(areaDir, 'package.json'));
    let entries = [];
    try {
      entries = readdirSync(areaDir, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) {
        files.push(join(areaDir, entry.name, 'package.json'));
      }
    }
  }

  const manifests = [];
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    manifests.push({
      file,
      display: rel(root, file),
      dir: dirname(file),
      json,
      isRoot: dirname(file) === root,
      area: areaOf(root, dirname(file)),
    });
  }
  return manifests;
}

/** Map every workspace package name to the directory it lives in. */
function packageDirectories(manifests) {
  const byName = new Map();
  for (const manifest of manifests) {
    if (!manifest.isRoot && typeof manifest.json.name === 'string') {
      byName.set(manifest.json.name, manifest.dir);
    }
  }
  return byName;
}

/**
 * Collect `compilerOptions.paths` from every tsconfig in the tree.
 *
 * Aliases are read from the whole tree rather than only from the file being
 * checked, because `extends` means a mapping declared at the root applies
 * inside every package that inherits from it.
 */
function readAliases(root) {
  const aliases = [];
  const files = collectFiles(root, ['.json']).filter((file) => {
    const name = file.split(sep).pop() ?? '';
    return name.startsWith('tsconfig') && name.endsWith('.json');
  });

  for (const file of files) {
    let json;
    try {
      json = parseJsonc(readFileSync(file, 'utf8'), rel(root, file));
    } catch {
      continue;
    }
    const options = json.compilerOptions ?? {};
    const base = resolve(dirname(file), options.baseUrl ?? '.');
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      for (const target of Array.isArray(targets) ? targets : [targets]) {
        aliases.push({ file, display: rel(root, file), pattern, target, base });
      }
    }
  }
  return aliases;
}

/** Resolve a specifier through an alias, or return undefined. */
function throughAlias(alias, specifier) {
  const star = alias.pattern.indexOf('*');
  if (star === -1) {
    return specifier === alias.pattern ? resolve(alias.base, alias.target) : undefined;
  }
  const head = alias.pattern.slice(0, star);
  const tail = alias.pattern.slice(star + 1);
  if (!specifier.startsWith(head) || !specifier.endsWith(tail)) return undefined;
  const middle = specifier.slice(head.length, specifier.length - tail.length);
  return resolve(alias.base, alias.target.replace('*', middle));
}

/**
 * Where a specifier points on disk, or undefined when it leaves the tree.
 *
 * Bare specifiers are resolved against workspace package names rather than
 * against node_modules, which is what makes `@agentchat/server` and
 * `@agentchat/server/db.js` visible as the same crossing as `../../server/db`.
 */
function resolveSpecifier(specifier, fromFile, workspace, aliases) {
  if (specifier.startsWith('node:') || specifier.startsWith('data:')) return undefined;

  if (specifier.startsWith('.')) return resolve(dirname(fromFile), specifier);
  if (specifier.startsWith('/')) return specifier;

  for (const [name, dir] of workspace) {
    if (specifier === name) return dir;
    if (specifier.startsWith(`${name}/`)) return join(dir, specifier.slice(name.length + 1));
  }

  for (const alias of aliases) {
    const target = throughAlias(alias, specifier);
    if (target !== undefined) return target;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Everything wrong with a tree, as data rather than as printed text, so that
 * the self-test can assert on it.
 */
function finding(code, where, what, extra = []) {
  return { code, where, what, extra };
}

/**
 * The whole static analysis: source imports, path aliases, project references,
 * manifest dependencies and manifest `license` fields.
 *
 * Takes the tree to analyse as an argument and touches nothing else, so the
 * self-test can point it at a fixture containing real violations.
 */
function analyse(root) {
  const findings = [];
  const opaque = [];
  const manifests = readManifests(root);
  const workspace = packageDirectories(manifests);
  const aliases = readAliases(root);
  const copyleftDirs = AREAS.filter((a) => a.side === 'copyleft').map((a) => join(root, a.dir));
  const permissiveDirs = AREAS.filter((a) => a.side === 'permissive').map((a) => join(root, a.dir));

  /** The copyleft area a resolved path falls into, if any. */
  const copyleftAreaOf = (path) => {
    if (path === undefined) return undefined;
    const dir = copyleftDirs.find((d) => isInside(d, path));
    return dir === undefined ? undefined : rel(root, dir);
  };

  // -- 1. Source imports ----------------------------------------------------
  let scanned = 0;
  for (const permissiveDir of permissiveDirs) {
    for (const file of collectFiles(permissiveDir, SOURCE_EXTENSIONS)) {
      const text = readFileSync(file, 'utf8');
      scanned++;

      for (const { kind, specifier, line } of specifiersIn(text)) {
        const target = resolveSpecifier(specifier, file, workspace, aliases);
        const crossed = copyleftAreaOf(target);
        if (crossed === undefined) continue;
        findings.push(
          finding(
            'boundary-import',
            `${rel(root, file)}:${line}`,
            `${kind} of ${specifier}, which resolves into ${crossed}/`,
            [
              `${rel(root, file)} is ${areaOf(root, file)?.spdx ?? 'MIT'}.`,
              `${rel(root, target)} is AGPL-3.0-or-later.`,
            ],
          ),
        );
      }

      OPAQUE_LOAD.lastIndex = 0;
      let match = OPAQUE_LOAD.exec(text);
      while (match !== null) {
        if (!looksLikeComment(text, match.index)) {
          opaque.push(`${rel(root, file)}:${lineOf(text, match.index)}`);
        }
        match = OPAQUE_LOAD.exec(text);
      }
    }
  }

  // -- 2. Path aliases and project references -------------------------------
  for (const alias of aliases) {
    const target = resolve(alias.base, alias.target);
    const crossed = copyleftAreaOf(target);
    const declaredIn = areaOf(root, dirname(alias.file));
    if (crossed === undefined) continue;
    if (declaredIn !== undefined && declaredIn.side === 'copyleft') continue;
    findings.push(
      finding('boundary-alias', alias.display, `maps "${alias.pattern}" into ${crossed}/`, [
        `target: ${alias.target}`,
      ]),
    );
  }

  for (const file of collectFiles(root, ['.json'])) {
    const name = file.split(sep).pop() ?? '';
    if (!name.startsWith('tsconfig') || !name.endsWith('.json')) continue;
    const area = areaOf(root, dirname(file));
    if (area === undefined || area.side !== 'permissive') continue;
    let json;
    try {
      json = parseJsonc(readFileSync(file, 'utf8'), rel(root, file));
    } catch {
      continue;
    }
    for (const reference of json.references ?? []) {
      const target = resolve(dirname(file), reference.path ?? '');
      const crossed = copyleftAreaOf(target);
      if (crossed === undefined) continue;
      findings.push(
        finding('boundary-reference', rel(root, file), `references the ${crossed}/ project`, [
          `path: ${reference.path}`,
        ]),
      );
    }
  }

  // -- 3. Manifest dependencies ---------------------------------------------
  const DEPENDENCY_FIELDS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  for (const manifest of manifests) {
    if (manifest.area === undefined || manifest.area.side !== 'permissive') continue;
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest.json[field] ?? {})) {
        const byName = workspace.get(name);
        const byPath = /^(?:workspace:|file:|link:|portal:)?(\.{1,2}\/.*)$/.exec(String(spec));
        const target = byName ?? (byPath ? resolve(manifest.dir, byPath[1]) : undefined);
        const crossed = copyleftAreaOf(target);
        if (crossed === undefined) continue;
        findings.push(
          finding(
            'boundary-dependency',
            `${manifest.display} (${field})`,
            `depends on ${name}, which lives in ${crossed}/`,
            [`declared as: "${name}": "${spec}"`],
          ),
        );
      }
    }
  }

  // -- 4. Manifest licence fields -------------------------------------------
  for (const manifest of manifests) {
    const expected = manifest.isRoot ? ROOT_MANIFEST_LICENCE : manifest.area?.spdx;
    if (expected === undefined) continue;
    const declared = manifest.json.license;
    if (declared === expected) continue;
    findings.push(
      finding(
        'manifest-license',
        manifest.display,
        declared === undefined
          ? `declares no license, but its path is ${expected}`
          : `declares "${declared}", but its path is ${expected}`,
        [
          `LICENSE puts ${manifest.isRoot ? 'the repository root' : `${manifest.area?.dir}/`} under ${expected}.`,
        ],
      ),
    );
  }

  return { findings, opaque, scanned, manifests: manifests.length };
}

// ---------------------------------------------------------------------------
// Dependency licences
// ---------------------------------------------------------------------------

/**
 * Is this SPDX expression permissive?
 *
 * Expressions are real: `(MIT OR Apache-2.0)` is permissive because the
 * recipient may pick either, and `MIT AND GPL-3.0-only` is not, because they
 * get both. A tiny recursive-descent parser is the honest way to say that;
 * substring matching would call `LGPL-3.0 OR MIT`-shaped strings whatever the
 * first match happened to be.
 */
function isPermissiveExpression(expression) {
  const tokens = String(expression)
    .replace(/[()]/g, ' $& ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  let position = 0;

  const parsePrimary = () => {
    const token = tokens[position];
    if (token === undefined) return false;
    if (token === '(') {
      position++;
      const value = parseOr();
      if (tokens[position] === ')') position++;
      return value;
    }
    position++;
    // `Apache-2.0 WITH LLVM-exception`: an exception only ever grants more.
    if (tokens[position] === 'WITH') position += 2;
    if (token === '+' || token.endsWith('+')) {
      return PERMISSIVE_DEPENDENCY_LICENCES.has(token.replace(/\+$/, ''));
    }
    return PERMISSIVE_DEPENDENCY_LICENCES.has(token.replace(/\*$/, ''));
  };

  const parseAnd = () => {
    let value = parsePrimary();
    while (tokens[position] === 'AND') {
      position++;
      value = parsePrimary() && value;
    }
    return value;
  };

  function parseOr() {
    let value = parseAnd();
    while (tokens[position] === 'OR') {
      position++;
      value = parseAnd() || value;
    }
    return value;
  }

  return parseOr();
}

/**
 * Ask pnpm what it installed, and under what licences.
 *
 * pnpm can already answer this, so nothing is added to the dependency tree to
 * find out — which matters, because a licence checker that itself needs a new
 * third-party dependency has quietly made the problem it is checking for
 * slightly more likely.
 *
 * @returns {{ ok: true, report: object } | { ok: false, reason: string }}
 */
function readDependencyLicences(root, { production }) {
  const args = ['licenses', 'list', '--json', '--filter', './packages/*'];
  if (production) args.push('--prod');

  const result = spawnSync('pnpm', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    return { ok: false, reason: `could not run pnpm: ${result.error.message}` };
  }
  const stderr = (result.stderr ?? '').trim();
  if (/No projects matched the filters/i.test(stderr)) return { ok: true, report: {} };
  if (result.status !== 0) {
    return { ok: false, reason: stderr || `pnpm exited with status ${result.status}` };
  }
  try {
    return { ok: true, report: JSON.parse(result.stdout || '{}') };
  } catch {
    return { ok: false, reason: 'pnpm returned output that is not JSON' };
  }
}

/**
 * Say what is wrong with one dependency licence.
 *
 * "Unknown" and a bare "BSD" get their own wording, because neither is a
 * copyleft problem — they are an *unanswerable* problem, and telling someone
 * their MIT-compatible package is "not permissive" when the real issue is that
 * nobody can tell what it is sends them looking for the wrong thing.
 */
function describeDependencyLicence(licence) {
  if (licence === 'Unknown' || licence === '') {
    return {
      what: 'declares no licence at all, so there is no grant to redistribute it under',
      extra: ['Silence is not permission. Absent a licence, the default is all rights reserved.'],
    };
  }
  if (/^BSD\*?$/i.test(licence)) {
    return {
      what: 'declares "BSD" without saying which BSD',
      extra: [
        'Two-clause and three-clause BSD would be fine here. The four-clause variant',
        'carries an advertising requirement MIT does not, so somebody has to read the',
        'licence file and pin the SPDX identifier. A wildcard in this script would be',
        'this project guessing on a licensor’s behalf.',
      ],
    };
  }
  return {
    what: `is ${licence}, which is not one of MIT, ISC, BSD or Apache-2.0`,
    extra: [],
  };
}

/**
 * Turn a pnpm licence report into findings.
 *
 * Kept separate from the pnpm call so the self-test can feed it a tree that
 * really does contain a copyleft dependency without installing one.
 */
function checkDependencyLicences(report) {
  const findings = [];
  for (const [licence, packages] of Object.entries(report)) {
    if (isPermissiveExpression(licence)) continue;
    for (const pkg of packages) {
      const versions = (pkg.versions ?? []).join(', ');
      const { what, extra } = describeDependencyLicence(licence);
      findings.push(
        finding('dependency-license', `${pkg.name}${versions ? `@${versions}` : ''}`, what, [
          ...extra,
          `Find out who pulled it in: pnpm why ${pkg.name} --filter "./packages/*"`,
        ]),
      );
    }
  }
  return findings.sort((a, b) => a.where.localeCompare(b.where));
}

/** Names appearing anywhere in a pnpm licence report. */
function namesIn(report) {
  return new Set(Object.values(report).flatMap((packages) => packages.map((p) => p.name)));
}

/**
 * The same report with some packages removed.
 *
 * Used to subtract the runtime tree from the full one, leaving the packages
 * that are reachable only through devDependencies. Filtering on the package
 * name rather than on the rendered `name@version` matters: a scoped name
 * already contains an `@`, and splitting on it drops the scope.
 */
function withoutPackages(report, names) {
  return Object.fromEntries(
    Object.entries(report)
      .map(([licence, packages]) => [licence, packages.filter((p) => !names.has(p.name))])
      .filter(([, packages]) => packages.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** Indent a block of lines, giving the first line a label of its own. */
function block(lines, label, indent) {
  return lines
    .map((line, index) => `${index === 0 ? label : indent}${line}`)
    .join('\n')
    .concat('\n');
}

function report(findings) {
  for (const item of findings) {
    process.stderr.write(`\nerror[${item.code}]: ${item.where}\n`);
    process.stderr.write(`  ${item.what}\n`);
    for (const line of item.extra) process.stderr.write(`    ${line}\n`);
    process.stderr.write('\n');
    process.stderr.write(block(WHY[item.code] ?? [], '  ', '  '));
    process.stderr.write('\n');
    process.stderr.write(block(FIX[item.code] ?? [], '  Fix: ', '       '));
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const commands = {
  check(argv) {
    const verbose = argv.includes('--verbose');
    const { findings, opaque, scanned, manifests } = analyse(ROOT);

    const prod = readDependencyLicences(ROOT, { production: true });
    if (!prod.ok) {
      fail(
        `${prod.reason}\n\n` +
          'The dependency licences of packages/ could not be established, so this\n' +
          'check cannot say whether the MIT half is redistributable. Install first:\n' +
          '  pnpm install --frozen-lockfile',
      );
    }
    findings.push(...checkDependencyLicences(prod.report));

    // Development-only dependencies are checked too, but they are not
    // redistributed with the package, so a copyleft build tool is a thing to
    // know about rather than a thing to block on.
    const all = readDependencyLicences(ROOT, { production: false });
    const runtime = namesIn(prod.report);
    const devOnly = all.ok ? checkDependencyLicences(withoutPackages(all.report, runtime)) : [];

    report(findings);

    if (findings.length > 0) {
      process.stderr.write(`\n${findings.length} licence problem(s) found.\n`);
      process.stderr.write('Nothing here is a style rule. See LICENSE for why the split exists.\n');
      process.exit(1);
    }

    process.stdout.write('Licence boundary OK.\n');
    process.stdout.write(`  ${scanned} source file(s) under the MIT half scanned for imports\n`);
    process.stdout.write(`  ${manifests} manifest(s) checked for the license field\n`);
    process.stdout.write(
      `  ${namesIn(prod.report).size} runtime dependenc(ies) of packages/ checked for permissive licences\n`,
    );
    if (devOnly.length > 0) {
      process.stdout.write(
        `\nnote: ${devOnly.length} development-only dependenc(ies) of packages/ are not permissively\n` +
          '      licensed. They are not redistributed with the package, so this is not a\n' +
          '      failure, but a copyleft build tool is worth knowing about:\n',
      );
      for (const item of devOnly) process.stdout.write(`        ${item.where} — ${item.what}\n`);
    }
    if (opaque.length > 0) {
      process.stdout.write(
        `\nnote: ${opaque.length} dynamic load(s) with a computed specifier cannot be checked\n` +
          '      statically. A specifier this check cannot read is a specifier a reviewer\n' +
          '      cannot read either.\n',
      );
      if (verbose) for (const where of opaque) process.stdout.write(`        ${where}\n`);
      else process.stdout.write('      Run with --verbose to list them.\n');
    }
  },

  selftest() {
    const results = runSelfTest();
    const failures = results.filter((r) => !r.ok);
    for (const result of results) {
      process.stdout.write(`  ${result.ok ? 'pass' : 'FAIL'}  ${result.name}\n`);
      if (!result.ok) process.stdout.write(`        ${result.detail}\n`);
    }
    if (failures.length > 0) {
      process.stderr.write(
        `\n${failures.length} of ${results.length} self-test case(s) failed.\n` +
          'The licence boundary check is not detecting violations it claims to detect.\n',
      );
      process.exit(1);
    }
    process.stdout.write(`\n${results.length} self-test case(s) passed.\n`);
  },
};

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

const quote = (value) => `'${value}'`;

/**
 * Fixture statements are assembled at run time instead of being written out as
 * literal import syntax, because scripts/ is itself part of the MIT half and
 * this file is scanned by the very check it is testing. Written literally, the
 * fixtures below would be violations of it.
 */
const call = (callee, argument) => `${callee}(${argument})`;
const BACKTICK = '`';

const STATEMENT = {
  static: (spec) => `import { db } from ${quote(spec)};\n`,
  bare: (spec) => `import ${quote(spec)};\n`,
  reexport: (spec) => `export * from ${quote(spec)};\n`,
  dynamic: (spec) => `const m = await ${call('import', quote(spec))};\n`,
  template: (spec) => `const m = await ${call('import', `${BACKTICK}${spec}\${n}${BACKTICK}`)};\n`,
  require: (spec) => `const m = ${call('require', quote(spec))};\n`,
};

/** Write the smallest tree that has both halves of the licence split in it. */
function writeFixture(root, overrides = {}) {
  const files = {
    'package.json': { name: 'fixture', private: true, license: ROOT_MANIFEST_LICENCE },
    'packages/demo/package.json': { name: '@fixture/demo', private: true, license: 'MIT' },
    'packages/demo/tsconfig.json': { compilerOptions: {} },
    'packages/demo/src/index.ts': 'export const ok = 1;\n',
    'server/package.json': { name: '@fixture/server', private: true, license: 'AGPL-3.0-or-later' },
    'server/src/db.ts': 'export const db = 1;\n',
    ...overrides,
  };
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
  }
}

/**
 * Prove the check catches each violation it promises to catch.
 *
 * A check that has never seen a real violation is not known to work, and the
 * violations this one exists to stop are not present in the repository — which
 * is the point. So they are constructed here, in a throwaway tree, on every
 * run, rather than once by hand in a pull request nobody reads again.
 */
function runSelfTest() {
  const cases = [
    {
      name: 'a clean tree produces no findings',
      files: {},
      expect: [],
    },
    {
      name: 'static import of a server file',
      files: { 'packages/demo/src/index.ts': STATEMENT.static('../../../server/src/db.js') },
      expect: ['boundary-import'],
    },
    {
      name: 'side-effect import of a server file',
      files: { 'packages/demo/src/index.ts': STATEMENT.bare('../../../server/src/db.js') },
      expect: ['boundary-import'],
    },
    {
      name: 're-export from a server file',
      files: { 'packages/demo/src/index.ts': STATEMENT.reexport('../../../server/src/db.js') },
      expect: ['boundary-import'],
    },
    {
      name: 'dynamic import of a server file',
      files: { 'packages/demo/src/index.ts': STATEMENT.dynamic('../../../server/src/db.js') },
      expect: ['boundary-import'],
    },
    {
      name: 'dynamic import through a template literal',
      files: { 'packages/demo/src/index.ts': STATEMENT.template('../../../server/src/') },
      expect: ['boundary-import'],
    },
    {
      name: 'require of a server file',
      files: { 'packages/demo/src/index.cjs': STATEMENT.require('../../../server/src/db.js') },
      expect: ['boundary-import'],
    },
    {
      name: 'import by the server workspace package name',
      files: { 'packages/demo/src/index.ts': STATEMENT.static('@fixture/server/src/db.js') },
      expect: ['boundary-import'],
    },
    {
      name: 'import through a tsconfig path alias',
      files: {
        'packages/demo/tsconfig.json': {
          compilerOptions: { baseUrl: '.', paths: { '@srv/*': ['../../server/src/*'] } },
        },
        'packages/demo/src/index.ts': STATEMENT.static('@srv/db.js'),
      },
      expect: ['boundary-alias', 'boundary-import'],
    },
    {
      // A tsconfig is full of strings that look like comment delimiters: a
      // "**/*.ts" glob closes a block comment and an "https://" URL opens a
      // line one. An earlier version of parseJsonc read those as comments and
      // threw away the paths block, which made every alias check pass by
      // seeing nothing at all. This case exists so that cannot come back.
      name: 'an alias survives globs and URLs that look like comments',
      files: {
        'packages/demo/tsconfig.json': [
          '{',
          '  "$schema": "https://json.schemastore.org/tsconfig",',
          '  // A comment that really is a comment.',
          '  "compilerOptions": {',
          '    "baseUrl": ".",',
          '    "paths": { "@srv/*": ["../../server/src/*"] }',
          '  },',
          '  "include": ["src/**/*.ts"]',
          '}',
          '',
        ].join('\n'),
      },
      expect: ['boundary-alias'],
    },
    {
      name: 'a tsconfig project reference into the server',
      files: {
        'packages/demo/tsconfig.json': { references: [{ path: '../../server' }] },
      },
      expect: ['boundary-reference'],
    },
    {
      name: 'a manifest dependency on the server package',
      files: {
        'packages/demo/package.json': {
          name: '@fixture/demo',
          private: true,
          license: 'MIT',
          dependencies: { '@fixture/server': 'workspace:*' },
        },
      },
      expect: ['boundary-dependency'],
    },
    {
      name: 'a manifest dependency on the server by relative path',
      files: {
        'packages/demo/package.json': {
          name: '@fixture/demo',
          private: true,
          license: 'MIT',
          dependencies: { srv: 'file:../../server' },
        },
      },
      expect: ['boundary-dependency'],
    },
    {
      name: 'an MIT package that declares AGPL',
      files: {
        'packages/demo/package.json': {
          name: '@fixture/demo',
          private: true,
          license: 'AGPL-3.0-or-later',
        },
      },
      expect: ['manifest-license'],
    },
    {
      name: 'an AGPL package that declares MIT',
      files: {
        'server/package.json': { name: '@fixture/server', private: true, license: 'MIT' },
      },
      expect: ['manifest-license'],
    },
    {
      name: 'a manifest with no license field',
      files: { 'packages/demo/package.json': { name: '@fixture/demo', private: true } },
      expect: ['manifest-license'],
    },
    {
      name: 'a commented-out import is not a violation',
      files: {
        'packages/demo/src/index.ts': `// ${STATEMENT.static('../../../server/src/db.js')}`,
      },
      expect: [],
    },
  ];

  const results = [];
  const base = mkdtempSync(join(tmpdir(), 'agentchat-licence-'));

  try {
    cases.forEach((testCase, index) => {
      const root = join(base, `case-${index}`);
      writeFixture(root, testCase.files);
      const codes = analyse(root)
        .findings.map((f) => f.code)
        .sort();
      const expected = [...testCase.expect].sort();
      const ok = codes.join(',') === expected.join(',');
      results.push({
        name: testCase.name,
        ok,
        detail: `expected [${expected.join(', ')}], got [${codes.join(', ')}]`,
      });
    });

    // The dependency-licence half, fed a report instead of an installation.
    const reportCases = [
      {
        name: 'a GPL dependency of packages/ fails',
        report: { 'GPL-3.0-only': [{ name: 'x' }] },
        expect: 1,
      },
      { name: 'an unlicensed dependency fails', report: { Unknown: [{ name: 'y' }] }, expect: 1 },
      {
        name: 'an LGPL dependency fails',
        report: { 'LGPL-3.0-or-later': [{ name: 'z' }] },
        expect: 1,
      },
      {
        name: 'MIT and Apache-2.0 dependencies pass',
        report: { MIT: [{ name: 'a' }], 'Apache-2.0': [{ name: 'b' }] },
        expect: 0,
      },
      {
        name: 'the dual licence (MIT OR Apache-2.0) passes',
        report: { '(MIT OR Apache-2.0)': [{ name: 'c' }] },
        expect: 0,
      },
      {
        name: 'the mixed licence (MIT AND GPL-3.0-only) fails',
        report: { '(MIT AND GPL-3.0-only)': [{ name: 'd' }] },
        expect: 1,
      },
      {
        name: 'a bare "BSD" is not accepted without a variant',
        report: { BSD: [{ name: 'e' }] },
        expect: 1,
      },
    ];
    for (const testCase of reportCases) {
      const count = checkDependencyLicences(testCase.report).length;
      results.push({
        name: testCase.name,
        ok: count === testCase.expect,
        detail: `expected ${testCase.expect} finding(s), got ${count}`,
      });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// `check` is the default, so continuous integration and a contributor at a
// terminal both get the enforcing behaviour from `node scripts/check-licenses.mjs`
// with nothing to remember.
const args = process.argv.slice(2);
const named = args.filter((arg) => !arg.startsWith('-'));
const argv = args.filter((arg) => arg.startsWith('-'));
const command = named[0] ?? 'check';

if (command === 'help' || argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`AgentChat licence boundary check

  check [--verbose]   enforce the licence boundary over this repository (default)
  selftest            construct each violation in a temporary tree and prove
                      the check still catches it

Permissive (MIT): ${AREAS.filter((a) => a.side === 'permissive')
    .map((a) => `${a.dir}/`)
    .join(', ')}
Copyleft (AGPL):  ${AREAS.filter((a) => a.side === 'copyleft')
    .map((a) => `${a.dir}/`)
    .join(', ')}

MIT may be absorbed into AGPL, never the reverse. See LICENSE.
`);
  process.exit(0);
}

if (!(command in commands)) fail(`unknown command "${command}"; run with --help`);
commands[command](argv);
