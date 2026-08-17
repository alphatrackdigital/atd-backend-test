import type { VercelRequest, VercelResponse } from "@vercel/node";
import { connectDB } from "../../_lib/db";
import { BlogPost } from "../../_lib/models/BlogPost";
import { verifyAdminToken, extractBearerToken } from "../../_lib/jwt";
import { setCorsHeaders } from "../../_lib/http";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();

  const token = extractBearerToken(req.headers["authorization"] as string);
  try {
    if (!token) throw new Error("No token");
    verifyAdminToken(token);
  } catch {
    return res.status(401).json({ ok: false, message: "Unauthorized." });
  }

  const slug = req.query.slug as string;

  try {
    await connectDB();

    // GET /api/blog/admin/:slug
    if (req.method === "GET") {
      const post = await BlogPost.findOne({ slug }).lean();
      if (!post) return res.status(404).json({ ok: false, message: "Post not found." });
      return res.status(200).json({ ok: true, post });
    }

    // PUT /api/blog/admin/:slug
    if (req.method === "PUT") {
      const update: Record<string, unknown> = { ...req.body };

      if (req.body?.status === "published") {
        const existing = await BlogPost.findOne({ slug }).select("publishedAt").lean();
        if (!existing?.publishedAt) update.publishedAt = new Date();
      }

      const post = await BlogPost.findOneAndUpdate({ slug }, { $set: update }, { new: true, runValidators: true });
      if (!post) return res.status(404).json({ ok: false, message: "Post not found." });
      return res.status(200).json({ ok: true, post });
    }

    // DELETE /api/blog/admin/:slug
    if (req.method === "DELETE") {
      const post = await BlogPost.findOneAndDelete({ slug });
      if (!post) return res.status(404).json({ ok: false, message: "Post not found." });
      return res.status(200).json({ ok: true, message: "Post deleted." });
    }

    return res.status(405).json({ ok: false, message: "Method not allowed." });
  } catch (err) {
    console.error("[blog-admin] Error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error." });
  }
}
