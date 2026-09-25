export const runtime = 'nodejs';
export function GET() {
  return Response.json({ status: 'ok', service: 'wareongo-context', readOnly: true },
    { headers: { 'Cache-Control': 'no-store' } });
}
