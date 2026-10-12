import { execFile } from 'node:child_process';

// GIT_TERMINAL_PROMPT=0: un repo o una wiki que no existe hace que GitHub pida
// credenciales; sin esto git se quedaría esperando en el terminal.
export function git(args, { cwd, timeout = 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''}: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      },
    );
  });
}
