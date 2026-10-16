// Runs the server (restarting on change) and the dashboard with hot reload, side by side.
import { spawn } from 'node:child_process'

const run = (name, command, args) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const prefix = (chunk) => chunk.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n') + '\n'
  child.stdout.on('data', (c) => process.stdout.write(prefix(c)))
  child.stderr.on('data', (c) => process.stderr.write(prefix(c)))
  child.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`)
    process.exit(code ?? 1)
  })
  return child
}

const children = [
  run('server', process.execPath, ['--env-file-if-exists=.env', '--conditions=source', '--watch', 'packages/server/src/main.ts']),
  run('web', 'npm', ['run', 'dev', '-w', '@openscope/web']),
]
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => children.forEach((c) => c.kill(signal)))
