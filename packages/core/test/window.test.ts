import { describe, expect, it } from 'vitest'
import { isWithinServiceWindow } from '../src/window/index.js'
import type { ServiceWindow } from '../src/types/index.js'

const window: ServiceWindow = {
  timezone: 'UTC',
  allowFrom: '02:00',
  allowTo: '04:00',
  days: [1, 2, 3, 4, 5], // Mon-Fri
  urgentBypass: true,
}

describe('isWithinServiceWindow', () => {
  it('allows when no window configured', () => {
    const r = isWithinServiceWindow({ priority: 'recommended' })
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('no_window')
  })

  it('allows inside window', () => {
    // 2026-07-27 is a Monday
    const now = new Date('2026-07-27T02:30:00.000Z')
    const r = isWithinServiceWindow({
      window,
      priority: 'recommended',
      now,
    })
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('in_window')
  })

  it('blocks outside window for recommended', () => {
    const now = new Date('2026-07-27T12:00:00.000Z')
    const r = isWithinServiceWindow({
      window,
      priority: 'recommended',
      now,
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('outside_window')
  })

  it('allows required with urgentBypass outside window', () => {
    const now = new Date('2026-07-27T12:00:00.000Z')
    const r = isWithinServiceWindow({
      window,
      priority: 'required',
      now,
    })
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('urgent_bypass')
  })

  it('blocks wrong day of week', () => {
    // 2026-07-25 is Saturday
    const now = new Date('2026-07-25T02:30:00.000Z')
    const r = isWithinServiceWindow({
      window,
      priority: 'recommended',
      now,
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('wrong_day')
  })
})
