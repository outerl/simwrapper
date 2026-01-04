/**
 * POLARIS File System Handler
 *
 * Extends HTTPFileSystem to handle POLARIS project structures
 * and SQLite database files. Provides methods to detect
 * POLARIS projects and locate database files.
 */

import HTTPFileSystem from '../../js/HTTPFileSystem'
import { FileSystemConfig, DirectoryEntry } from '@/Globals'

/**
 * Interface representing the structure of a POLARIS project
 * with its typical database components
 */
export interface PolarisProject {
  /** Supply database buffer */
  supplyDb?: ArrayBuffer
  /** Demand database buffer */
  demandDb?: ArrayBuffer
  /** Result database buffer */
  resultDb?: ArrayBuffer
}

/**
 * File system handler specifically designed for POLARIS projects
 * Provides detection and database listing capabilities
 */
export default class PolarisFileSystem extends HTTPFileSystem {
  constructor(project: FileSystemConfig, store?: any) {
    super(project, store)
  }

  /**
   * Detects if a folder contains a POLARIS project
   * by looking for polaris.yaml configuration file
   * 
   * @param subfolder - The subfolder path to check
   * @returns Promise<boolean> - True if POLARIS project is detected
   */
  public async isPolarisProject(subfolder: string): Promise<boolean> {
    try {
      const { files } = await this.getDirectory(subfolder)

      // Look for polaris.yaml configuration file
      const hasPolarisConfig = files.some(
        f => f.toLowerCase() === 'polaris.yaml' || f.toLowerCase() === 'polaris.yml'
      )

      return hasPolarisConfig
    } catch (error) {
      return false
    }
  }

  /**
   * Lists all SQLite database files in a POLARIS project folder
   * 
   * @param subfolder - The subfolder path to search
   * @returns Promise<string[]> - Array of SQLite database filenames
   */
  public async listPolarisDatabases(subfolder: string): Promise<string[]> {
    const { files } = await this.getDirectory(subfolder)
    return files.filter(f => f.endsWith('.sqlite') || f.endsWith('.db'))
  }

  /**
   * Loads a POLARIS database file as an ArrayBuffer
   * 
   * @param filepath - Path to the database file
   * @returns Promise<ArrayBuffer | null> - Database as ArrayBuffer, or null if failed
   */
  public async loadPolarisDatabase(filepath: string): Promise<ArrayBuffer | null> {
    try {
      const blob = await this.getFileBlob(filepath)
      return blob ? await blob.arrayBuffer() : null
    } catch (error) {
      return null
    }
  }
}
