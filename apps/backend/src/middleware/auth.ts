import type { NextFunction, Request, Response } from "express";
import { verifyAccessToken } from "../lib/auth.js";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  try {
    const auth = String(req.headers.authorization ?? "");
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!token) {
      res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Missing bearer token" } });
      return;
    }

    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch {
    res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Invalid or expired token" } });
  }
}
