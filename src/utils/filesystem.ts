import { mkdir } from 'fs/promises';

/**
 * Ensures that the specified directories exist by creating them if they don't exist.
 * Creates all necessary parent directories recursively and processes all paths in parallel.
 * 
 * @param paths - Variable number of directory paths to ensure exist
 * @returns Promise that resolves when all directories have been created
 * 
 * @example
 * ```typescript
 * // Create single directory
 * await ensureDirectories('logs');
 * 
 * // Create multiple directories in parallel
 * await ensureDirectories('logs', 'temp', 'uploads/images');
 * ```
 */
export async function ensureDirectories(...paths: string[]): Promise<void> {
  await Promise.all(
    paths.map(path => mkdir(path, { recursive: true }))
  );
}