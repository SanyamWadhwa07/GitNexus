import type { ScopeResolutionIndexes } from '../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { collectKotlinCaptureSideChannel } from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import {
  isKotlinPackageSiblingVisibilityIncomplete,
  populateKotlinPackageSiblings,
} from '../../src/core/ingestion/languages/kotlin/package-siblings.js';
import { setKotlinPackageFact } from '../../src/core/ingestion/languages/kotlin/package-facts.js';
import type { JvmPackageFact } from '../../src/core/ingestion/languages/jvm/package-facts.js';
import { createJvmPackageSiblingVisibility } from '../../src/core/ingestion/languages/jvm/package-siblings.js';

interface LanguagePackageHarness {
  readonly label: string;
  readonly extension: string;
  readonly namedSource: string;
  readonly defaultSource: string;
  readonly malformedSource: string;
  readonly brokenBodySource: string;
  readonly emit: (source: string, filePath: string) => unknown;
  readonly collect: (filePath: string) => { packageFact: JvmPackageFact } | undefined;
  readonly setFact: (filePath: string, fact: JvmPackageFact) => void;
  readonly populate: (
    parsedFiles: readonly ParsedFile[],
    indexes: ScopeResolutionIndexes,
    context: { fileContents: ReadonlyMap<string, string> },
  ) => void;
  readonly isIncomplete: (filePath: string) => boolean;
}

const harnesses: readonly LanguagePackageHarness[] = [
  {
    label: 'Kotlin',
    extension: '.kt',
    namedSource: 'package com.example\nclass Named',
    defaultSource: 'class Default',
    malformedSource: 'package ;\nclass Malformed',
    brokenBodySource: 'package com.valid\nclass Broken { fun f( }',
    emit: emitKotlinScopeCaptures,
    collect: collectKotlinCaptureSideChannel,
    setFact: setKotlinPackageFact,
    populate: populateKotlinPackageSiblings,
    isIncomplete: isKotlinPackageSiblingVisibilityIncomplete,
  },
];

/** A file with only a module scope — `moduleWithClass` without the class half. */
function parsedFile(filePath: string, index: number): ParsedFile {
  return moduleWithClass(filePath, index);
}

function emptyIndexes(): ScopeResolutionIndexes {
  return { bindingAugmentations: new Map() } as unknown as ScopeResolutionIndexes;
}

for (const harness of harnesses) {
  describe(`${harness.label} JVM package facts`, () => {
    it('captures named/default packages and isolates package-header errors', () => {
      const namedPath = `src/Named${harness.extension}`;
      harness.emit(harness.namedSource, namedPath);
      expect(harness.collect(namedPath)?.packageFact).toEqual({
        status: 'known',
        packageName: 'com.example',
      });

      const defaultPath = `src/Default${harness.extension}`;
      harness.emit(harness.defaultSource, defaultPath);
      expect(harness.collect(defaultPath)?.packageFact).toEqual({
        status: 'known',
        packageName: '',
      });

      const malformedPath = `src/Malformed${harness.extension}`;
      harness.emit(harness.malformedSource, malformedPath);
      expect(harness.collect(malformedPath)?.packageFact).toEqual({ status: 'unknown' });

      const brokenBodyPath = `src/BrokenBody${harness.extension}`;
      harness.emit(harness.brokenBodySource, brokenBodyPath);
      expect(harness.collect(brokenBodyPath)?.packageFact).toEqual({
        status: 'known',
        packageName: 'com.valid',
      });
    });

    it('marks a capped package incomplete without affecting other package names', () => {
      const source = harness.namedSource;
      const parsedFiles = Array.from({ length: 501 }, (_, index) => {
        const filePath = `src/com/capped/Type${index}${harness.extension}`;
        harness.setFact(filePath, { status: 'known', packageName: 'com.capped' });
        return parsedFile(filePath, index);
      });
      const fileContents = new Map(parsedFiles.map((parsed) => [parsed.filePath, source]));

      harness.populate(parsedFiles, emptyIndexes(), { fileContents });

      expect(harness.isIncomplete(parsedFiles[0].filePath)).toBe(true);
      expect(harness.isIncomplete(`src/other/Complete${harness.extension}`)).toBe(false);
    });

    it('fails wildcard visibility closed when a source file produced no ParsedFile', () => {
      const first = parsedFile(`src/A${harness.extension}`, 1);
      const second = parsedFile(`src/B${harness.extension}`, 2);
      harness.setFact(first.filePath, { status: 'known', packageName: 'com.example' });
      harness.setFact(second.filePath, { status: 'known', packageName: 'com.example' });
      const skippedPath = `src/Skipped${harness.extension}`;
      const fileContents = new Map([
        [first.filePath, harness.namedSource],
        [second.filePath, harness.namedSource],
        [skippedPath, harness.malformedSource],
      ]);

      harness.populate([first, second], emptyIndexes(), { fileContents });

      expect(harness.isIncomplete(first.filePath)).toBe(true);
      expect(harness.isIncomplete(second.filePath)).toBe(true);
    });
  });
}

// ─── sibling injection cap (#2732) ───────────────────────────────────
//
// Driven through the shared JVM factory rather than a language facade: the
// cap is language-agnostic, and a synthetic fixture can place candidates at
// chosen path distances without hand-writing hundreds of real sources.

function moduleWithClass(
  filePath: string,
  index: number,
  def?: SymbolDefinition,
  moduleTypeBindings?: ReadonlyMap<string, unknown>,
): ParsedFile {
  const moduleId = `module:${index}`;
  const scopes: Record<string, unknown>[] = [
    {
      id: moduleId,
      kind: 'Module',
      bindings: new Map(),
      typeBindings: new Map(moduleTypeBindings ?? []),
      ownedDefs: [],
    },
  ];
  if (def !== undefined) {
    scopes.push({
      id: `class:${index}`,
      kind: 'Class',
      parent: moduleId,
      bindings: new Map(),
      typeBindings: new Map(),
      ownedDefs: [def],
    });
  }
  return { filePath, scopes } as unknown as ParsedFile;
}

// ─── top-level functions offered to sibling files ────────────────────

describe('JVM package sibling functions', () => {
  const fact: JvmPackageFact = { status: 'known', packageName: 'com.cap' };

  const classDef = (filePath: string, name: string): SymbolDefinition =>
    ({
      nodeId: `Class:${filePath}:${name}`,
      filePath,
      type: 'Class',
      qualifiedName: name,
    }) as SymbolDefinition;

  const functionDef = (filePath: string, name: string, overload: number): SymbolDefinition =>
    ({
      nodeId: `Function:${filePath}:${name}#${overload}`,
      filePath,
      type: 'Function',
      qualifiedName: name,
    }) as SymbolDefinition;

  /** A file declaring `overloads` top-level functions named `name`. */
  const functionFile = (filePath: string, index: number, name: string, overloads: number) => {
    const parsed = moduleWithClass(filePath, index);
    (parsed.scopes[0].bindings as Map<string, unknown>).set(
      name,
      Array.from({ length: overloads }, (_, overload) => ({
        def: functionDef(filePath, name, overload),
        origin: 'local',
      })),
    );
    return parsed;
  };

  /** Names injected into `target`'s module scope, each with its def ids. */
  const injectedInto = (
    files: readonly ParsedFile[],
    target: ParsedFile,
    cap: string | undefined,
    withFunctions = true,
  ): { names: Record<string, string[]>; incomplete: boolean } => {
    const previous = process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
    if (cap === undefined) delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
    else process.env.GITNEXUS_MAX_INJECTED_SIBLINGS = cap;
    try {
      const visibility = createJvmPackageSiblingVisibility({
        languageLabel: 'test',
        getPackageFact: () => fact,
        mergeSiblingTypeBindings: false,
        ...(withFunctions ? { includeTopLevelFunction: () => true } : {}),
      });
      const indexes = emptyIndexes();
      visibility.populateNamespaceSiblings(files, indexes, {
        fileContents: new Map(files.map((parsed) => [parsed.filePath, ''])),
      });
      const scopeAug = indexes.bindingAugmentations.get(target.scopes[0].id) ?? new Map();
      const names: Record<string, string[]> = {};
      for (const [name, refs] of scopeAug) names[name] = refs.map((ref) => ref.def.nodeId).sort();
      return { names, incomplete: visibility.isVisibilityIncomplete(target.filePath) };
    } finally {
      if (previous === undefined) delete process.env.GITNEXUS_MAX_INJECTED_SIBLINGS;
      else process.env.GITNEXUS_MAX_INJECTED_SIBLINGS = previous;
    }
  };

  // The overloads sort first, so a shared budget would spend it on them.
  const pickPath = 'src/main/kotlin/com/cap/A0Pick.kt';
  const caller = moduleWithClass('src/main/kotlin/com/cap/Caller.kt', 3);
  const files = [
    functionFile(pickPath, 0, 'pick', 2),
    moduleWithClass(
      'src/main/kotlin/com/cap/Alpha.kt',
      1,
      classDef('src/main/kotlin/com/cap/Alpha.kt', 'Alpha'),
    ),
    moduleWithClass(
      'src/main/kotlin/com/cap/Beta.kt',
      2,
      classDef('src/main/kotlin/com/cap/Beta.kt', 'Beta'),
    ),
    caller,
  ];

  it('offers functions on a budget of their own, after the classes', () => {
    const classesOnly = injectedInto(files, caller, '2', false);
    const { names } = injectedInto(files, caller, '2');
    expect(Object.keys(classesOnly.names).sort()).toEqual(['Alpha', 'Beta']);
    expect(names.Alpha).toEqual(classesOnly.names.Alpha);
    expect(names.Beta).toEqual(classesOnly.names.Beta);
    expect(names.pick).toEqual([`Function:${pickPath}:pick#0`, `Function:${pickPath}:pick#1`]);
  });

  it('injects an overload group whole or not at all', () => {
    const { names, incomplete } = injectedInto(files, caller, '1');
    expect(names.pick).toBeUndefined();
    expect(incomplete).toBe(true);
  });

  it('does not offer a test source set function to production code', () => {
    const samples = functionFile('src/test/kotlin/com/cap/Samples.kt', 4, 'sample', 1);
    const withTest = [...files, samples];
    expect(injectedInto(withTest, caller, undefined).names.sample).toBeUndefined();
    expect(injectedInto(withTest, samples, undefined).names.pick).toHaveLength(2);
  });
});
