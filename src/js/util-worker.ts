/**
 * Worker-safe utilities
 * These functions can be safely imported in Web Workers
 * (no DOM dependencies like DOMParser, FileReader, etc.)
 */

import micromatch from 'micromatch'

export function findMatchingGlobInFiles(filenames: string[], glob: string): string[] {
  // first see if file itself is in this folder
  if (filenames.indexOf(glob) > -1) return [glob]

  // return globs in this folder
  const matches = micromatch(filenames, glob)
  if (matches.length) return matches

  // nothing!
  return []
}

export async function gUnzip(buffer: ArrayBuffer) {
  // GZIP always starts with a magic number, hex 0x8b1f
  const header = new Uint16Array(buffer, 0, 2)
  if (header[0] === 0x8b1f) {
    try {
      // use new 2023 DecompressionStream API
      const response = new Response(buffer)
      const stream = new DecompressionStream('gzip')
      const decompressed = await response.body?.pipeThrough(stream)
      const resultBuffer = await new Response(decompressed).arrayBuffer()
      // recursive because some combos of Firefox,Apache,Subversion will double-gzip!
      return await gUnzip(resultBuffer)
    } catch (e) {
      console.error('eee', e)
    }
  }
  return buffer
}

/**
 * Concat multiple typed arrays into one.
 * @param arrays a list of  typed arrays
 * @returns
 */
export function mergeTypedArrays(arrays: Array<any>[]): Array<any> {
  if (arrays.length == 0) return new Array()
  if (arrays.length == 1) return arrays[0]

  const total = arrays.map(a => a.length).reduce((t, n) => t + n)

  const c = Object.getPrototypeOf(arrays[0]).constructor
  const result = new c(total)

  let n = 0
  for (const arr of arrays) {
    result.set(arr, n)
    n += arr.length
  }

  return result
}

export function sleep(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}
