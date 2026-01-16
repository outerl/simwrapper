// Ensures only one map loads at a time to prevent memory exhaustion when loading many maps 
// simultaneously. Also manages the shared SPL (SpatiaLite) engine instance, which is ~100MB+ in 
// memory. We are caching the database reads and geo-json extraction to not (a) repeatedly download
// the same DB files and (b) not spike the memory usage.

import SPL from 'spl.js'
import type { SPL as SPLType } from './types'

let loadingQueue: Promise<void> = Promise.resolve()
let queueLength = 0
let totalMapsLoading = 0 // track total maps being loaded (not just waiting)

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

export function mapLoadingComplete(): void {
  totalMapsLoading -= 1
}

export function getTotalMapsLoading(): number {
  return totalMapsLoading
}

let sharedSpl: SPLType | null = null
let splInitPromise: Promise<SPLType> | null = null
let splRefCount = 0

export async function initSql(): Promise<SPLType> {
  splRefCount++

  if (sharedSpl) { return sharedSpl }

  if (splInitPromise) {
    return splInitPromise
  }

  // initialize the shared SPL engine
  splInitPromise = SPL().then((spl: SPLType) => {
    sharedSpl = spl
    splInitPromise = null
    return spl
  })

  return splInitPromise!
}

export function releaseSql(): void {
  splRefCount -= 1 // let GC clean up, restarting the SPL engine is slow
}
