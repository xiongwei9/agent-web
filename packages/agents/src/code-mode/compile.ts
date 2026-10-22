import type TS from "typescript";

export type CompileResult = { ok: true; js: string } | { ok: false; errors: string[] };

const MAX_ERRORS = 10;
const DECLARATIONS_FILE = "/tools.d.ts";
const MAIN_FILE = "/main.ts";

const CONSOLE_DECLARATION = `declare const console: {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  debug(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
};`;

let typescript: Promise<typeof TS> | undefined;

/**
 * The parsed standard library, shared by every check: parsing it is most of a
 * check's cost (~100 ms), the rest takes a few.
 */
const libFiles = new Map<string, TS.SourceFile | undefined>();

/**
 * Turns the model's code — the body of an async function, TypeScript or plain
 * JavaScript — into JavaScript QuickJS runs. With `typeCheck`, it is first
 * checked against `declarations` (the `tools` API), so a misspelled tool, a
 * missing argument or a misread result fails before anything runs: a script
 * that dies halfway may already have called tools with side effects.
 *
 * The check is lenient (no strict null checks, implicit `any` allowed): it is
 * there to catch calls that can't work, not to make the model annotate
 * everything.
 */
export async function compileCode(
  code: string,
  declarations: string,
  typeCheck: boolean,
): Promise<CompileResult> {
  typescript ??= import("typescript").then((module) => module.default);
  const ts = await typescript;

  if (typeCheck) {
    const errors = checkCode(ts, code, declarations);
    if (errors.length > 0) {
      return { ok: false, errors };
    }
  }

  const { outputText } = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  });
  return { ok: true, js: outputText };
}

function checkCode(ts: typeof TS, code: string, declarations: string): string[] {
  // Line 1 of the code is line 1 of `main.ts`, after the function header.
  const files = new Map([
    [DECLARATIONS_FILE, `${declarations}\n${CONSOLE_DECLARATION}`],
    [MAIN_FILE, `async function __main() {\n${code}\n}`],
  ]);
  const options: TS.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2023.d.ts"],
    types: [],
    noEmit: true,
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
  };
  const host: TS.CompilerHost = {
    getSourceFile: (fileName, languageVersion) => {
      const text = files.get(fileName);
      if (text !== undefined) {
        return ts.createSourceFile(fileName, text, languageVersion);
      }
      if (!libFiles.has(fileName)) {
        const libText = ts.sys.readFile(fileName);
        libFiles.set(
          fileName,
          libText === undefined
            ? undefined
            : ts.createSourceFile(fileName, libText, languageVersion),
        );
      }
      return libFiles.get(fileName);
    },
    getDefaultLibFileName: (compilerOptions) => ts.getDefaultLibFilePath(compilerOptions),
    writeFile: () => {},
    getCurrentDirectory: () => "/",
    getDirectories: () => [],
    fileExists: (fileName) => files.has(fileName) || ts.sys.fileExists(fileName),
    readFile: (fileName) => files.get(fileName) ?? ts.sys.readFile(fileName),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };

  const program = ts.createProgram([DECLARATIONS_FILE, MAIN_FILE], options, host);
  const main = program.getSourceFile(MAIN_FILE)!;
  const syntactic = program.getSyntacticDiagnostics(main);
  // Semantic errors on top of broken syntax are mostly noise.
  const diagnostics = syntactic.length > 0 ? syntactic : program.getSemanticDiagnostics(main);

  const errors = diagnostics.slice(0, MAX_ERRORS).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
    if (diagnostic.start === undefined) {
      return message;
    }
    const { line } = main.getLineAndCharacterOfPosition(diagnostic.start);
    return `line ${Math.max(1, line)}: ${message}`;
  });
  if (diagnostics.length > MAX_ERRORS) {
    errors.push(`…and ${diagnostics.length - MAX_ERRORS} more`);
  }
  return errors;
}
