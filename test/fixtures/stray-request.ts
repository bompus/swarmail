/**
 * A stand-in server answers only JSON-RPC posts. Another process on a developer host probes new loopback listeners
 * with `GET /`; parsing that as JSON throws, and the throw fails whichever test owns the server. Returns the 404 for
 * such a request, or null for a POST.
 */
export const strayRequest = (req: Request) =>
  req.method === "POST" ? null : new Response(null, { status: 404 });
