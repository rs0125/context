// Match the Dashboard image contract: typed media arrays are authoritative,
// including empty arrays; photos is the fallback for older warehouse records.
const IMAGE_PATH = /\.(?:jpe?g|png|webp|gif|avif|bmp|tiff?|heic|heif|svg)$/i;
const VIDEO_PATH = /\.(?:mp4|mov|avi|mkv|webm|m4v|mpeg|mpg|3gp)$/i;

function decodeJson(value: unknown): unknown {
  for (let index = 0; index < 2 && typeof value === 'string'; index++) {
    try { value = JSON.parse(value); } catch { break; }
  }
  return value;
}

function urls(value: unknown): string[] {
  const decoded = decodeJson(value);
  return (Array.isArray(decoded) ? decoded : [decoded]).flatMap(entry => typeof entry === 'string'
    ? entry.split(/,\s*(?=https?:\/\/)/i).map(url => url.trim()).filter(Boolean) : []);
}

function countAssets(value: unknown, kind: 'image' | 'video', typed: boolean): number {
  return new Set(urls(value).filter(url => {
    if (!/^https?:\/\/[^/\s@?#]+\/.+/i.test(url)) return false;
    const path = url.split(/[?#]/)[0];
    if (kind === 'image') return IMAGE_PATH.test(path) || !/\.[^/.]+$/.test(path);
    // An extensionless URL can be a video when explicitly stored as one.
    // Legacy extensionless photos retain the Dashboard's image interpretation.
    return VIDEO_PATH.test(path) || (typed && !/\.[^/.]+$/.test(path));
  })).size;
}

/** Only counts leave this boundary; source URLs and unrelated media stay private. */
export function warehouseMediaCounts(rawMedia: unknown, photos: unknown) {
  const decoded = decodeJson(rawMedia);
  const media = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown> : {};
  const images = Array.isArray(media.images);
  const videos = Array.isArray(media.videos);
  return {
    image_count: countAssets(images ? media.images : photos, 'image', images),
    video_count: countAssets(videos ? media.videos : photos, 'video', videos),
  };
}
