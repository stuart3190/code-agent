import { featureMatrix } from "../lib/features.mjs";

export async function handleFeatures(req, res, owner) {
  const matrix = await featureMatrix(owner);
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(matrix));
}
