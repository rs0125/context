import { describe, expect, it } from 'vitest';
import { warehouseMediaCounts } from '../src/lib/warehouse-qa';

const photo = 'https://assets.example.test/warehouse.jpg';
const video = 'https://assets.example.test/tour.mp4';

describe('warehouse media QA counts', () => {
  it('counts distinct assets and excludes blank, malformed and document entries', () => {
    expect(warehouseMediaCounts({
      images: [photo, ` ${photo} `, 'https://assets.example.test/plan.png', '', null, {}, 1,
        'not-a-url', 'https://assets.example.test/brochure.pdf', video],
      videos: [video, video, 'https://assets.example.test/tour.MOV?token=private', '', null, {}, photo],
      docs: ['https://assets.example.test/brochure.pdf'],
    }, null)).toEqual({ image_count: 2, video_count: 2 });
  });

  it('keeps explicit empty media arrays authoritative over old photos', () => {
    expect(warehouseMediaCounts({ images: [], videos: [] }, `${photo},${video}`))
      .toEqual({ image_count: 0, video_count: 0 });
  });

  it('falls back independently for missing or unsupported media buckets', () => {
    expect(warehouseMediaCounts({ images: [] }, `${photo},${video}`)).toEqual({ image_count: 0, video_count: 1 });
    expect(warehouseMediaCounts({ images: 'unsupported', videos: [] }, `${photo},${video}`)).toEqual({ image_count: 1, video_count: 0 });
  });

  it.each([undefined, null, '', '{malformed', [], 12])('handles legacy photos with media %j', media => {
    const legacy = `${photo}, ${photo}, ${video}, https://assets.example.test/brochure.pdf`;
    expect(warehouseMediaCounts(media, legacy)).toEqual({ image_count: 1, video_count: 1 });
  });

  it('supports JSON-encoded media and legacy photo arrays without counting encodings twice', () => {
    const media = JSON.stringify(JSON.stringify({ images: [photo], videos: [video] }));
    expect(warehouseMediaCounts(media, photo)).toEqual({ image_count: 1, video_count: 1 });
    expect(warehouseMediaCounts(null, JSON.stringify(JSON.stringify([photo, video, photo]))))
      .toEqual({ image_count: 1, video_count: 1 });
  });

  it('uses the explicit bucket for extensionless links and preserves commas within URLs', () => {
    expect(warehouseMediaCounts({ images: ['https://assets.example.test/photo,large'],
      videos: ['https://video.example.test/watch?v=tour'] }, null)).toEqual({ image_count: 1, video_count: 1 });
    expect(warehouseMediaCounts(null, `https://assets.example.test/photo,large, ${video}`))
      .toEqual({ image_count: 1, video_count: 1 });
  });

  it.each([undefined, null, '', 'not-a-url', '{malformed', [null, {}, 12]])('returns zero for absent or unusable photos %j', photos => {
    expect(warehouseMediaCounts(null, photos)).toEqual({ image_count: 0, video_count: 0 });
  });
});
