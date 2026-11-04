// Vercel Node.js function entry. All paths are rewritten here by vercel.json.
// Requires `npm run build` (vercel.json buildCommand) so ../dist exists.
import { bootstrap } from "../dist/bootstrap.js";

const ready = bootstrap();

export default async function handler(req, res) {
  const { handler: app } = await ready;
  return app(req, res);
}
