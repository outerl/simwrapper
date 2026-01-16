/**
 * AequilibraE File System Handler
 *
 * Extends HTTPFileSystem to handle AequilibraE project structures
 * and SQLite database files specifically. Provides methods to detect
 * AequilibraE projects and list available databases.
 */

import HTTPFileSystem from '../../js/HTTPFileSystem'
import { FileSystemConfig } from '@/Globals'

export interface AequilibraEProject {
  /** Main project metadata database buffer */
  metadataDb?: ArrayBuffer
  /** Public transport parameters database buffer */
  parametersDb?: ArrayBuffer
  /** Results database buffer */
  resultsDb?: ArrayBuffer
}

export default class AequilibraEFileSystem extends HTTPFileSystem {
  constructor(project: FileSystemConfig, store?: any) {
    super(project, store)
  }

  public async isAequilibraEProject(subfolder: string): Promise<boolean> {
    try {
      const { files } = await this.getDirectory(subfolder)

      // Look for typical AequilibraE database files
      const hasMetadata = files.some(
        f => f.toLowerCase().includes('project_database') && f.endsWith('.sqlite')
      )
      const hasParameters = files.some(
        f => f.toLowerCase().includes('public_transport') && f.endsWith('.sqlite')
      )
      const hasResults = files.some(
        f => f.toLowerCase().includes('results_database') && f.endsWith('.sqlite')
      )

      return hasMetadata || hasParameters || hasResults
    } catch (error) {
      return false
    }
  }

  public async listAequilibraEDatabases(subfolder: string): Promise<string[]> {
    if (await this.isAequilibraEProject(subfolder)) {
      const { files } = await this.getDirectory(subfolder)
      return files.filter(f => f.endsWith('.sqlite'))
    }
    return []
  }

  public async loadAequilibraEDatabase(filepath: string): Promise<ArrayBuffer | null> {
    try {
      const blob = await this.getFileBlob(filepath)
      return blob ? await blob.arrayBuffer() : null
    } catch (error) {
      return null
    }
  }
}
