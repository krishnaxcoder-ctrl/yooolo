import { meanHeading, turnBetween } from './pdr'
import type { Room } from './rooms'

/** A straight stretch of a route: walk `steps` steps facing `heading`. */
export interface Leg {
  heading: number
  steps: number
}

export interface HomeRoute {
  id: string
  from: Room | null
  to: Room
  legs: Leg[]
  /** Whether headings came from the compass (true) or from turns the teacher tapped in. */
  compass: boolean
  savedAt: number
}

const KEY = 'yooolo.homeRoutes'

/** Saved routes live in this browser only. Reads fail quietly (private windows, blocked storage). */
export function loadRoutes(): HomeRoute[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as HomeRoute[]) : []
  } catch {
    return []
  }
}

/** Saves a route, replacing any older route between the same two rooms. Returns false if storage is unavailable. */
export function saveRoute(route: HomeRoute): boolean {
  const others = loadRoutes().filter((r) => !(r.to === route.to && r.from === route.from))
  try {
    localStorage.setItem(KEY, JSON.stringify([route, ...others]))
    return true
  } catch {
    return false
  }
}

export function deleteRoute(id: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadRoutes().filter((r) => r.id !== id)))
  } catch {
    // Nothing to do: storage is unavailable.
  }
}

/** The best saved route to `to`: one starting from the room the user is in, else the newest. */
export function routeTo(to: Room, from: Room | null): HomeRoute | null {
  const routes = loadRoutes().filter((r) => r.to === to)
  return routes.find((r) => r.from === from) ?? routes[0] ?? null
}

/** A change of direction bigger than this starts a new leg. */
const TURN_DEG = 40

/** Splits a walk, recorded as one heading per step, into straight legs. */
export function legsFromSteps(headings: number[]): Leg[] {
  const legs: { headings: number[] }[] = []
  for (const h of headings) {
    const leg = legs[legs.length - 1]
    if (leg && Math.abs(turnBetween(meanHeading(leg.headings), h)) <= TURN_DEG) leg.headings.push(h)
    else legs.push({ headings: [h] })
  }
  // A single step off course is a wobble, not a turn: fold it into the leg before.
  const merged: { headings: number[] }[] = []
  for (const leg of legs) {
    const prev = merged[merged.length - 1]
    if (prev && leg.headings.length < 2) prev.headings.push(...leg.headings)
    else merged.push(leg)
  }
  return merged.map((l) => ({ heading: Math.round(meanHeading(l.headings)), steps: l.headings.length }))
}
