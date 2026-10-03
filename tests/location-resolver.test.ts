import { describe, expect, it, vi } from 'vitest';
import { locationInputSchema, locationOutputSchema, parseLocationQuery, resolveLocation } from '../src/lib/location-resolver';

const run = (location: string, fetch = vi.fn<typeof globalThis.fetch>()) => resolveLocation({ location }, new AbortController().signal, { fetch });
const point = (latitude: number, longitude: number) => ({ latitude, longitude });

describe('location input boundary', () => {
  it.each([{}, { latitude: 12 }, { longitude: 77 }, { location: '' }, { location: '   ' }, { location: 'x'.repeat(2049) },
    { latitude: NaN, longitude: 77 }, { latitude: 91, longitude: 77 }, { latitude: 12, longitude: Infinity },
    { latitude: 12, longitude: -181 }, { latitude: '12', longitude: 77 }, { location: '12,77', latitude: 12, longitude: 77 },
    { latitude: 12, longitude: 77, origin: 'whatsapp' }, { latitude: 12, longitude: 77, employeeId: 1 }])('rejects invalid or self-attested input %j', async input => {
    expect(locationInputSchema.safeParse(input).success).toBe(false);
    await expect(resolveLocation(input, new AbortController().signal)).rejects.toMatchObject({ status: 422, code: 'INVALID_LOCATION_INPUT' });
  });
  it.each(['latitude=12&latitude=13&longitude=77', 'location=12%2C77&location=13%2C78', 'lat=12&lng=77',
    'latitude=&longitude=77', 'latitude=NaN&longitude=77', 'latitude=0x10&longitude=77', 'latitude=Infinity&longitude=77',
    'latitude=1e999&longitude=77', 'latitude=12junk&longitude=77', 'latitude=12&longitude=77&location=x',
    'latitude=%2012&longitude=77', 'latitude=12&longitude=77&__proto__=x'])('rejects ambiguous/coercive query %s', query => {
    expect(() => parseLocationQuery(new URLSearchParams(query))).toThrowError(expect.objectContaining({ code: 'INVALID_LOCATION_INPUT' }));
  });
  it('accepts zero, geographic extremes and finite exponent notation with precise provenance', async () => {
    expect(parseLocationQuery(new URLSearchParams('latitude=1.2e1&longitude=77'))).toEqual(point(12, 77));
    for (const coordinates of [point(0, 0), point(-90, -180), point(90, 180)]) {
      const result = await resolveLocation(coordinates, new AbortController().signal);
      expect(result).toMatchObject({ status: 'resolved', candidates: [{ ...coordinates, method: 'supplied_coordinates', requiresConfirmation: false }], source: { kind: 'coordinates', ...coordinates } });
      expect(locationOutputSchema.safeParse(result).success).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/whatsapp|verified|timestamp|employeeId/);
    }
  });
});

describe('coordinate semantics without geocoding', () => {
  it.each([
    ['12.5, 77.25', 12.5, 77.25, 'decimal_pair'], ['12.5 77.25', 12.5, 77.25, 'decimal_pair'], ['(-12.5,+77.25)', -12.5, 77.25, 'decimal_pair'], ['0,0', 0, 0, 'decimal_pair'],
    ['Latitude: 12.5, Longitude: 77.25', 12.5, 77.25, 'decimal_pair'], ['lng=77.25 lat=12.5', 12.5, 77.25, 'decimal_pair'],
    ['latitude 12.9 N longitude 77.6 W', 12.9, -77.6, 'decimal_pair'],
    ['latitude 12.9 north longitude 77.6 west', 12.9, -77.6, 'decimal_pair'],
    ['lat12.5S lng77.25E', -12.5, 77.25, 'decimal_pair'],
    ['Latitude 12°30′N Longitude 77°15′W', 12.5, -77.25, 'dms'],
    ['The pin has latitude 12.5 and longitude 77.25.', 12.5, 77.25, 'decimal_pair'],
    ['12°30\'0"N 77°15\'0"E', 12.5, 77.25, 'dms'], ['77°15′0″W 12°30′0″S', -12.5, -77.25, 'dms'],
    ['12.5°N 77.25°E', 12.5, 77.25, 'dms'], ['12°30\'N 77°15\'E', 12.5, 77.25, 'dms'],
    ['geo:12.5,77.25', 12.5, 77.25, 'geo_uri'], ['geo:12.5,77.25,100', 12.5, 77.25, 'geo_uri'],
    ['geo:0,0?q=12.5,77.25(Synthetic%20site)', 12.5, 77.25, 'geo_uri'],
  ] as const)('extracts explicit coordinates from %s', async (input, latitude, longitude, method) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const result = await run(input, fetch);
    expect(result.status).toBe('resolved'); expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ latitude, longitude, method, requiresConfirmation: false });
    expect(fetch).not.toHaveBeenCalled(); expect(locationOutputSchema.safeParse(result).success).toBe(true);
  });
  it.each(['91,77', '12,181', '12°60\'N 77°0\'E', '12°0\'60"N 77°0\'E', '-12°0\'S 77°0\'E',
    '-0°30′N 77°30′E', 'lat12N lng77N', 'lat-12N lng77E', '(12,77', '12,77)', '1234°N 77°E', '12°N 13°N', 'Warehouse 12, Plot 77', 'Synthetic road, Example City', 'ChIJ_example',
    'geo:0,0?q=Synthetic%20city', 'geo:12,77,1e999', 'geo:12,77;u=-1'])('does not invent a pin from %s', async input => {
    const result = await run(input); expect(result.status).toBe('unresolved'); expect(result.candidates).toEqual([]);
  });
  it('keeps conflicting locations and their order instead of silently choosing one or crossing label pairs', async () => {
    for (const input of ['12,77;13,78', 'lat12 long77 lat13 long78', '12°N 77°E;13°N 78°E', 'geo:12,77?q=13,78']) {
      const result = await run(input); expect(result.status).toBe('ambiguous');
      expect(result.candidates.map(({ latitude, longitude }) => point(latitude, longitude))).toEqual([point(12, 77), point(13, 78)]);
      expect(result.candidates.every(p => p.requiresConfirmation)).toBe(true);
    }
  });
  it('deduplicates repeated identical coordinates and bounds a long conflicting list', async () => {
    expect((await run('12,77;12,77')).status).toBe('resolved');
    const result = await run(Array.from({ length: 12 }, (_, i) => `${i},77`).join(';'));
    expect(result.status).toBe('ambiguous'); expect(result.candidates).toHaveLength(8); expect(result.reason).toContain('eight');
  });
  it.each(['geo:12,77;u=100', 'geo:12,77?q=Synthetic%20city', 'geo:0,0?q=12,77&q=DifferentPlace', 'geo:12,77?q=DifferentPlace&q=12,77'])('requires confirmation of a geo uncertainty/search center %s', async input => {
    expect(await run(input)).toMatchObject({ status: 'ambiguous', candidates: [{ latitude: 12, longitude: 77, requiresConfirmation: true }] });
  });
});

describe('Google Maps URL provenance', () => {
  it.each([
    'https://www.google.com/maps?q=12.5,77.25', 'https://maps.google.com/?q=12.5,77.25',
    'https://www.google.co.in/maps/search/?api=1&query=12.5%2C77.25', 'https://www.google.com/maps/search/12.5,77.25/',
    'https://www.google.com/maps/place/12%C2%B030%270%22N+77%C2%B015%270%22E/',
    'https://www.google.com/maps?q=loc:12.5,77.25(Synthetic)', 'https://www.google.com/maps?q=(12.5,77.25)',
  ])('resolves an explicit map target %s', async location => {
    const result = await run(location); expect(result).toMatchObject({ status: 'resolved', candidates: [{ latitude: 12.5, longitude: 77.25, method: 'google_maps_pin', requiresConfirmation: false }], source: { kind: 'url', input: location } });
  });
  it('uses the actual pin rather than an unrelated @ viewport or ll center', async () => {
    const result = await run('https://www.google.com/maps/place/Synthetic/@15,80,9z/data=!4m5!3m4!3d12.5!4d77.25?ll=16,81');
    expect(result).toMatchObject({ status: 'resolved', candidates: [{ latitude: 12.5, longitude: 77.25, method: 'google_maps_pin' }] });
    expect(result.candidates).toHaveLength(1);
  });
  it.each(['https://www.google.com/maps/@12.5,77.25,15z', 'https://maps.google.com/?ll=12.5,77.25&q=Synthetic%20city',
    'https://www.google.com/maps?center=12.5,77.25'])('marks viewport-only links for confirmation %s', async input => {
    expect(await run(input)).toMatchObject({ status: 'ambiguous', candidates: [{ latitude: 12.5, longitude: 77.25, method: 'google_maps_viewport', requiresConfirmation: true }] });
  });
  it.each(['https://www.google.com/maps/dir/12,77/13,78/@15,80,10z',
    'https://www.google.com/maps/dir/?api=1&destination=12,77', 'https://www.google.com/maps?query=12,77&query=13,78',
    'https://www.google.com/maps?q=12,77&query=13,78', 'https://www.google.com/maps?q=12,77&query_place_id=ChIJ_example',
    'https://www.google.com/maps?q=12,77&cid=12345', 'https://www.google.com/maps?q=12,77&ftid=0x123:0xabc',
    'https://www.google.com/maps?q=12,77&place_id=ChIJ_example', 'https://www.google.com/maps?query=12,77&q=DifferentPlace'])('requires a choice for conflicting/route/place-ID links %s', async input => {
    const result = await run(input); expect(result.status).toBe('ambiguous'); expect(result.candidates.every(p => p.requiresConfirmation)).toBe(true);
  });
  it.each(['https://www.google.com/maps?query=12,77', 'https://www.google.com/maps?api=1&map_action=map&query=12,77'])('does not assert an inactive modern search target %s', async input => {
    expect(await run(input)).toMatchObject({ status: 'ambiguous', candidates: [{ latitude: 12, longitude: 77, requiresConfirmation: true }] });
  });
  it('retains a real pin over inactive query coordinates', async () => {
    const result = await run('https://www.google.com/maps/place/Synthetic/data=!3d12!4d77?query=13,78');
    expect(result).toMatchObject({ status: 'resolved', candidates: [{ latitude: 12, longitude: 77 }] });
    expect(result.candidates).toHaveLength(1);
  });
  it.each(['https://www.google.com/maps?cid=12345', 'https://www.google.com/maps/search/?api=1&query=Synthetic&query_place_id=ChIJ_example',
    'https://www.google.com/maps/place/Synthetic/data=!1s0xabc:0xdef',
    'https://www.google.com/maps/place/Latitude+12+Longitude+77+Cafe',
    'https://www.google.com/maps?q=Latitude+12+Longitude+77+Cafe'])('does not scrape or geocode unresolved identifiers %s', async input => {
    const fetch = vi.fn<typeof globalThis.fetch>(); expect((await run(input, fetch)).status).toBe('unresolved'); expect(fetch).not.toHaveBeenCalled();
  });
});

describe('bounded short-link resolution', () => {
  const short = 'https://maps.app.goo.gl/Synthetic';
  const pin = 'https://www.google.com/maps?q=12.5,77.25';
  it('follows only safe redirects and reads no response bodies', async () => {
    const cancel = vi.fn(); const body = new ReadableStream({ cancel });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(body, { status: 302, headers: { location: 'https://goo.gl/maps/Second', 'content-length': '99999999999' } }))
      .mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: pin } }));
    expect(await run(short, fetch)).toMatchObject({ status: 'resolved', candidates: [{ latitude: 12.5, longitude: 77.25 }], source: { kind: 'url', input: short } });
    expect(fetch).toHaveBeenCalledTimes(2); expect(cancel).toHaveBeenCalledOnce();
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store', method: 'GET' });
      expect(options!.headers).not.toHaveProperty('authorization');
    }
  });
  it.each(['https://127.0.0.1/maps?q=12,77', 'https://[::1]/maps?q=12,77', 'http://www.google.com/maps?q=12,77',
    'https://www.google.com.evil.test/maps?q=12,77', 'https://evil.test/maps?q=12,77', 'https://www.google.com@evil.test/maps?q=12,77',
    'https://user:secret@www.google.com/maps?q=12,77', 'https://www.google.com:444/maps?q=12,77',
    'https://www.google.com/redirect?url=http://localhost', 'https://goo.gl/NotMaps', 'file:///etc/passwd',
    'https://www.google.com\\@evil.test/maps?q=12,77'])('rejects an unsafe initial URL and redirect target %s', async location => {
    const direct = vi.fn<typeof globalThis.fetch>(); expect((await run(location, direct)).status).toBe('unresolved'); expect(direct).not.toHaveBeenCalled();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 302, headers: { location } }));
    expect((await run(short, fetch)).status).toBe('unresolved'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects loops, missing/oversized locations, unexpected auto-follow and HTML-only responses', async () => {
    const responses = [new Response(null, { status: 302, headers: { location: short } }), new Response(null, { status: 302 }),
      new Response(null, { status: 302, headers: { location: pin + '&x=' + 'a'.repeat(2048) } }),
      new Response('<meta http-equiv="refresh" content="0;url=http://localhost">', { status: 200 })];
    const followed = new Response(null, { status: 302, headers: { location: pin } }); Object.defineProperty(followed, 'redirected', { value: true }); responses.push(followed);
    for (const response of responses) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
      expect((await run(short, fetch)).status).toBe('unresolved'); expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it('bounds unique redirect chains before a fifth request', async () => {
    let index = 0; const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 302, headers: { location: `https://maps.app.goo.gl/Next${++index}` } }));
    expect((await run(short, fetch)).status).toBe('unresolved'); expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('handles cancellation before and during resolution and bounds a fetch that ignores abort', async () => {
    const cancelled = new AbortController(); cancelled.abort(); const fetch = vi.fn<typeof globalThis.fetch>();
    expect((await resolveLocation({ location: short }, cancelled.signal, { fetch })).status).toBe('unresolved'); expect(fetch).not.toHaveBeenCalled();
    const hanging = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const timeout = await resolveLocation({ location: short }, new AbortController().signal, { fetch: hanging, timeoutMs: 5 });
    expect(timeout.status).toBe('unresolved'); expect(hanging.mock.calls[0][1]!.signal!.aborted).toBe(true);
    const controller = new AbortController(); const work = resolveLocation({ location: short }, controller.signal, { fetch: hanging }); controller.abort();
    expect((await work).reason).toContain('cancelled');
  });
});
