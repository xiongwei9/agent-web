import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";

import { isRecord } from "../shared/utils.ts";

const MEMORY_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_STACK_BYTES = 1024 * 1024;
const MAX_LOG_LINES = 500;

/**
 * A host function the code calls as `tools.<name>(args)`. What it resolves to
 * crosses into the sandbox as JSON, so it must be JSON-serializable.
 */
export type SandboxFunction = (args: Record<string, unknown>) => Promise<unknown>;

export interface SandboxOptions {
  /** The body of an async function: it may `await` and `return`. */
  code: string;
  /** Exposed to the code as `tools.<key>(args)`; keys must be JS identifiers. */
  functions: Record<string, SandboxFunction>;
  /** Wall-clock limit for the whole run, awaited calls included. */
  timeoutMs: number;
  signal?: AbortSignal;
}

export type SandboxResult =
  | { ok: true; value: unknown; logs: string[] }
  | { ok: false; error: string; logs: string[] };

let quickjs: Promise<QuickJSWASMModule> | undefined;

/**
 * Runs model-written JavaScript in a QuickJS interpreter compiled to
 * WebAssembly. The code gets no ambient capabilities — no `require`, `process`,
 * `fetch`, file system or timers — only the `tools` it's handed and a
 * `console` whose output is collected. A fresh runtime per run, capped in
 * memory and stack, so runs can't see or exhaust each other.
 *
 * The deadline covers both CPU (an interrupt handler stops a busy loop) and
 * waiting (a timer rejects while a tool call is outstanding), and so does
 * `signal`. Tool calls run concurrently on the host: the code can
 * `Promise.all` them.
 */
export async function runInSandbox(options: SandboxOptions): Promise<SandboxResult> {
  quickjs ??= newQuickJSWASMModuleFromVariant(import("@jitl/quickjs-wasmfile-release-sync"));
  const runtime = (await quickjs).newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  const deadline = Date.now() + options.timeoutMs;
  const stopped = () => Date.now() > deadline || Boolean(options.signal?.aborted);
  runtime.setInterruptHandler(stopped);

  const vm = runtime.newContext();
  const logs: string[] = [];
  const outstanding = new Set<QuickJSDeferredPromise>();

  const drain = () => {
    if (runtime.alive) {
      runtime.executePendingJobs().dispose();
    }
  };

  try {
    const call = vm.newFunction("call", (nameHandle, argsHandle) => {
      const name = vm.getString(nameHandle);
      const argsJson = vm.getString(argsHandle);
      const deferred = vm.newPromise();
      outstanding.add(deferred);
      invoke(options.functions, name, argsJson)
        .then(
          (json) => vm.alive && settle(deferred, vm.newString(json), true),
          (error) => vm.alive && settle(deferred, vm.newError(errorMessage(error)), false),
        )
        .finally(() => {
          outstanding.delete(deferred);
          drain();
        });
      return deferred.handle;
    });
    const log = vm.newFunction("log", (lineHandle) => {
      if (logs.length < MAX_LOG_LINES) {
        logs.push(vm.getString(lineHandle));
      } else if (logs.length === MAX_LOG_LINES) {
        logs.push(`…[further output dropped after ${MAX_LOG_LINES} lines]`);
      }
    });
    const install = vm.unwrapResult(vm.evalCode(prelude(Object.keys(options.functions))));
    vm.unwrapResult(vm.callFunction(install, vm.undefined, call, log)).dispose();
    for (const handle of [install, call, log]) {
      handle.dispose();
    }

    const evaluated = vm.evalCode(`(async () => {\n${options.code}\n})()`, "code.js");
    if (evaluated.error) {
      const error = dumpError(vm, evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error, logs };
    }
    const completion = vm.resolvePromise(evaluated.value);
    evaluated.value.dispose();
    drain();

    const result = await untilDeadline(completion, deadline, options.signal);
    if (result.error) {
      const error = dumpError(vm, result.error);
      result.error.dispose();
      return { ok: false, error, logs };
    }
    const value: unknown = vm.dump(result.value);
    result.value.dispose();
    return { ok: true, value, logs };
  } catch (error) {
    return { ok: false, error: errorMessage(error), logs };
  } finally {
    // Tool calls still in flight when the run ends (timeout, abort) settle
    // into a disposed context; `vm.alive` makes them no-ops.
    for (const deferred of outstanding) {
      deferred.dispose();
    }
    vm.dispose();
    runtime.dispose();
  }

  function untilDeadline<T>(
    promise: Promise<T>,
    at: number,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => finish(() => reject(new Error("Execution was aborted.")));
      const timer = setTimeout(
        () => finish(() => reject(new Error(`Execution timed out after ${options.timeoutMs} ms.`))),
        Math.max(0, at - Date.now()),
      );
      const finish = (then: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        then();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
      }
      promise.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }
}

/** Calls a host function for the code; resolves to its result as JSON. */
async function invoke(
  functions: Record<string, SandboxFunction>,
  name: string,
  argsJson: string,
): Promise<string> {
  const fn = Object.hasOwn(functions, name) ? functions[name] : undefined;
  if (!fn) {
    throw new Error(`tools.${name} is not a function`);
  }
  const args: unknown = JSON.parse(argsJson);
  if (!isRecord(args)) {
    throw new Error(`tools.${name} takes one object argument`);
  }
  return JSON.stringify((await fn(args)) ?? null);
}

function settle(deferred: QuickJSDeferredPromise, handle: QuickJSHandle, fulfilled: boolean): void {
  if (fulfilled) {
    deferred.resolve(handle);
  } else {
    deferred.reject(handle);
  }
  handle.dispose();
}

function dumpError(vm: QuickJSContext, handle: QuickJSHandle): string {
  const error: unknown = vm.dump(handle);
  if (isRecord(error) && typeof error.message === "string") {
    if (error.message === "interrupted") {
      return "Execution timed out or was aborted.";
    }
    return typeof error.name === "string" ? `${error.name}: ${error.message}` : error.message;
  }
  return String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Guest-side setup, evaluated to a function and called with the two host
 * bridges: builds the frozen `tools` object and `console`, and keeps the
 * bridges themselves out of the global scope.
 */
function prelude(names: string[]): string {
  return `(function (call, log) {
  const format = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    try {
      const json = JSON.stringify(value, null, 2);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  };
  const tools = {};
  for (const name of ${JSON.stringify(names)}) {
    tools[name] = (args) =>
      call(name, JSON.stringify(args === undefined ? {} : args)).then((json) => JSON.parse(json));
  }
  const write = (prefix) => (...values) => log(prefix + values.map(format).join(" "));
  globalThis.tools = Object.freeze(tools);
  globalThis.console = Object.freeze({
    log: write(""),
    info: write(""),
    debug: write(""),
    warn: write("[warn] "),
    error: write("[error] "),
  });
})`;
}
