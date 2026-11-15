// The free space of the file system a backup is written to.
//
// A backup that runs out of space half way through leaves an incomplete file
// behind. The space is therefore checked BEFORE anything is written.
//
// The estimate is deliberately conservative: the size of the database plus a
// margin. No compression ratio is assumed - SQLite does not compress.
import fs from 'node:fs';

/** The margin on the size of the database. */
export const SPACE_MARGIN_FACTOR = 1.5;

/** The smallest space that is always accepted, in bytes (16 MiB). */
export const SPACE_MARGIN_FLOOR = 16 * 1024 * 1024;

/** The space a backup of a database of this size needs. */
export function estimateRequiredBytes(databaseSize) {
  const size = Number(databaseSize) || 0;
  return Math.ceil(size * SPACE_MARGIN_FACTOR) + SPACE_MARGIN_FLOOR;
}

/**
 * The free space of the file system of a directory.
 *
 * @returns {object} { checked, availableBytes, error }
 */
export function readFreeSpace(directory) {
  try {
    const stats = fs.statfsSync(directory);
    const available = Number(stats.bavail) * Number(stats.bsize);
    return { checked: true, availableBytes: available, error: null };
  } catch (err) {
    return { checked: false, availableBytes: null, error: err.message };
  }
}

/**
 * Check that there is enough space for a backup.
 *
 * When the space cannot be checked the answer says so; it never claims that
 * the space is sufficient.
 *
 * @param {object} options
 * @param {string} options.directory - The destination directory.
 * @param {number} options.requiredBytes - The space the backup needs.
 * @returns {object} { ok, checked, availableBytes, requiredBytes, message }
 */
export function checkDiskSpace(options = {}) {
  const { directory, requiredBytes } = options;
  const space = readFreeSpace(directory);

  if (!space.checked) {
    return {
      ok: true,
      checked: false,
      availableBytes: null,
      requiredBytes,
      message:
        `The free space of ${directory} could not be checked (${space.error}). `
        + 'The backup was attempted anyway; it may fail if the disk is full.',
    };
  }

  const ok = space.availableBytes >= requiredBytes;
  return {
    ok,
    checked: true,
    availableBytes: space.availableBytes,
    requiredBytes,
    message: ok
      ? null
      : `There is not enough space for the backup: ${formatBytes(requiredBytes)} are needed, `
        + `${formatBytes(space.availableBytes)} are free on ${directory}.`,
  };
}

/** A readable size. */
export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return 'an unknown amount';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default {
  SPACE_MARGIN_FACTOR,
  SPACE_MARGIN_FLOOR,
  estimateRequiredBytes,
  readFreeSpace,
  checkDiskSpace,
  formatBytes,
};
