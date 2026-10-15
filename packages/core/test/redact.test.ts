import { expect, test } from 'vitest'
import { redactPath, redactQuery, redactText } from '../src/redact.ts'

test('emails become tokens, and one value keeps one token', () => {
  const r = redactText('Refund a@b.co and tell a@b.co, cc ops@shop.io')
  expect(r.text).toBe('Refund [EMAIL_1] and tell [EMAIL_1], cc [EMAIL_2]')
  expect(r.kinds).toEqual(['EMAIL'])
})

test('cards need a valid Luhn checksum', () => {
  expect(redactText('card 4242 4242 4242 4242').text).toBe('card [CARD_1]')
  expect(redactText('order 4242 4242 4242 4241').text).toBe('order 4242 4242 4242 4241')
})

test('Aadhaar needs a valid Verhoeff checksum', () => {
  expect(redactText('aadhaar 2341 2341 2346').text).toBe('aadhaar [AADHAAR_1]')
  expect(redactText('ref 2341 2341 2345').kinds).not.toContain('AADHAAR')
})

test('PAN, SSN, IBAN and IP', () => {
  expect(redactText('PAN ABCPE1234F').text).toBe('PAN [PAN_1]')
  expect(redactText('ssn 123-45-6789').text).toBe('ssn [SSN_1]')
  expect(redactText('iban GB82 WEST 1234 5698 7654 32').text).toBe('iban [IBAN_1]')
  expect(redactText('from 203.0.113.9').text).toBe('from [IP_1]')
})

test('secrets: provider keys, JWTs and bearer tokens', () => {
  expect(redactText('use sk_live_51HxYzABCDEFGHIJKLMN').text).toBe('use [SECRET_1]')
  expect(redactText('ghp_abcdefghijklmnopqrstuvwxyz0123456789').text).toBe('[SECRET_1]')
  expect(redactText('Authorization: Bearer abcdef0123456789abcdef').text).toBe('Authorization: Bearer [SECRET_1]')
  expect(redactText('AKIAIOSFODNN7EXAMPLE').text).toBe('[SECRET_1]')
})

test('phones need a plus, separators or the Indian mobile shape', () => {
  expect(redactText('call +1 415 555 0134').text).toBe('call [PHONE_1]')
  expect(redactText('call 9876543210').text).toBe('call [PHONE_1]')
  expect(redactText('charge 120000 paise at 1729000000').kinds).toEqual([])
})

test('a task keeps its meaning after redaction', () => {
  const r = redactText('Refund the last charge for cus_8x2Lk and let them know at priya@example.com')
  expect(r.text).toBe('Refund the last charge for cus_8x2Lk and let them know at [EMAIL_1]')
})

test('query strings drop sensitive parameters and scan the rest', () => {
  expect(redactQuery('?q=usage+billing&api_key=abc123&to=a@b.co').text).toBe('q=usage+billing&api_key=[REDACTED]&to=[EMAIL_1]')
  expect(redactQuery('').text).toBe('')
})

test('paths are scanned after decoding', () => {
  expect(redactPath('/users/a%40b.co/settings').text).toBe('/users/[EMAIL_1]/settings')
  expect(redactPath('/docs/billing/usage').text).toBe('/docs/billing/usage')
})
