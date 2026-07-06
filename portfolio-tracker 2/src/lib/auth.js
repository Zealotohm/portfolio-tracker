export function isAuthed(request, env) {
  if (!env.APP_PASSWORD) return true; // no password set -> open (not recommended, but don't lock the owner out)
  const header = request.headers.get("x-app-password");
  return header === env.APP_PASSWORD;
}

export function unauthorized() {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
