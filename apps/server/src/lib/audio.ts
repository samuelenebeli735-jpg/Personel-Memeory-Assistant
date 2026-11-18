import path from 'node:path';

/**
 * Audio format helpers for voice capture.
 *
 * Telegram delivers voice notes as OGG/Opus. We only accept formats the
 * configured speech-to-text provider can handle, and reject anything else
 * *before* downloading it: an unsupported file must not be uploaded anywhere.
 */

const SUPPORTED_AUDIO_MIME = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/vnd.wave',
  'audio/webm',
  'audio/flac',
  'audio/x-flac',
]);

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/vnd.wave': '.wav',
  'audio/webm': '.webm',
  'audio/flac': '.flac',
  'audio/x-flac': '.flac',
};

/**
 * Telegram omits `mime_type` in a few edge cases; voice notes are OGG Opus, so
 * a missing value is treated as supported. Anything explicitly unsupported is
 * refused.
 */
export function isSupportedAudioMime(mimeType: string | null | undefined): boolean {
  if (!mimeType) return true;
  return SUPPORTED_AUDIO_MIME.has(mimeType.trim().toLowerCase());
}

/** A safe extension for a retained audio file. Never taken from user input. */
export function audioFileExtension(mimeType: string | null | undefined): string {
  if (!mimeType) return '.ogg';
  return EXTENSION_BY_MIME[mimeType.trim().toLowerCase()] ?? '.ogg';
}

/**
 * Resolves a stored `mediaRef` to a direct child of `audioDir`, or null when the
 * path is unsafe. This is the only path used for deleting retained audio.
 *
 * The boundary is deliberately strict:
 *  - a raw `..` segment is rejected even if it would normalise back inside;
 *  - the resolved path must be inside, not equal to, the configured directory;
 *  - retained audio is written as a direct child, so nested paths are rejected
 *    rather than interpreted as permission to walk a directory tree.
 *
 * This is a lexical boundary. `unlink` removes a symlink entry itself rather
 * than following it to a target, and the configured root is the trusted storage
 * location, so no recursive or target-following operation is performed.
 */
export function resolveRetainedAudioPath(audioDir: string, mediaRef: string): string | null {
  if (!mediaRef || mediaRef.includes('\0')) return null;
  if (mediaRef.split(/[\\/]+/).some((segment) => segment === '..')) return null;

  const root = path.resolve(audioDir);
  const candidate = path.isAbsolute(mediaRef)
    ? path.resolve(mediaRef)
    : path.resolve(process.cwd(), mediaRef);
  const relative = path.relative(root, candidate);

  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  // The retention writer creates one file directly in `audioDir`; do not accept
  // a nested path that could hide a directory or a symlink from this check.
  if (relative.split(/[\\/]/).length !== 1) return null;

  return candidate;
}
