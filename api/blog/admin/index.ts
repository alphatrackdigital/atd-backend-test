import type { VercelRequest, VercelResponse } from "@vercel/node";
import { connectDB } from "../../_lib/db";
import { BlogPost } from "../../_lib/models/BlogPost";
import { verifyAdminToken, extractBearerToken } from "../../_lib/jwt";
import { setCorsHeaders } from "../../_lib/http";

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

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

  try {
    await connectDB();

    // GET /api/blog/admin — list all posts
    if (req.method === "GET") {
      const page = Number(req.query.page ?? 1);
      const limit = Number(req.query.limit ?? 50);
      const status = req.query.status as string | undefined;

      const filter: Record<string, unknown> = {};
      if (status === "draft" || status === "published") filter.status = status;

      const [posts, total] = await Promise.all([
        BlogPost.find(filter)
          .select("-content")
          .sort({ updatedAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        BlogPost.countDocuments(filter),
      ]);

      return res.status(200).json({ ok: true, posts, total, page, limit });
    }

    // POST /api/blog/admin — create new post
    if (req.method === "POST") {
      const { title, excerpt, content, image, category, readTime, author, status } = req.body || {};

      if (!title || !excerpt || !content || !category) {
        return res.status(400).json({ ok: false, message: "title, excerpt, content, and category are required." });
      }

      const generatedSlug = slugify(String(title));
      const publishedAt = status === "published" ? new Date() : null;

      const post = await BlogPost.create({
        title, slug: generatedSlug, excerpt, content,
        image: image || "",
        category,
        readTime: readTime || "5 min read",
        author: author || "Alphatrack Team",
        status: status || "draft",
        publishedAt,
      });

      return res.status(201).json({ ok: true, post });
    }

    return res.status(405).json({ ok: false, message: "Method not allowed." });
  } catch (err) {
    console.error("[blog-admin] Error:", err);
    return res.status(500).json({ ok: false, message: "Internal server error." });
  }
}
