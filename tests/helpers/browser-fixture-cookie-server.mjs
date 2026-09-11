// One-shot loopback helper for manual browser QA. It installs only the fixed
// synthetic fixture workspace cookie, redirects to the local app, then exits.
import { createServer } from "node:http";

const host = "127.0.0.1";
const port = 4179;
const target = "http://127.0.0.1:4178/?scan_id=scan_11111111111111111111111111111111";
const server = createServer((_request, response) => {
  response.writeHead(302, {
    "Cache-Control": "no-store",
    "Set-Cookie": "rd_workspace=ws_browser_live_partial.synthetic-browser-live-results-token; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600",
    Location: target,
  });
  response.end();
  server.close();
});
server.listen(port, host, () => console.log(`Synthetic browser fixture ready at http://${host}:${port}/`));
