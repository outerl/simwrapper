/**
 * Global Loading Queue & SPL Engine Management
 *
 * Ensures only one map loads at a time to prevent memory exhaustion when
 * loading many maps simultaneously. Also manages the shared SPL (SpatiaLite)
 * engine instance, which is ~100MB+ in memory.
 */

import SPL from 'spl.js'
import type { SPL as SPLType } from './types'

// ============================================================================
// GLOBAL LOADING QUEUE - Ensures only one map loads at a time
// ============================================================================

let loadingQueue: Promise<void> = Promise.resolve()
let queueLength = 0
let totalMapsLoading = 0 // Track total maps being loaded (not just waiting)

/**
 * Acquire a slot in the loading queue. Only one map can load at a time.
 * Returns a release function that MUST be called when loading is complete.
 */
export function acquireLoadingSlot(): Promise<() => void> {
  queueLength++
  totalMapsLoading++

  let releaseSlot: () => void

  const myTurn = loadingQueue.then()

  // Create the next slot in the queue
  loadingQueue = new Promise<void>(resolve => {
    releaseSlot = () => {
      queueLength--
      resolve()
    }
  })

  return myTurn.then(() => releaseSlot!)
}

/**
 * Call when a map has fully finished loading (after extractGeometries)
 * to update the total count for memory tuning purposes.
 */
export function mapLoadingComplete(): void {
  totalMapsLoading = Math.max(0, totalMapsLoading - 1)
}

/**
 * Get the current total number of maps being loaded.
 * This can be used to adjust memory limits dynamically.
 */
export function getTotalMapsLoading(): number {
  return totalMapsLoading
}

// ============================================================================
// SHARED SPL ENGINE - Critical for memory when loading multiple maps
// ============================================================================

let sharedSpl: SPLType | null = null
let splInitPromise: Promise<SPLType> | null = null
let splRefCount = 0

/**
 * Get or create the shared SPL engine.
 * Uses reference counting to know when it's safe to clean up.
 */
export async function initSql(): Promise<SPLType> {
  splRefCount++

  if (sharedSpl) {
    return sharedSpl
  }

  // If already initializing, wait for that to complete
  if (splInitPromise) {
    return splInitPromise
  }

  // Initialize the shared SPL engine
  splInitPromise = SPL().then((spl: SPLType) => {
    sharedSpl = spl
    splInitPromise = null
    return spl
  })

  return splInitPromise!
}

/**
 * Release a reference to the shared SPL engine.
 * Call this when a map component is unmounted.
 */
export function releaseSql(): void {
  splRefCount = Math.max(0, splRefCount - 1)
  // We keep the SPL engine alive even when refCount hits 0
  // because it's expensive to reinitialize. It will be GC'd
  // when the page is unloaded.
}
