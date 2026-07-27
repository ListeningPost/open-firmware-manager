import type { OfferPriority, ServiceWindow } from '../types/index.js'

export interface WindowEvalInput {
  window?: ServiceWindow
  priority: OfferPriority
  /** Instant to evaluate; defaults to now. */
  now?: Date
}

export interface WindowEvalResult {
  allowed: boolean
  reason: 'no_window' | 'in_window' | 'outside_window' | 'urgent_bypass' | 'wrong_day'
}

function parseHHMM(value: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return { h, m: min }
}

/**
 * Get hour/minute/day-of-week in a target IANA timezone.
 * Falls back to UTC components if timezone is invalid.
 */
export function zonedParts(
  date: Date,
  timeZone: string,
): { hour: number; minute: number; day: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
      weekday: 'short',
    })
    const parts = fmt.formatToParts(date)
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
    const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon'
    const map: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    }
    return { hour, minute, day: map[weekday] ?? 0 }
  } catch {
    return {
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      day: date.getUTCDay(),
    }
  }
}

/**
 * Evaluate whether an update may proceed under a service window.
 * Required + urgentBypass may install outside the window.
 */
export function isWithinServiceWindow(input: WindowEvalInput): WindowEvalResult {
  const { window, priority } = input
  if (!window) {
    return { allowed: true, reason: 'no_window' }
  }

  if (priority === 'required' && window.urgentBypass) {
    return { allowed: true, reason: 'urgent_bypass' }
  }

  const now = input.now ?? new Date()
  // skewSec reserved for future clock-tolerance expansion; window bounds are inclusive on allowFrom.
  const parts = zonedParts(now, window.timezone)
  const from = parseHHMM(window.allowFrom)
  const to = parseHHMM(window.allowTo)
  if (!from || !to) {
    // Invalid window config: fail closed except no_window already handled
    return { allowed: false, reason: 'outside_window' }
  }

  if (window.days && window.days.length > 0 && !window.days.includes(parts.day)) {
    return { allowed: false, reason: 'wrong_day' }
  }

  const minutes = parts.hour * 60 + parts.minute
  const fromM = from.h * 60 + from.m
  const toM = to.h * 60 + to.m

  let inWindow: boolean
  if (fromM === toM) {
    // Zero-width → treat as always (explicit 24h operators can use 00:00-24:00 style; we use equal = all day)
    inWindow = true
  } else if (fromM < toM) {
    inWindow = minutes >= fromM && minutes < toM
  } else {
    // Overnight window e.g. 22:00 - 04:00
    inWindow = minutes >= fromM || minutes < toM
  }

  return inWindow
    ? { allowed: true, reason: 'in_window' }
    : { allowed: false, reason: 'outside_window' }
}
