import type { VercelRequest, VercelResponse } from "@vercel/node";
import { connectDB } from "../_lib/db";
import { BlogPost } from "../_lib/models/BlogPost";
import { setCorsHeaders } from "../_lib/http";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed." });

  try {
    await connectDB();

    const page = Number(req.query.page ?? 1);
    const limit = Number(req.query.limit ?? 20);
    const category = req.query.category as string | undefined;

    const filter: Record<string, unknown> = { status: "published" };
    if (category) filter.category = category;

    const [posts, total] = await Promise.all([
      BlogPost.find(filter)
        .select("-content")
        .sort({ publishedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      BlogPost.countDocuments(filter),
    ]);

    return res.status(200).json({ ok: true, posts, total, page, limit });
  } catch (err) {
    console.error("[blog] Error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error." });
  }
}
