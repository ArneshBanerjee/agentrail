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
    // Like the real CLI with --json-schema: the checked object comes back in structured_output.
    const draft = { file: 'docs/api-keys.md', title: 'Fix the authentication sample in the API keys guide', summary: 'Use the Authorization header.', content: '# API keys\n\n```bash\ncurl -H "Authorization: Bearer $KEY"\n```\n' }
    const structured = args.includes('--json-schema')
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: structured ? 'Done.' : 'no schema was sent', ...(structured ? { structured_output: draft } : {}) }))
    return
  }
  if (input.includes('FAIL')) {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'it broke' }))
    return
  }
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ args, input }) }))
})
