import type { NextApiRequest, NextApiResponse } from "next";

/** Liveness only. Database readiness is checked by Compose and deployment acceptance. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  return res.status(200).json({ status: "ok" });
}
