#!/usr/bin/env node
// Stands in for the `claude` CLI in tests: echoes its arguments and stdin back as a result.
if (process.argv.includes('--version')) {
  console.log('9.9.9 (Claude Code)')
  process.exit(0)
}
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  const args = process.argv.slice(2)
  if (input.startsWith('Problem:')) {
    const draft = { file: 'docs/api-keys.md', summary: 'Use the Authorization header.', content: '# API keys\n\nSend `Authorization: Bearer $KEY`.\n' }
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '```json\n' + JSON.stringify(draft) + '\n```' }))
    return
  }
  if (input.includes('FAIL')) {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'it broke' }))
    return
  }
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ args, input }) }))
})
