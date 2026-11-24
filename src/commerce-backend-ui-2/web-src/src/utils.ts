/** The IMS credentials the page gets from `useIms()` (the same shape as lib-admin-ui's ImsContext). */
export type Ims = { imsToken: string; imsOrgId: string };

/*
 * How the page finds its actions: Adobe's custom-menu V2 sample calls no action of its own, so V2 has no
 * documented pattern for this. We keep the V1 way: `aio app build` and `aio app dev` write ./config.json
 * next to this file for each extension with a `web:` folder; it maps 'Package/action' to the deployed web
 * action URL. It holds the workspace namespace, so it is gitignored and read lazily here (a clean clone,
 * the typecheck and jest have no such file).
 *
 * Headers: `Authorization: Bearer <imsToken>` and `x-gw-ims-org-id: <imsOrgId>`, the pair the V1 page sent
 * (require-adobe-auth checks the token). It matches V1 but is not yet proven inside a V2 Commerce admin,
 * where the token may come from another IMS client (see actions/allowed-client.js).
 */
function actionUrl(action: string): string {
  const actions = require("./config.json");
  const url = actions[action];
  if (!url) {
    throw new Error(`No URL for ${action} in config.json (run aio app build)`);
  }
  return url;
}

/** POSTs `body` to a web action with the admin's IMS token and org; returns the parsed JSON answer. */
export async function callAction<T = unknown>(ims: Ims, action: string, body: object = {}): Promise<T> {
  const res = await fetch(actionUrl(action), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-gw-ims-org-id": ims.imsOrgId,
      Authorization: `Bearer ${ims.imsToken}`,
    },
    body: JSON.stringify(body),
  });
  // Read the body as text first: a 502 from an action once reached the page as an HTML page (most likely
  // the gateway replaces 5xx bodies), and res.json() then showed "Unexpected token '<'" instead of the status.
  const text = await res.text();
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data ? String(data.error) : "";
    throw new Error(message || `HTTP ${res.status}`);
  }
  if (data === null) {
    throw new Error(`HTTP ${res.status}: response is not JSON`);
  }
  return data as T;
}

/** Newest first by `at` (list-alerts already sorts that way; the page keeps the order whatever it gets). */
export function newestFirst<R extends { at?: string }>(rows: R[]): R[] {
  return [...rows].sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
}
