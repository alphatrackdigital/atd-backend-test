import type { VercelRequest, VercelResponse } from "@vercel/node";
import { connectDB } from "../_lib/db";
import { BlogPost } from "../_lib/models/BlogPost";
import { setCorsHeaders } from "../_lib/http";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed." });

  const slug = req.query.slug as string;

  try {
    await connectDB();

    const post = await BlogPost.findOne({ slug, status: "published" }).lean();
    if (!post) return res.status(404).json({ ok: false, message: "Post not found." });

    return res.status(200).json({ ok: true, post });
  } catch (err) {
    console.error("[blog] Error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error." });
  }
}
