/**
 * How an uploaded bot is compiled (shared by the compile worker and scripts/test_custom_bots.mjs, which checks
 * that bundled bots built this way act identically to their Emscripten builds). No imports: Node runs it as-is.
 */

// Same flags as the contest (g++ -std=c++17 -O2, 64 MB stack), retargeted to wasm.
export const CLANG_ARGS = [
  'clang++',
  '--target=wasm32-wasip1',
  '-std=c++17',
  '-O2',
  '-DDART_WASI_BOT',
  '-mexec-model=reactor',
  '-isystem',
  'shim',
  '-fno-color-diagnostics',
  '-Wl,-z,stack-size=67108864',
  'player.cpp',
  'dart_eh_stub.cpp',
  '-o',
  'bot.wasm',
];

// The WASI libc++ is built without exception support and wasm here has no unwinding: a `throw` that actually
// happens aborts the bot (like an uncaught exception would), while code that merely mentions throw/try still links.
export const EH_STUB = `#include <cstdlib>
extern "C" void* __cxa_allocate_exception(unsigned long) { std::abort(); }
extern "C" void __cxa_throw(void*, void*, void (*)(void*)) { std::abort(); }
`;

// libc++ has no <bits/stdc++.h> (it's a libstdc++ header the original g++ toolchain allowed): provide one.
const STDCPP_HEADERS = [
  'cassert', 'cctype', 'cerrno', 'cfenv', 'cfloat', 'cinttypes', 'climits', 'clocale', 'cmath', 'cstdarg', 'cstddef',
  'cstdint', 'cstdio', 'cstdlib', 'cstring', 'ctime', 'cuchar', 'cwchar', 'cwctype', 'algorithm', 'any', 'array',
  'atomic', 'bitset', 'charconv', 'chrono', 'codecvt', 'complex', 'condition_variable', 'deque', 'exception',
  'execution', 'filesystem', 'forward_list', 'fstream', 'functional', 'future', 'initializer_list', 'iomanip', 'ios',
  'iosfwd', 'iostream', 'istream', 'iterator', 'limits', 'list', 'locale', 'map', 'memory', 'memory_resource', 'mutex',
  'new', 'numeric', 'optional', 'ostream', 'queue', 'random', 'ratio', 'regex', 'scoped_allocator', 'set',
  'shared_mutex', 'sstream', 'stack', 'stdexcept', 'streambuf', 'string', 'string_view', 'system_error', 'thread',
  'tuple', 'type_traits', 'typeindex', 'typeinfo', 'unordered_map', 'unordered_set', 'utility', 'valarray', 'variant',
  'vector',
];
export const STDCPP_SHIM = `#pragma once\n${STDCPP_HEADERS.map((h) => `#include <${h}>`).join('\n')}\n`;

/** Virtual-FS tree handed to clang (dart.hpp is passed in: the worker imports it raw, tests read it from disk). */
export function compileInputs(source: string, dartHpp: string) {
  return {
    'player.cpp': source,
    'dart.hpp': dartHpp,
    'dart_eh_stub.cpp': EH_STUB,
    shim: { bits: { 'stdc++.h': STDCPP_SHIM } },
  };
}
