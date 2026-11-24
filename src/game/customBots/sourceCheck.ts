/**
 * Port of the original contest's `check_source` (meow-ai-arena boomerang/workspace/build.py), so an uploaded
 * player.cpp is held to the same single-file rule: only `#include "dart.hpp"` and standard headers,
 * no system / process headers, no inline asm, no dllimport.
 */

// Obvious system / process headers (compared lower-case). Also rejected: headers starting with win / nt or
// ending in api.h (bare names), and anything under sys/ netinet/ arpa/ ddk/ linux/ asm/.
const BLOCKED_HEADERS = new Set([
  'tlhelp32.h', 'psapi.h', 'shellapi.h', 'shlobj.h', 'shlwapi.h', 'ws2tcpip.h', 'ws2def.h', 'iphlpapi.h', 'aclapi.h',
  'sddl.h', 'userenv.h', 'objbase.h', 'ole2.h', 'accctrl.h', 'lmcons.h', 'wtsapi32.h', 'dbghelp.h', 'imagehlp.h',
  'io.h', 'direct.h', 'process.h', 'conio.h', 'dos.h', 'share.h', 'unistd.h', 'fcntl.h', 'dlfcn.h', 'spawn.h',
  'dirent.h', 'pwd.h', 'grp.h', 'poll.h', 'netdb.h', 'ifaddrs.h', 'termios.h', 'mmsystem.h',
]);
const BLOCKED_PREFIX_DIRS = ['sys/', 'netinet/', 'arpa/', 'ddk/', 'linux/', 'asm/'];

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);
const isAlnum = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

/** Removes comments and joins backslash continuations; with `blankStrings`, string / char literal contents are dropped too. */
function stripComments(input: string, blankStrings: boolean): string {
  let text = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = text.replace(/\\\n/g, '');
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (text.startsWith('//', i)) {
      const j = text.indexOf('\n', i);
      i = j < 0 ? n : j;
    } else if (text.startsWith('/*', i)) {
      const j = text.indexOf('*/', i + 2);
      out.push(' ');
      i = j < 0 ? n : j + 2;
    } else if (c === 'R' && text.startsWith('R"', i) && (i === 0 || !isWordChar(text[i - 1]))) {
      const m = /^R"([^()\\ \n]{0,16})\(/.exec(text.slice(i, i + 20));
      if (m) {
        const end = text.indexOf(`)${m[1]}"`, i + m[0].length);
        const j = end < 0 ? n : end + m[1].length + 2;
        const newlines = (text.slice(i, j).match(/\n/g) || []).length;
        out.push('""' + '\n'.repeat(newlines));
        i = j;
      } else {
        out.push(c);
        i += 1;
      }
    } else if (c === '"' || (c === "'" && !(i > 0 && isAlnum(text[i - 1])))) {
      // 1'000'000 digit separators are not char literals
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out.push(blankStrings ? c + c : text.slice(i, j + 1));
      i = j + 1;
    } else {
      out.push(c);
      i += 1;
    }
  }
  return out.join('');
}

/** Returns the list of problems (empty = passes). Only blocks obvious system / process usage; the standard library is fine. */
export function checkSource(text: string): string[] {
  const probs: string[] = [];
  const code = stripComments(text, false);
  code.split('\n').forEach((line, idx) => {
    const no = idx + 1;
    let s = line.trim();
    if (s.startsWith('%:')) s = '#' + s.slice(2); // digraph %: == #
    const m = /^#\s*(include_next|include|import)\b\s*(.*)$/.exec(s);
    if (!m) return;
    const arg = m[2].trim();
    if (m[1] !== 'include') {
      probs.push(`第 ${no} 行：不能用 #${m[1]}`);
      return;
    }
    const q = /^"([^"]*)"/.exec(arg);
    const a = /^<([^>]*)>/.exec(arg);
    if (q) {
      if (q[1].trim() !== 'dart.hpp') {
        probs.push(`第 ${no} 行：只能 #include "dart.hpp"，不能包含别的本地文件（"${q[1]}"）`);
      }
    } else if (a) {
      const h = a[1].trim().replace(/\\/g, '/');
      const low = h.toLowerCase();
      const base = low.split('/').pop() || low;
      if (h.includes(':') || low.startsWith('/') || low.includes('..')) {
        probs.push(`第 ${no} 行：不能用绝对路径或上级目录包含（<${h}>）`);
      } else if (
        BLOCKED_HEADERS.has(low) ||
        BLOCKED_PREFIX_DIRS.some((p) => low.startsWith(p)) ||
        (!low.includes('/') && (base.startsWith('win') || base.startsWith('nt') || base.endsWith('api.h')))
      ) {
        probs.push(`第 ${no} 行：不能包含系统 / 进程类头文件 <${h}>（只能用标准库和 dart.hpp）`);
      }
    } else {
      probs.push(`第 ${no} 行：#include 只能写成 <标准库头文件> 或 "dart.hpp"（不能用宏）`);
    }
  });
  const flat = stripComments(text, true).replace(/\s+/g, ' ');
  if (/(?<![A-Za-z0-9_])(asm|__asm|__asm__)(?![A-Za-z0-9_])/.test(flat)) {
    probs.push('不能用内联汇编（asm / __asm__）');
  }
  if (/(?<![A-Za-z0-9_])dllimport(?![A-Za-z0-9_])/.test(flat)) {
    probs.push('不能用 dllimport（直接调用系统函数）');
  }
  return probs;
}
